"use strict";

const crypto = require("node:crypto");
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const { NewMessage } = require("teleproto/events");
const { BotConstructor } = require("../bot-constructor");

const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60;
const DIALOG_LIMIT = 500;
const RUNNER_INTERVAL_MS = 15_000;
const TARGET_SEND_DELAY_MS = 1_000;
const LOGIN_TIMEOUT_MS = 8 * 60_000;
const LOGIN_DATA_MAX_AGE_SECONDS = 10 * 60;
const LOGIN_START_WINDOW_MS = 60 * 60_000;
const MAX_LOGIN_STARTS_PER_HOUR = 5;
const MAX_CREDENTIAL_ATTEMPTS = 5;
const ALBUM_CAPTURE_DELAY_MS = 750;
const EMPTY_SCHEDULE = Object.freeze({
  message: "",
  intervalSeconds: MIN_INTERVAL_SECONDS,
  chatIds: [],
  enabled: false,
  nextRunAt: null,
  lastSentAt: null,
});

function parseInterval(value) {
  const match = String(value).trim().match(/^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) throw new Error("Intervalni soat:daqiqa:soniya formatida yuboring, masalan 00:00:10.");
  const seconds =
    Number(match[1]) * 60 * 60 +
    Number(match[2]) * 60 +
    Number(match[3] || 0);
  if (seconds < MIN_INTERVAL_SECONDS) {
    throw new Error("Eng qisqa interval 10 soniya (00:00:10).");
  }
  if (seconds > MAX_INTERVAL_SECONDS) {
    throw new Error("Interval 30 kundan oshmasin.");
  }
  return seconds;
}

function getDialogKind(dialog) {
  const entity = dialog?.entity;
  if (!entity || entity.left) return null;
  if (dialog.isChannel && entity.broadcast) return "channels";
  if (dialog.isGroup || dialog.isChannel) return "groups";
  return null;
}

function formatInterval(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(rest).padStart(2, "0"),
  ].join(":");
}

function createTelegramClient(session, apiId, apiHash) {
  return new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
  });
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function buildMiniAppUrl(publicApiBaseUrl, botId) {
  if (!publicApiBaseUrl) return null;
  let url;
  try {
    url = new URL(publicApiBaseUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) return null;
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/user-scheduler/app/${botId}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function validateWebAppInitData(initData, botToken, now = Date.now()) {
  if (typeof initData !== "string" || initData.length > 16_384 || !botToken) {
    throw httpError("Telegram Mini App tasdiqlash ma'lumoti yo'q yoki noto'g'ri.", 401);
  }
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw httpError("Telegram Mini App tasdiqlash ma'lumoti noto'g'ri.", 401);
  }
  const authDate = Number(params.get("auth_date"));
  const nowSeconds = Math.floor(now / 1000);
  if (
    !Number.isSafeInteger(authDate) ||
    authDate < nowSeconds - LOGIN_DATA_MAX_AGE_SECONDS ||
    authDate > nowSeconds + 60
  ) {
    throw httpError("Mini App sessiyasi eskirgan. Ilovani qayta oching.", 401);
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest();
  const suppliedHash = Buffer.from(hash, "hex");
  if (
    suppliedHash.length !== expectedHash.length ||
    !crypto.timingSafeEqual(suppliedHash, expectedHash)
  ) {
    throw httpError("Telegram Mini App tasdiqlash ma'lumoti noto'g'ri.", 401);
  }

  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    throw httpError("Telegram foydalanuvchisi ma'lumoti noto'g'ri.", 401);
  }
  if (!Number.isSafeInteger(user?.id)) {
    throw httpError("Telegram foydalanuvchisi ma'lumoti noto'g'ri.", 401);
  }
  return user;
}

function registerUserSchedulerSession(bot, options) {
  const {
    doc,
    Bots,
    encryptSecret,
    decryptSecret,
    publicApiBaseUrl,
  } = options;
  const makeTelegramClient = options.createTelegramClient || createTelegramClient;
  const ownerId = doc.ownerId;
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH || "";
  const miniAppUrl = buildMiniAppUrl(publicApiBaseUrl, doc._id);
  const inputModes = new Map();
  const chatShareRequests = new Map();
  const loginStarts = [];
  let userClient = null;
  let sourceBotPeer = null;
  let chatPickerActive = false;
  let pendingAlbum = null;
  const mtprotoMessageRefs = new Map();
  let mtprotoSourceListenerAttached = false;
  let loginAttempt = null;
  let schedulerTimer = null;
  let sending = false;
  let sendCompletion = null;
  let stopping = false;

  const isOwnerPrivateChat = (ctx) =>
    ctx.chat?.type === "private" && ctx.from?.id === ownerId;

  const getSchedule = () => {
    const { intervalMinutes, ...savedSchedule } = doc.userSchedule || {};
    const savedSeconds =
      savedSchedule.intervalSeconds == null ? NaN : Number(savedSchedule.intervalSeconds);
    const legacyMinutes = intervalMinutes == null ? NaN : Number(intervalMinutes);
    return {
      ...EMPTY_SCHEDULE,
      ...savedSchedule,
      intervalSeconds: Number.isInteger(savedSeconds)
        ? savedSeconds
        : Number.isInteger(legacyMinutes)
          ? legacyMinutes * 60
          : MIN_INTERVAL_SECONDS,
      chatIds: Array.isArray(savedSchedule.chatIds) ? savedSchedule.chatIds : [],
    };
  };

  async function saveSchedule(changes) {
    const userSchedule = { ...getSchedule(), ...changes };
    const result = await Bots.updateOne(
      { _id: doc._id, ownerId },
      { $set: { userSchedule } },
    );
    if (result?.matchedCount !== 1) {
      throw new Error("User Bot bazada topilmadi yoki jadval saqlanmadi.");
    }
    doc.userSchedule = userSchedule;
    return userSchedule;
  }

  async function notifyOwner(text, extra = {}) {
    try {
      await bot.sendMessage(ownerId, text, extra);
    } catch (error) {
      console.error(`User scheduler ${doc._id} egasiga xabar yuborilmadi:`, error.message);
    }
  }

  function panelKeyboard() {
    return {
      inline_keyboard: [
        [userClient
          ? {
              text: `Akkaunt: ${doc.userAccount?.username ? `@${doc.userAccount.username}` : "ulangan"}`,
              callback_data: "userbot:account",
              style: "primary",
            }
          : {
              text: "Akkauntni Mini App orqali ulash",
              ...(miniAppUrl
                ? { web_app: { url: miniAppUrl } }
                : { callback_data: "userbot:connect" }),
              style: "primary",
            }],
        [
          { text: "Chatlarni tanlash", callback_data: "userbot:chats", style: "primary" },
          { text: "Xabarni tanlash", callback_data: "userbot:message", style: "primary" },
        ],
        [
          { text: "Interval", callback_data: "userbot:interval", style: "primary" },
          { text: "Jadval", callback_data: "userbot:preview", style: "primary" },
        ],
        [{
          text: "Ko'rib chiqish va boshlash",
          callback_data: "userbot:preview",
          style: "success",
        }],
        [
          { text: "To'xtatish", callback_data: "userbot:stop", style: "danger" },
          ...(doc.userSessionEncrypted
            ? [{ text: "Akkauntni uzish", callback_data: "userbot:unlink", style: "danger" }]
            : [{ text: "Yangilash", callback_data: "userbot:panel", style: "danger" }]),
        ],
      ],
    };
  }

  async function showPanel(ctx, edit = false, extraText = "") {
    const schedule = getSchedule();
    const account = userClient
      ? `Ulangan: ${doc.userAccount?.username ? `@${doc.userAccount.username}` : "Telegram akkaunt"}`
      : doc.userSessionEncrypted
        ? "Akkaunt sessiyasi ulanmagan — qayta ulash kerak."
        : "Telegram akkaunt ulanmagan.";
    const nextRun = schedule.nextRunAt
      ? new Date(schedule.nextRunAt).toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" })
      : "Belgilanmagan";
    const messageText = isValidMessageRef(schedule.messageRef)
        ? `${schedule.messageRef.description || "Telegram xabari"}${schedule.messageRef.forwarded ? " · forward" : ""}`
        : schedule.message
          ? schedule.message.slice(0, 250)
          : "Belgilanmagan";
    const text =
      `USER BOT — BOSHQARUV PANELI\n\n` +
      `Akkaunt: ${account.replace(/^Ulangan:\s*/, "").replace(/^Akkaunt sessiyasi/, "Sessiya")}\n` +
      `Tanlangan chatlar: ${schedule.chatIds.length}\n` +
      `Interval: ${formatInterval(Number(schedule.intervalSeconds) || MIN_INTERVAL_SECONDS)}\n` +
      `Jadval: ${schedule.enabled ? "Faol" : "To'xtatilgan"}\n` +
      `Keyingi yuborish: ${nextRun}\n` +
      `Xabar turi: ${messageText}\n\n` +
      (schedule.enabled
        ? "Jadval faol. Yangi xabar yuborishlar belgilangan intervalda davom etadi."
        : "Jadval to'xtatilgan. Yangi yuborishlar bajarilmaydi.") +
      (extraText ? `\n\n${extraText}` : "") +
      `\n\nHar bir foydalanuvchi faqat o'z Telegram akkaunti va jadvalini boshqaradi. ` +
      `Eng qisqa interval: 00:00:10.`;
    const markup = panelKeyboard();
    if (edit && typeof ctx.edit === "function") {
      await ctx.edit(text, { reply_markup: markup });
    } else {
      await ctx.reply(text, { reply_markup: markup });
    }
  }

  async function availableTargets(kind, client = userClient) {
    if (!client) return [];
    const dialogs = await client.getDialogs({ limit: DIALOG_LIMIT });
    const targets = [];
    for (const dialog of dialogs) {
      const dialogKind = getDialogKind(dialog);
      if (!dialogKind || (kind && dialogKind !== kind)) continue;
      const peerId = await client.getPeerId(dialog.entity, true);
      targets.push({
        peerId: String(peerId),
        title: dialog.title || dialog.entity.title || "Nomsiz chat",
        kind: dialogKind,
        dialog,
      });
    }
    return targets;
  }

  async function resolveTarget(peerId) {
    const entity = await userClient.getEntity(peerId);
    if (!entity || entity.left || entity.kicked) return null;
    const kind = entity.broadcast
      ? "channels"
      : entity.megagroup || entity.className === "Chat"
        ? "groups"
        : null;
    if (!kind) return null;
    const resolvedPeerId = String(await userClient.getPeerId(entity, true));
    return {
      peerId: resolvedPeerId,
      title: entity.title || "Nomsiz chat",
      kind,
      dialog: {
        entity,
        title: entity.title,
        isGroup: kind === "groups" && entity.className === "Chat",
        isChannel: entity.className === "Channel",
      },
    };
  }

  async function resolveSelectedTargets(selectedIds) {
    const targets = await availableTargets();
    const byId = new Map(targets.map((target) => [target.peerId, target]));
    const resolved = [];
    for (const id of selectedIds) {
      let target = byId.get(id);
      if (!target) target = await resolveTarget(id);
      if (target) resolved.push(target);
    }
    return resolved;
  }

  function clearChatShareRequests() {
    for (const request of chatShareRequests.values()) clearTimeout(request.timer);
    chatShareRequests.clear();
  }

  function makeChatShareButton(kind) {
    let requestId;
    do {
      requestId = crypto.randomInt(1, 0x7fffffff);
    } while (chatShareRequests.has(requestId));
    const timer = setTimeout(() => chatShareRequests.delete(requestId), 10 * 60_000);
    timer.unref?.();
    chatShareRequests.set(requestId, { kind, timer });
    return {
      text: kind === "groups" ? "👥 Guruh tanlash" : "📢 Kanal tanlash",
      request_chat: {
        request_id: requestId,
        chat_is_channel: kind === "channels",
        request_title: true,
        request_username: true,
      },
    };
  }

  function chatPickerKeyboard() {
    clearChatShareRequests();
    return {
      keyboard: [
        [makeChatShareButton("groups"), makeChatShareButton("channels")],
        [{ text: "✅ Tanlov tugadi" }, { text: "Bekor qilish" }],
      ],
      resize_keyboard: true,
      input_field_placeholder: "Guruh yoki kanalni tanlang",
    };
  }

  function isValidMessageRef(messageRef) {
    return (
      Array.isArray(messageRef?.messageIds) &&
      messageRef.messageIds.length > 0 &&
      messageRef.messageIds.every((id) => Number.isSafeInteger(id) && id > 0) &&
      (messageRef.mtprotoMessageIds == null ||
        (
          Array.isArray(messageRef.mtprotoMessageIds) &&
          messageRef.mtprotoMessageIds.length === messageRef.messageIds.length &&
          messageRef.mtprotoMessageIds.every((id) => Number.isSafeInteger(id) && id > 0)
        )) &&
      typeof messageRef.forwarded === "boolean"
    );
  }

  function hasScheduleMessage(schedule) {
    return isValidMessageRef(schedule.messageRef) ||
      (typeof schedule.message === "string" && Boolean(schedule.message.trim()));
  }

  function describeTelegramMessage(message) {
    if (message.text) return "matn";
    if (message.photo) return "rasm";
    if (message.video) return "video";
    if (message.animation) return "animatsiya";
    if (message.document) return "fayl";
    if (message.audio) return "audio";
    if (message.voice) return "ovozli xabar";
    if (message.video_note) return "video xabar";
    if (message.sticker) return "stiker";
    if (message.location) return "joylashuv";
    if (message.venue) return "joy";
    if (message.contact) return "kontakt";
    if (message.poll) return "so'rovnoma";
    return "xabar";
  }

  function isForwardedFromAnotherUser(message) {
    const origin = message.forward_origin;
    const fromUserId = origin?.type === "user"
      ? origin.sender_user?.id
      : message.forward_from?.id;
    const hasForwardOrigin = Boolean(
      origin ||
      message.forward_from ||
      message.forward_from_chat ||
      message.forward_sender_name ||
      message.forward_date,
    );
    return hasForwardOrigin && String(fromUserId || "") !== String(ownerId);
  }

  async function getSourceBotPeer() {
    if (!sourceBotPeer) {
      if (!userClient || !doc.username) {
        throw new Error("User Bot suhbatini Telegram akkauntingizdan topib bo'lmadi.");
      }
      sourceBotPeer = await userClient.getEntity(String(doc.username).replace(/^@/, ""));
      attachMtprotoSourceListener();
    }
    return sourceBotPeer;
  }

  function attachMtprotoSourceListener() {
    if (!userClient || mtprotoSourceListenerAttached || typeof userClient.addEventHandler !== "function") return;
    mtprotoSourceListenerAttached = true;
    userClient.addEventHandler((event) => {
      try {
        const message = event?.message;
        if (!message?.out || !Number.isSafeInteger(message.id) || message.id < 1) return;
        if (typeof event.isPrivate === "boolean" && !event.isPrivate) return;
        const text = typeof message.text === "string"
          ? message.text
          : typeof message.message === "string"
            ? message.message
            : typeof message.caption === "string"
              ? message.caption
              : "";
        const description = text
          ? "matn"
          : message.photo
            ? "rasm"
            : message.video
              ? "video"
              : message.document
                ? "fayl"
                : "xabar";
        const signature = `${description}:${text.slice(0, 512)}`;
        const refs = mtprotoMessageRefs.get(signature) || [];
        refs.push({ id: message.id, timestamp: Date.now() });
        while (refs.length > 20) refs.shift();
        mtprotoMessageRefs.set(signature, refs);
        const mtprotoIdKey = `id:${message.id}`;
        mtprotoMessageRefs.set(mtprotoIdKey, [{ id: message.id, timestamp: Date.now() }]);
      } catch (error) {
        console.error(`User scheduler ${doc._id} MTProto xabarini kuzatib bo'lmadi:`, error.message);
      }
    }, new NewMessage({ outgoing: true }));
  }

  function findMtprotoMessageId(message) {
    const text = typeof message.text === "string"
      ? message.text
      : typeof message.caption === "string"
        ? message.caption
        : "";
    const description = describeTelegramMessage(message);
    const signature = `${description}:${text.slice(0, 512)}`;
    const exactRefs = mtprotoMessageRefs.get(signature);
    if (exactRefs?.length) {
      const latest = exactRefs[exactRefs.length - 1];
      if (Date.now() - latest.timestamp <= 10 * 60_000) return latest.id;
    }
    const sameTypeRefs = [...mtprotoMessageRefs.entries()]
      .filter(([key]) => key.startsWith(`${description}:`))
      .flatMap(([, refs]) => refs)
      .filter((ref) => Date.now() - ref.timestamp <= 10 * 60_000)
      .sort((left, right) => right.timestamp - left.timestamp);
    return sameTypeRefs[0]?.id || null;
  }

  async function sendScheduledMessage(target, schedule) {
    if (!isValidMessageRef(schedule.messageRef)) {
      return userClient.sendMessage(target, { message: schedule.message });
    }
    if (
      schedule.messageRef.description === "matn" &&
      typeof schedule.messageRef.text === "string" &&
      schedule.messageRef.text
    ) {
      if (schedule.messageRef.forwarded) {
        const sourcePeer = await getSourceBotPeer();
        const mtprotoIds = schedule.messageRef.mtprotoMessageIds;
        if (mtprotoIds?.length) {
          try {
            await userClient.forwardMessages(target, {
              messages: mtprotoIds,
              fromPeer: sourcePeer,
            });
            return;
          } catch (error) {
            console.error(
              `User scheduler ${doc._id} forward manbasini yubora olmadi:`,
              error?.message || error?.errorMessage || error?.name,
            );
          }
        }
      }
      await userClient.sendMessage(target, { message: schedule.messageRef.text });
      return;
    }
    const sourcePeer = await getSourceBotPeer();
    const mtprotoIds = schedule.messageRef.mtprotoMessageIds;
    const messageIds = mtprotoIds
      ? mtprotoIds
      : schedule.messageRef.messageIds;
    if (typeof userClient.getMessages === "function") {
      let sourceMessages;
      try {
        sourceMessages = await userClient.getMessages(sourcePeer, {
          ids: messageIds,
        });
      } catch (error) {
        console.error(
          `User scheduler ${doc._id} manba xabarini tekshira olmadi:`,
          error?.message || error?.errorMessage || error?.name,
        );
        if (typeof schedule.messageRef.text === "string" && schedule.messageRef.text) {
          await userClient.sendMessage(target, { message: schedule.messageRef.text });
          return;
        }
        throw error;
      }
      const validIds = sourceMessages
        .filter((message) => message && Number.isSafeInteger(message.id))
        .map((message) => message.id);
      if (!validIds.length) {
        if (schedule.messageRef.text) {
          await userClient.sendMessage(target, { message: schedule.messageRef.text });
          return;
        }
        throw new Error(
          "Telegram botdagi manba xabari topilmadi. Xabarni qayta yuborib, jadvalni yangilang.",
        );
      }
      for (let index = 0; index < messageIds.length; index++) {
        if (!validIds.includes(messageIds[index])) {
          if (schedule.messageRef.text) {
            await userClient.sendMessage(target, { message: schedule.messageRef.text });
            return;
          }
          throw new Error(
            "Telegram botdagi manba xabarlardan biri mavjud emas. Xabarni qayta yuboring.",
          );
        }
      }
    }
    const params = {
      messages: messageIds,
      fromPeer: sourcePeer,
    };
    const sent = schedule.messageRef.forwarded
      ? await userClient.forwardMessages(target, params)
      : await userClient.copyMessages(target, params);
    if (
      !Array.isArray(sent) ||
      sent.length !== schedule.messageRef.messageIds.length ||
      sent.some((message) => !message)
    ) {
      throw new Error("Telegram barcha tanlangan xabarlarni yuborganini tasdiqlamadi.");
    }
  }

  async function handleSharedChat(ctx, shared) {
    const requestId = Number(shared.request_id);
    const request = chatShareRequests.get(requestId);
    if (!request) {
      await ctx.reply("Chat tanlash so'rovi eskirgan. Paneldan qayta tanlang.", {
        reply_markup: { remove_keyboard: true },
      });
      chatPickerActive = false;
      return;
    }
    clearChatShareRequests();
    if (!userClient) {
      chatPickerActive = false;
      await ctx.reply("Avval shaxsiy Telegram akkauntingizni ulang.", {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }

    let target;
    try {
      const targets = await availableTargets(request.kind);
      target = targets.find((item) => item.peerId === String(shared.chat_id));
    } catch (error) {
      console.error(`User scheduler ${doc._id} chatlar ro'yxatini ololmadi:`, error.message);
      await ctx.reply("Chatlar ro'yxatini olish muvaffaqiyatsiz tugadi. Qayta urinib ko'ring.", {
        reply_markup: chatPickerKeyboard(),
      });
      return;
    }
    if (!target) {
      try {
        target = await resolveTarget(shared.chat_id);
        if (target?.kind !== request.kind) target = null;
      } catch (error) {
        console.error(`User scheduler ${doc._id} tanlangan chatni aniqlay olmadi:`, error.message);
      }
    }
    if (!target) {
      await ctx.reply("Tanlangan chat akkauntingiz ro'yxatidan topilmadi.", {
        reply_markup: chatPickerKeyboard(),
      });
      return;
    }

    const selected = new Set(getSchedule().chatIds);
    const wasSelected = selected.has(target.peerId);
    if (wasSelected) selected.delete(target.peerId);
    else selected.add(target.peerId);
    try {
      await saveSchedule({
        chatIds: [...selected],
        enabled: false,
        nextRunAt: null,
      });
    } catch (error) {
      console.error(`User scheduler ${doc._id} tanlangan chatni saqlay olmadi:`, error.message);
      await ctx.reply("Tanlangan chat jadvalga saqlanmadi. Qaytadan urinib ko'ring.", {
        reply_markup: chatPickerKeyboard(),
      });
      return;
    }
    stopScheduler();
    await ctx.reply(
      `${wasSelected ? "Chat ro'yxatdan chiqarildi" : "Chat jadvalga qo'shildi"}: ${shared.title || target.title}`,
      { reply_markup: chatPickerKeyboard() },
    );
  }

  async function promptChatSelection(ctx) {
    if (!userClient) {
      await ctx.reply("Avval shaxsiy Telegram akkauntingizni ulang.", {
        reply_markup: panelKeyboard(),
      });
      return;
    }
    chatPickerActive = true;
    await ctx.reply(
      "Guruh yoki kanal tugmasini bosing. Telegram ro'yxatidan chatni tanlasangiz, u User Bot jadvaliga qo'shiladi; tanlangan chatni yana tanlash uni olib tashlaydi.",
      { reply_markup: chatPickerKeyboard() },
    );
  }

  function stopScheduler() {
    if (schedulerTimer) clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }

  async function waitForSend() {
    if (sendCompletion) await sendCompletion;
  }

  async function runDueSchedule() {
    if (sending || !userClient) return;
    const schedule = getSchedule();
    const dueAt = schedule.nextRunAt ? new Date(schedule.nextRunAt).getTime() : NaN;
    if (!schedule.enabled || !Number.isFinite(dueAt) || dueAt > Date.now()) return;

    sending = true;
    let completeSend;
    sendCompletion = new Promise((resolve) => {
      completeSend = resolve;
    });
    try {
      const intervalSeconds = Number(schedule.intervalSeconds);
      if (
        !Number.isInteger(intervalSeconds) ||
        intervalSeconds < MIN_INTERVAL_SECONDS ||
        intervalSeconds > MAX_INTERVAL_SECONDS
      ) {
        await saveSchedule({ enabled: false, nextRunAt: null });
        stopScheduler();
        await notifyOwner("Jadval xavfsiz interval tekshiruvidan o'tmadi va to'xtatildi.");
        return;
      }
      if (
        !hasScheduleMessage(schedule) ||
        (typeof schedule.message === "string" && schedule.message.length > 4096)
      ) {
        await saveSchedule({ enabled: false, nextRunAt: null });
        stopScheduler();
        await notifyOwner("Takrorlanadigan xabar noto'g'ri bo'lgani uchun jadval to'xtatildi.");
        return;
      }

      await saveSchedule({
        nextRunAt: new Date(Date.now() + intervalSeconds * 1_000),
      });

      const selectedIds = getSchedule().chatIds;
      const targets = await resolveSelectedTargets(selectedIds);
      const resolvedIds = new Set(targets.map((target) => target.peerId));
      const removedIds = selectedIds.filter((id) => !resolvedIds.has(id));
      if (removedIds.length) {
        await saveSchedule({
          chatIds: targets.map((target) => target.peerId),
          enabled: targets.length > 0,
          nextRunAt: targets.length ? getSchedule().nextRunAt : null,
        });
        await notifyOwner(
          targets.length
            ? "Akkauntingizda mavjud bo'lmagan chatlar jadvaldan olib tashlandi."
            : "Tanlangan chatlar akkauntingizda mavjud emas. Jadval to'xtatildi.",
        );
      }
      if (!targets.length) {
        await saveSchedule({ enabled: false, nextRunAt: null });
        stopScheduler();
        await notifyOwner("Yuborish uchun mavjud chat qolmadi; jadval to'xtatildi.");
        return;
      }

      let sent = 0;
      let failed = 0;
      for (let index = 0; index < targets.length; index++) {
        if (!getSchedule().enabled) break;
        if (index > 0) {
          await new Promise((resolve) => setTimeout(resolve, TARGET_SEND_DELAY_MS));
          if (!getSchedule().enabled) break;
        }
        const target = targets[index];
        try {
          await sendScheduledMessage(target.dialog, schedule);
          sent++;
        } catch (error) {
          failed++;
          const detail = error?.errorMessage || error?.description || error?.message || error?.name || "Noma'lum xato";
          console.error(
            `User scheduler ${doc._id} ${target.peerId} chatiga yubora olmadi: ${detail}`,
          );
        }
      }
      await saveSchedule({
        lastSentAt: new Date(),
        lastResult: { sent, failed },
      });
      if (failed > 0) {
        await notifyOwner(
          `${failed} ta chatga rejalashtirilgan xabar yuborilmadi. ` +
            "Chatga yozish huquqini, Telegram sessiyasini va manzilni tekshiring; " +
            "muammo davom etsa xabarni qayta yuboring.",
        );
      }
    } catch (error) {
      console.error(`User scheduler ${doc._id} jadval xatosi:`, error.message);
      await notifyOwner("Rejalashtirilgan yuborishda xatolik yuz berdi. /start orqali holatni tekshiring.");
    } finally {
      sending = false;
      sendCompletion = null;
      completeSend();
    }
  }

  function scheduleNextRun() {
    if (stopping || !userClient || !getSchedule().enabled) return;
    const nextRunAt = getSchedule().nextRunAt;
    const dueAt = nextRunAt ? new Date(nextRunAt).getTime() : NaN;
    const delay = sending || !Number.isFinite(dueAt)
      ? RUNNER_INTERVAL_MS
      : Math.max(1_000, Math.min(RUNNER_INTERVAL_MS, dueAt - Date.now()));
    schedulerTimer = setTimeout(() => {
      schedulerTimer = null;
      runSchedulerCheck();
    }, delay);
    schedulerTimer.unref?.();
  }

  function runSchedulerCheck() {
    runDueSchedule()
      .catch((error) => {
        console.error(`User scheduler ${doc._id} ishga tushmadi:`, error.message);
      })
      .finally(scheduleNextRun);
  }

  function startScheduler() {
    stopScheduler();
    if (stopping || !userClient || !getSchedule().enabled) return;
    runSchedulerCheck();
  }

  function getLoginStatus() {
    if (!loginAttempt) {
      return userClient
        ? { phase: "connected", message: "Telegram akkaunt ulangan." }
        : { phase: "idle", message: "Ulashga tayyor." };
    }
    return {
      phase: loginAttempt.phase,
      message: loginAttempt.message,
      deliveryType: loginAttempt.deliveryType,
      codeLength: loginAttempt.codeLength,
      passwordHint: loginAttempt.passwordHint,
      emailPattern: loginAttempt.emailPattern,
    };
  }

  function waitForLoginInput(attempt, phase, message, details = {}) {
    if (attempt.closed) throw new Error("Login jarayoni yopildi.");
    attempt.phase = phase;
    attempt.message = attempt.failureMessage || message;
    attempt.failureMessage = "";
    attempt.passwordHint = details.passwordHint || "";
    attempt.emailPattern = details.emailPattern || "";
    attempt.deliveryType = details.deliveryType || "";
    attempt.codeLength = details.codeLength || 0;
    return new Promise((resolve, reject) => {
      attempt.waiter = { phase, resolve, reject };
    });
  }

  function scheduleLoginAttemptCleanup(attempt) {
    clearTimeout(attempt.cleanupTimer);
    attempt.cleanupTimer = setTimeout(() => {
      if (loginAttempt === attempt) loginAttempt = null;
    }, 60_000);
    attempt.cleanupTimer.unref?.();
  }

  async function closeLoginAttempt(attempt, phase, message) {
    if (attempt.closed) return;
    attempt.closed = true;
    clearTimeout(attempt.timeout);
    if (attempt.waiter) {
      attempt.waiter.reject(new Error(message));
      attempt.waiter = null;
    }
    attempt.phase = phase;
    attempt.message = message;
    if (phase !== "success") {
      try {
        await attempt.client.disconnect();
      } catch (error) {
        console.error(`User scheduler ${doc._id} login ulanishi yopilmadi:`, error.name);
      }
    }
    scheduleLoginAttemptCleanup(attempt);
  }

  async function cancelMiniAppLogin() {
    if (loginAttempt?.completing) {
      await loginAttempt.completion;
      return false;
    }
    if (
      !loginAttempt ||
      ["success", "error", "cancelled"].includes(loginAttempt.phase)
    ) {
      return false;
    }
    await closeLoginAttempt(loginAttempt, "cancelled", "Akkaunt ulash bekor qilindi.");
    return true;
  }

  function authErrorMessage(error) {
    const code = error?.errorMessage || error?.code || "";
    if (code === "PHONE_NUMBER_INVALID") return "Telefon raqami noto'g'ri formatda.";
    if (code === "PHONE_NUMBER_BANNED") return "Telegram bu akkauntga login kod yuborishni rad etdi.";
    if (code === "PHONE_CODE_EXPIRED") return "Login kodi eskirdi. Yangi urinish boshlang.";
    if (code === "PHONE_NUMBER_FLOOD" || code === "FLOOD_WAIT") {
      return "Telegram login urinishlarini vaqtincha chekladi. Keyinroq qayta urinib ko'ring.";
    }
    return "Telegram akkauntni ulash amalga oshmadi. Qaytadan urinib ko'ring.";
  }

  async function finishMiniAppLogin(attempt, me) {
    if (attempt.closed) {
      try {
        await attempt.client.logOut();
      } catch (error) {
        console.error(`User scheduler ${doc._id} bekor qilingan sessiyani bekor qila olmadi:`, error.name);
      }
      return;
    }
    attempt.completing = true;
    clearTimeout(attempt.timeout);
    try {
      const encryptedSession = encryptSecret(attempt.client.session.save());
      const userAccount = { id: String(me.id), username: me.username || "" };
      const result = await Bots.updateOne(
        { _id: doc._id, ownerId },
        { $set: { userSessionEncrypted: encryptedSession, userAccount } },
      );
      if (result.matchedCount !== 1) {
        throw new Error("User Bot bazada topilmadi.");
      }
      userClient = attempt.client;
      sourceBotPeer = null;
      attachMtprotoSourceListener();
      doc.userSessionEncrypted = encryptedSession;
      doc.userAccount = userAccount;
      attempt.phase = "success";
      attempt.message = "Akkaunt xavfsiz ulandi. Mini App’ni yopib, bot panelidan davom eting.";
      attempt.closed = true;
      startScheduler();
      scheduleLoginAttemptCleanup(attempt);
    } catch (error) {
      attempt.completing = false;
      attempt.failureMessage = "Sessiyani saqlab bo'lmadi. Ulanish bekor qilindi.";
      console.error(`User scheduler ${doc._id} sessiyasini saqlay olmadi:`, error.name);
      await closeLoginAttempt(attempt, "error", attempt.failureMessage);
    }
  }

  async function failMiniAppLogin(attempt, error) {
    if (attempt.closed) return;
    const message = attempt.failureMessage || authErrorMessage(error);
    console.error(`User scheduler ${doc._id} login xatosi:`, error?.name || "Error");
    await closeLoginAttempt(attempt, "error", message);
  }

  function checkLoginRateLimit() {
    const now = Date.now();
    while (loginStarts.length && loginStarts[0] < now - LOGIN_START_WINDOW_MS) {
      loginStarts.shift();
    }
    if (loginStarts.length >= MAX_LOGIN_STARTS_PER_HOUR) {
      throw httpError("Login urinishlari ko'p. Birozdan keyin qayta urinib ko'ring.", 429);
    }
    if (loginStarts.length && now - loginStarts[loginStarts.length - 1] < 20_000) {
      throw httpError("Yangi kod so'rashdan oldin biroz kuting.", 429);
    }
    loginStarts.push(now);
  }

  async function beginMiniAppLogin(phoneNumber) {
    if (!Number.isSafeInteger(apiId) || apiId < 1 || !apiHash) {
      throw httpError("Serverda TELEGRAM_API_ID va TELEGRAM_API_HASH sozlanmagan.", 503);
    }
    if (userClient) throw httpError("Telegram akkaunt allaqachon ulangan.", 409);
    if (loginAttempt && !["error", "cancelled"].includes(loginAttempt.phase)) {
      throw httpError("Login jarayoni allaqachon ketmoqda.", 409);
    }
    checkLoginRateLimit();
    if (loginAttempt) {
      clearTimeout(loginAttempt.cleanupTimer);
      loginAttempt = null;
    }
    stopScheduler();
    await waitForSend();

    const attempt = {
      client: makeTelegramClient("", apiId, apiHash),
      phase: "connecting",
      message: "Telegram serveriga ulanmoqda...",
      waiter: null,
      closed: false,
      completing: false,
      failureMessage: "",
      credentialAttempts: { code: 0, password: 0, email: 0, emailCode: 0 },
      timeout: null,
      cleanupTimer: null,
      completion: null,
      expiresAt: Date.now() + LOGIN_TIMEOUT_MS,
    };
    loginAttempt = attempt;
    attempt.timeout = setTimeout(() => {
      void closeLoginAttempt(attempt, "error", "Login vaqti tugadi. Qaytadan urinib ko'ring.");
    }, LOGIN_TIMEOUT_MS);
    attempt.timeout.unref?.();

    try {
      await attempt.client.connect();
    } catch (error) {
      await closeLoginAttempt(attempt, "error", "Telegram serveriga ulanish muvaffaqiyatsiz tugadi.");
      throw httpError("Telegram serveriga ulanish muvaffaqiyatsiz tugadi.", 502);
    }

    try {
      const authPromise = attempt.client.signInUser(
        { apiId, apiHash },
        {
          phoneNumber,
          phoneCode: (isCodeViaApp, info) =>
            waitForLoginInput(
              attempt,
              "code",
              "Telegram yuborgan login kodini kiriting.",
              {
                deliveryType: isCodeViaApp ? "app" : "sms",
                codeLength: info?.length,
              },
            ),
          password: (hint) =>
            waitForLoginInput(
              attempt,
              "password",
              "Telegram 2FA parolini kiriting.",
              { passwordHint: hint },
            ),
          emailAddress: () =>
            waitForLoginInput(attempt, "email", "Telegram login uchun email manzil so'radi."),
          emailVerification: (emailOptions) =>
            waitForLoginInput(
              attempt,
              "email-code",
              "Emailga kelgan Telegram tasdiqlash kodini kiriting.",
              { emailPattern: emailOptions.emailPattern },
            ),
          onError: (error) => {
            const code = error?.errorMessage || "";
            if (code === "PHONE_CODE_INVALID") {
              attempt.failureMessage = "Login kodi noto'g'ri. Qaytadan kiriting.";
              return false;
            }
            if (code === "PASSWORD_HASH_INVALID") {
              attempt.failureMessage = "2FA paroli noto'g'ri. Qaytadan kiriting.";
              return false;
            }
            if (code === "EMAIL_CODE_INVALID") {
              attempt.failureMessage = "Email kodi noto'g'ri. Qaytadan kiriting.";
              return false;
            }
            attempt.failureMessage = authErrorMessage(error);
            return true;
          },
        },
      );
      authPromise.then(
        (me) => {
          attempt.completion = finishMiniAppLogin(attempt, me);
          return attempt.completion;
        },
        (error) => failMiniAppLogin(attempt, error),
      );
    } catch (error) {
      await failMiniAppLogin(attempt, error);
    }
    return getLoginStatus();
  }

  async function submitMiniAppCredential(phase, value) {
    const attempt = loginAttempt;
    if (!attempt || attempt.closed || attempt.phase !== phase || attempt.waiter?.phase !== phase) {
      throw httpError("Bu bosqichda kiritish qabul qilinmaydi. Holatni yangilang.", 409);
    }
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      (phase !== "password" && !value.trim()) ||
      value.length > 512
    ) {
      throw httpError("Kiritilgan qiymat noto'g'ri.", 400);
    }
    const submittedValue = phase === "password" ? value : value.trim();
    const attemptKey = phase === "email-code" ? "emailCode" : phase;
    if (attempt.credentialAttempts[attemptKey] >= MAX_CREDENTIAL_ATTEMPTS) {
      await closeLoginAttempt(attempt, "error", "Urinishlar limiti tugadi. Keyinroq urinib ko'ring.");
      throw httpError("Urinishlar limiti tugadi. Keyinroq urinib ko'ring.", 429);
    }
    if (phase === "code" && !/^\d{3,12}$/.test(submittedValue)) {
      throw httpError("Login kodi faqat raqamlardan iborat bo'lishi kerak.", 400);
    }
    if (phase === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submittedValue)) {
      throw httpError("Email manzil noto'g'ri formatda.", 400);
    }
    if (phase === "email-code" && !/^\d{3,12}$/.test(submittedValue)) {
      throw httpError("Email kodi faqat raqamlardan iborat bo'lishi kerak.", 400);
    }

    const waiter = attempt.waiter;
    attempt.waiter = null;
    attempt.credentialAttempts[attemptKey]++;
    attempt.phase = "processing";
    attempt.message = "Tasdiqlanmoqda...";
    waiter.resolve(submittedValue);
    return getLoginStatus();
  }

  async function handleApiRequest(action, body) {
    const webAppUser = validateWebAppInitData(body.initData, bot.token);
    if (String(webAppUser.id) !== String(ownerId)) {
      throw httpError("Mini App faqat bot egasi uchun.", 403);
    }

    if (action === "status") return getLoginStatus();
    if (action === "cancel") {
      await cancelMiniAppLogin();
      return getLoginStatus();
    }
    if (action === "start") {
      if (body.consent !== true) {
        throw httpError("Akkaunt ulash roziligi tasdiqlanishi kerak.", 400);
      }
      const phoneNumber = typeof body.phoneNumber === "string" ? body.phoneNumber.trim() : "";
      if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
        throw httpError("Telefon raqamini xalqaro formatda kiriting, masalan +998901234567.", 400);
      }
      return beginMiniAppLogin(phoneNumber);
    }
    if (["code", "password", "email", "email-code"].includes(action)) {
      return submitMiniAppCredential(action, body.value);
    }
    throw httpError("Mini App so'rovi topilmadi.", 404);
  }

  async function start() {
    if (!doc.userSessionEncrypted) return;
    if (!Number.isSafeInteger(apiId) || apiId < 1 || !apiHash) {
      console.error(`User scheduler ${doc._id}: TELEGRAM_API_ID/HASH sozlanmagan.`);
      await notifyOwner("Akkaunt sessiyasini tiklash uchun serverda TELEGRAM_API_ID va TELEGRAM_API_HASH kerak.");
      return;
    }
    let client;
    try {
      client = makeTelegramClient(decryptSecret(doc.userSessionEncrypted), apiId, apiHash);
      try {
        await client.connect();
      } catch (error) {
        await client.disconnect().catch((disconnectError) => {
          console.error(`User scheduler ${doc._id} sessiyasini uzib bo'lmadi:`, disconnectError.message);
        });
        throw new Error(
          "Telegram akkauntiga ulanish muvaffaqiyatsiz tugadi. Saqlangan sessiyani Telegram → Sozlamalar → Qurilmalar bo'limida tekshiring.",
        );
      }
      if (!await client.checkAuthorization()) {
        throw new Error("Telegram sessiyasi avtorizatsiyadan o'tmadi.");
      }
      const me = await client.getMe();
      if (doc.userAccount?.id && String(me.id) !== String(doc.userAccount.id)) {
        throw new Error("Saqlangan Telegram akkaunti mos kelmadi.");
      }
      userClient = client;
      sourceBotPeer = null;
      attachMtprotoSourceListener();
      doc.userAccount = { id: String(me.id), username: me.username || "" };
      if (getSchedule().enabled) startScheduler();
    } catch (error) {
      console.error(`User scheduler ${doc._id} sessiyasini tiklab bo'lmadi:`, error.name);
      if (client) {
        try {
          await client.disconnect();
        } catch (disconnectError) {
          console.error(`User scheduler ${doc._id} sessiyasini uzib bo'lmadi:`, disconnectError.message);
        }
      }
      await notifyOwner("Telegram akkaunt sessiyasini tiklab bo'lmadi. /start orqali qayta ulang.");
    }
  }

  async function stopRuntime() {
    stopping = true;
    stopScheduler();
    await waitForSend();
    if (pendingAlbum) await flushPendingAlbum(false);
    await cancelMiniAppLogin();
    if (loginAttempt?.phase === "success") {
      clearTimeout(loginAttempt.cleanupTimer);
      loginAttempt = null;
    }
    clearChatShareRequests();
    chatPickerActive = false;
    if (userClient) {
      const client = userClient;
      userClient = null;
      sourceBotPeer = null;
      await client.disconnect();
    }
  }

  async function unlinkAccount() {
    stopScheduler();
    await saveSchedule({ enabled: false, nextRunAt: null, chatIds: [] });
    await waitForSend();
    await cancelMiniAppLogin();
    stopScheduler();

    let client = userClient;
    if (!client && doc.userSessionEncrypted) {
      if (!Number.isSafeInteger(apiId) || apiId < 1 || !apiHash) {
        throw new Error(
          "Akkaunt sessiyasini bekor qilish uchun serverda TELEGRAM_API_ID va TELEGRAM_API_HASH kerak.",
        );
      }
      client = makeTelegramClient(decryptSecret(doc.userSessionEncrypted), apiId, apiHash);
      await client.connect();
    }
    if (client) {
      try {
        await client.logOut();
      } catch (error) {
        console.error(`User scheduler ${doc._id} Telegram sessiyasini bekor qilmadi:`, error.message);
        await client.disconnect().catch((disconnectError) => {
          console.error(`User scheduler ${doc._id} sessiyasini uzib bo'lmadi:`, disconnectError.message);
        });
        userClient = null;
        sourceBotPeer = null;
        throw new Error(
          "Telegram sessiyasini bekor qilib bo'lmadi. Saqlangan sessiya o'chirilmadi; Telegram → Sozlamalar → Qurilmalar bo'limida uni qo'lda bekor qiling.",
        );
      }
      userClient = null;
      sourceBotPeer = null;
    }
    await Bots.updateOne(
      { _id: doc._id, ownerId },
      { $unset: { userSessionEncrypted: "", userAccount: "" } },
    );
    delete doc.userSessionEncrypted;
    delete doc.userAccount;
    if (loginAttempt?.phase === "success") {
      clearTimeout(loginAttempt.cleanupTimer);
      loginAttempt = null;
    }
  }

  async function deleteRuntime() {
    if (doc.userSessionEncrypted) await unlinkAccount();
    await stopRuntime();
  }

  async function cancelPending() {
    const mode = inputModes.get(ownerId);
    const hadPending = Boolean(mode || (loginAttempt && !loginAttempt.closed));
    if (pendingAlbum) {
      clearTimeout(pendingAlbum.timer);
      pendingAlbum = null;
    }
    inputModes.delete(ownerId);
    if (mode) {
      clearTimeout(mode.timer);
      mode.reject?.(new Error("Kiritish bekor qilindi."));
    }
    if (loginAttempt && !loginAttempt.closed) await cancelMiniAppLogin();
    return hadPending;
  }

  bot.command("start", async (ctx) => {
    if (!isOwnerPrivateChat(ctx)) return;
    await showPanel(ctx);
  });

  bot.onCallbackData(/^userbot:(.+)$/, async (ctx, match) => {
    if (!isOwnerPrivateChat(ctx)) {
      await ctx.answer({ text: "Bu boshqaruv paneli bot egasi uchun." });
      return;
    }
    await ctx.answer();
    try {
      const [action, ...args] = match[1].split(":");
      const schedule = getSchedule();

      if (action === "panel") {
        await showPanel(ctx, true);
      } else if (action === "connect") {
        await ctx.reply(
          "Mini App uchun ommaviy HTTPS manzili kerak. Render’da RENDER_EXTERNAL_URL avtomatik ishlatiladi; boshqa hostingda PUBLIC_API_URL sozlang.",
        );
      } else if (action === "account") {
        await showPanel(ctx, false, "Telegram akkaunt allaqachon ulangan.");
      } else if (action === "cancel-login") {
        await cancelMiniAppLogin();
        await ctx.reply("Mini App orqali akkaunt ulash bekor qilindi.");
      } else if (action === "cancel-input") {
        inputModes.delete(ownerId);
        if (pendingAlbum) {
          clearTimeout(pendingAlbum.timer);
          pendingAlbum = null;
        }
        await showPanel(ctx, false, "Kiritish bekor qilindi.");
      } else if (action === "chats") {
        await promptChatSelection(ctx);
      } else if (action === "chat-list" || action === "toggle") {
        await promptChatSelection(ctx);
      } else if (action === "message" || action === "interval") {
        inputModes.set(ownerId, { type: action });
        await ctx.reply(
          action === "message"
            ? "Takror yuboriladigan xabarni yuboring: matn, media, fayl yoki forward. Tugmalar va premium emoji ham Telegram xabaridan saqlanadi."
            : "Takrorlanish intervalini soat:daqiqa:soniya formatida yuboring (masalan, 00:00:10). Eng qisqa interval — 10 soniya.",
          {
            reply_markup: {
              inline_keyboard: [[{
                text: "Bekor qilish",
                callback_data: "userbot:cancel-input",
                style: "danger",
              }]],
            },
          },
        );
      } else if (action === "preview") {
        const validation = await validateSchedule();
        if (validation.error) {
          await ctx.reply(validation.error, { reply_markup: panelKeyboard() });
          return;
        }
        if (isValidMessageRef(schedule.messageRef)) {
          await ctx.reply(
            `XABAR TANLANDI: ${schedule.messageRef.description || "Telegram xabari"}` +
              (schedule.messageRef.forwarded ? " (forward holida yuboriladi)." : " (siz yuborgandek nusxalanadi)."),
          );
        } else {
          await ctx.reply("XABAR MATNI OLDIDAN KO'RISH:");
          await ctx.reply(schedule.message);
        }
        await ctx.reply(
          `Manzillar: ${validation.targets.length}\n` +
            `Interval: ${formatInterval(schedule.intervalSeconds)}\n` +
            "Tasdiqlasangiz, birinchi yuborish hozir boshlanadi; keyingilari tanlangan intervalda davom etadi.",
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Tasdiqlash va boshlash", callback_data: "userbot:activate", style: "success" }],
                [{ text: "Panelga qaytish", callback_data: "userbot:panel", style: "primary" }],
              ],
            },
          },
        );
      } else if (action === "activate") {
        if (getSchedule().enabled) {
          await ctx.reply("Jadval allaqachon faol. Takroriy yuborishni oldini olish uchun uni avval to'xtating.");
          return;
        }
        const validation = await validateSchedule();
        if (validation.error) {
          await ctx.reply(validation.error, { reply_markup: panelKeyboard() });
          return;
        }
        await saveSchedule({
          enabled: true,
          nextRunAt: new Date(),
        });
        startScheduler();
        await showPanel(ctx, false, "Jadval faollashtirildi. Birinchi xabar yuborilishi kutilmoqda.");
      } else if (action === "stop") {
        await saveSchedule({ enabled: false, nextRunAt: null });
        stopScheduler();
        await showPanel(ctx, false, "Jadval to'xtatildi. Yangi yuborishlar bajarilmaydi.");
      } else if (action === "unlink") {
        await ctx.reply("Ulangan akkaunt sessiyasini bekor qilaymi?", {
          reply_markup: {
            inline_keyboard: [[
              { text: "Ha, akkauntni uzish", callback_data: "userbot:unlink-confirm", style: "danger" },
              { text: "Bekor qilish", callback_data: "userbot:panel", style: "primary" },
            ]],
          },
        });
      } else if (action === "unlink-confirm") {
        await unlinkAccount();
        await showPanel(ctx, false, "Telegram akkaunt uzildi va saqlangan sessiya bekor qilindi.");
      }
    } catch (error) {
      console.error(`User scheduler ${doc._id} panel amali bajarilmadi:`, error.message);
      await ctx.reply(`Amal bajarilmadi: ${error.message}`, { reply_markup: panelKeyboard() });
    }
  });

  async function validateSchedule() {
    const schedule = getSchedule();
    if (!userClient) return { error: "Avval Telegram akkauntingizni ulang." };
    if (
      !hasScheduleMessage(schedule) ||
      (typeof schedule.message === "string" && schedule.message.length > 4096)
    ) {
      return { error: "Takror yuboriladigan xabarni tanlang yoki yuboring." };
    }
    if (
      !Number.isInteger(Number(schedule.intervalSeconds)) ||
      schedule.intervalSeconds < MIN_INTERVAL_SECONDS ||
      schedule.intervalSeconds > MAX_INTERVAL_SECONDS
    ) {
      return { error: "Interval noto'g'ri. Eng qisqa interval — 10 soniya." };
    }
    if (!schedule.chatIds.length) return { error: "Kamida bitta guruh yoki kanalni tanlang." };
    const targets = await resolveSelectedTargets(schedule.chatIds);
    if (targets.length !== schedule.chatIds.length) {
      return { error: "Tanlangan chatlardan ayrimlari akkauntingizda topilmadi. Chatlar ro'yxatini yangilang." };
    }
    return { targets };
  }

  async function saveMessageReference(ctx, messageRef, notify = true) {
    try {
      if (typeof userClient?.getSourceBotPeer === "function") {
        await getSourceBotPeer();
      } else if (userClient) {
        await getSourceBotPeer();
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const mtprotoMessageIds = [];
      for (const botMessageId of messageRef.messageIds) {
        const mtprotoId = findMtprotoMessageId(ctx.message);
        if (mtprotoId) mtprotoMessageIds.push(mtprotoId);
      }
      if (mtprotoMessageIds.length === messageRef.messageIds.length) {
        messageRef.mtprotoMessageIds = mtprotoMessageIds;
      }
      await saveSchedule({
        message: "",
        messageRef,
        enabled: false,
        nextRunAt: null,
      });
    } catch (error) {
      console.error(`User scheduler ${doc._id} xabarni saqlay olmadi:`, error.message);
      if (notify) await ctx.reply(`Xabarni saqlab bo'lmadi: ${error.message}`);
      return;
    }
    inputModes.delete(ownerId);
    clearChatShareRequests();
    chatPickerActive = false;
    stopScheduler();
    if (!notify) return;
    await ctx.reply("Xabar jadval uchun saqlandi.", {
      reply_markup: { remove_keyboard: true },
    });
    await showPanel(ctx, false, "Sozlama saqlandi.");
  }

  async function flushPendingAlbum(notify = true) {
    if (!pendingAlbum) return;
    const album = pendingAlbum;
    pendingAlbum = null;
    clearTimeout(album.timer);
    if (inputModes.get(ownerId)?.type !== "message") return;
    await saveMessageReference(album.ctx, {
      messageIds: album.messageIds,
      forwarded: album.forwarded,
      description: album.description,
      text: album.ctx.message?.caption || "",
    }, notify);
  }

  bot.onUpdate("message", async (ctx) => {
    if (!isOwnerPrivateChat(ctx)) return;
    const message = ctx.message;
    if (message.chat_shared) {
      await handleSharedChat(ctx, message.chat_shared);
      ctx.handled = true;
      return;
    }

    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (text === "/cancel" && inputModes.has(ownerId)) {
      inputModes.delete(ownerId);
      if (pendingAlbum) {
        clearTimeout(pendingAlbum.timer);
        pendingAlbum = null;
      }
      await showPanel(ctx, false, "Kiritish bekor qilindi.");
      ctx.handled = true;
      return;
    }
    if (chatPickerActive && (text === "✅ Tanlov tugadi" || text === "Bekor qilish")) {
      clearChatShareRequests();
      chatPickerActive = false;
      await ctx.reply("Chat tanlash yakunlandi.", {
        reply_markup: { remove_keyboard: true },
      });
      await showPanel(ctx);
      ctx.handled = true;
      return;
    }

    const mode = inputModes.get(ownerId);
    if (mode?.type !== "message") return;
    if (pendingAlbum && pendingAlbum.groupId !== String(message.media_group_id || "")) {
      await flushPendingAlbum();
      if (!inputModes.has(ownerId)) {
        ctx.handled = true;
        return;
      }
    }
    if (!Number.isSafeInteger(message.message_id) || message.message_id < 1) {
      await ctx.reply("Bu Telegram xabarini saqlab bo'lmadi. Qaytadan yuboring.");
      ctx.handled = true;
      return;
    }
    if (message.media_group_id) {
      if (!pendingAlbum) {
        pendingAlbum = {
          groupId: String(message.media_group_id),
          messageIds: [],
          forwarded: isForwardedFromAnotherUser(message),
          description: describeTelegramMessage(message),
          ctx,
          timer: null,
        };
      }
      if (!pendingAlbum.messageIds.includes(message.message_id)) {
        pendingAlbum.messageIds.push(message.message_id);
      }
      pendingAlbum.ctx = ctx;
      clearTimeout(pendingAlbum.timer);
      pendingAlbum.timer = setTimeout(() => {
        void flushPendingAlbum().catch((error) => {
          console.error(`User scheduler ${doc._id} albom xabarini saqlay olmadi:`, error.message);
        });
      }, ALBUM_CAPTURE_DELAY_MS);
      ctx.handled = true;
      return;
    }
    const messageRef = {
      messageIds: [message.message_id],
      forwarded: isForwardedFromAnotherUser(message),
      description: describeTelegramMessage(message),
      text: typeof message.text === "string"
        ? message.text
        : typeof message.caption === "string"
          ? message.caption
          : "",
    };
    await saveMessageReference(ctx, messageRef);
    ctx.handled = true;
  });

  bot.onText(/[\s\S]+/, async (ctx) => {
    if (!isOwnerPrivateChat(ctx)) return;
    if (typeof ctx.message?.text !== "string") return;
    const mode = inputModes.get(ownerId);
    if (!mode) return;
    const value = ctx.text.trim();
    try {
      if (mode.type === "interval") {
        const intervalSeconds = parseInterval(value);
        await saveSchedule({ intervalSeconds, enabled: false, nextRunAt: null });
      } else {
        return;
      }
      stopScheduler();
      inputModes.delete(ownerId);
      await showPanel(ctx, false, "Sozlama saqlandi.");
    } catch (error) {
      await ctx.reply(error.message);
    }
  });

  return {
    start,
    delete: deleteRuntime,
    cancelPending,
    handleApiRequest,
    async stop() {
      await stopRuntime();
    },
  };
}

function registerUserScheduler(bot, options) {
  const { doc, Bots, UserSchedulerUsers } = options;
  const createSessionBot = options.createSessionBot ||
    ((token, botOptions) => new BotConstructor(token, botOptions));
  const sessions = new Map();
  const pendingSessions = new Map();
  let migrationPromise = null;
  let stopping = false;

  async function migrateLegacyOwnerSession() {
    if (migrationPromise) return migrationPromise;
    migrationPromise = (async () => {
      if (!doc.userSessionEncrypted && !doc.userAccount && !doc.userSchedule) return;
      const filter = { botId: doc._id, userId: doc.ownerId };
      const legacySession = {
        botId: doc._id,
        userId: doc.ownerId,
        createdAt: new Date(),
        ...(
          doc.userSessionEncrypted
            ? { userSessionEncrypted: doc.userSessionEncrypted }
            : {}
        ),
        ...(doc.userAccount ? { userAccount: doc.userAccount } : {}),
        ...(doc.userSchedule ? { userSchedule: doc.userSchedule } : {}),
      };
      await UserSchedulerUsers.updateOne(
        filter,
        { $setOnInsert: legacySession },
        { upsert: true },
      );
      const result = await Bots.updateOne(
        { _id: doc._id, ownerId: doc.ownerId },
        { $unset: {
          userSessionEncrypted: "",
          userAccount: "",
          userSchedule: "",
        } },
      );
      if (result?.matchedCount !== 1) {
        throw new Error("Eski User Bot sozlamalarini yangi saqlash tizimiga ko'chirib bo'lmadi.");
      }
      delete doc.userSessionEncrypted;
      delete doc.userAccount;
      delete doc.userSchedule;
    })();
    return migrationPromise;
  }

  async function loadOrCreateUserRecord(userId) {
    const filter = { botId: doc._id, userId };
    await UserSchedulerUsers.updateOne(
      filter,
      {
        $setOnInsert: {
          botId: doc._id,
          userId,
          userSchedule: { ...EMPTY_SCHEDULE },
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    const record = await UserSchedulerUsers.findOne(filter);
    if (!record) throw new Error("Foydalanuvchi sozlamasini bazadan olib bo'lmadi.");
    return record;
  }

  async function createUserRuntime(userId, startRuntime = true) {
    if (!Number.isSafeInteger(userId) || userId < 1) {
      throw new Error("Telegram foydalanuvchisi ID'si noto'g'ri.");
    }
    if (stopping) throw new Error("User Bot hozir to'xtatilmoqda.");
    await migrateLegacyOwnerSession();
    const record = await loadOrCreateUserRecord(userId);
    const sessionDoc = {
      ...doc,
      ownerId: userId,
      userSchedule: record.userSchedule || { ...EMPTY_SCHEDULE },
    };
    for (const field of ["userSessionEncrypted", "userAccount"]) {
      if (record[field] !== undefined) sessionDoc[field] = record[field];
      else delete sessionDoc[field];
    }
    const userBot = createSessionBot(bot.token, bot.options);
    const sessionCollection = {
      updateOne: (_filter, update, updateOptions) =>
        UserSchedulerUsers.updateOne(
          { botId: doc._id, userId },
          update,
          updateOptions,
        ),
    };
    const controls = registerUserSchedulerSession(userBot, {
      ...options,
      doc: sessionDoc,
      Bots: sessionCollection,
    });
    const entry = { bot: userBot, controls };
    try {
      if (startRuntime) await controls.start();
    } catch (error) {
      await controls.stop().catch(() => {});
      throw error;
    }
    sessions.set(userId, entry);
    return entry;
  }

  async function getUserRuntime(userId, startRuntime = true) {
    const existing = sessions.get(userId);
    if (existing) return existing;
    const pending = pendingSessions.get(userId);
    if (pending) return pending;
    const creation = createUserRuntime(userId, startRuntime);
    pendingSessions.set(userId, creation);
    try {
      return await creation;
    } finally {
      if (pendingSessions.get(userId) === creation) pendingSessions.delete(userId);
    }
  }

  async function dispatchUpdate(ctx) {
    if (
      ctx.chat?.type !== "private" ||
      !Number.isSafeInteger(ctx.from?.id) ||
      ctx.from.id < 1
    ) return;
    ctx.handled = true;
    try {
      const runtime = await getUserRuntime(ctx.from.id);
      await runtime.bot.processUpdate(ctx.update);
    } catch (error) {
      console.error(`User scheduler ${doc._id} ${ctx.from.id} foydalanuvchi so'rovini bajara olmadi:`, error.message);
      await ctx.reply("User Bot so'rovni bajara olmadi. Birozdan keyin qayta urinib ko'ring.");
    }
  }

  bot.command("start", dispatchUpdate);
  bot.onCallbackData(/^userbot:(.+)$/, dispatchUpdate);
  bot.onUpdate("message", dispatchUpdate);

  async function start() {
    await migrateLegacyOwnerSession();
    const activeRecords = await UserSchedulerUsers.find({
      botId: doc._id,
      "userSchedule.enabled": true,
    }).toArray();
    for (const record of activeRecords) {
      await getUserRuntime(Number(record.userId));
    }
  }

  async function handleApiRequest(action, body) {
    const webAppUser = validateWebAppInitData(body.initData, bot.token);
    const runtime = await getUserRuntime(webAppUser.id);
    return runtime.controls.handleApiRequest(action, body);
  }

  async function cancelPending(ctx) {
    const userId = Number.isSafeInteger(ctx?.from?.id) ? ctx.from.id : doc.ownerId;
    const userRuntime = sessions.get(userId);
    return userRuntime ? userRuntime.controls.cancelPending() : false;
  }

  async function stop() {
    stopping = true;
    await Promise.all([...pendingSessions.values()].map((pending) => pending.catch(() => {})));
    const entries = [...sessions.values()];
    sessions.clear();
    const failures = [];
    for (const entry of entries) {
      try {
        await entry.controls.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new Error(`${failures.length} foydalanuvchi runtime'ini to'xtatib bo'lmadi.`);
    }
  }

  async function deleteRuntime() {
    await migrateLegacyOwnerSession();
    const records = await UserSchedulerUsers.find({ botId: doc._id }).toArray();
    const userIds = new Set([
      ...records.map((record) => Number(record.userId)),
      ...sessions.keys(),
    ]);
    const failures = [];
    for (const userId of userIds) {
      let entry;
      try {
        entry = await getUserRuntime(userId, false);
        await entry.controls.delete();
      } catch (error) {
        failures.push(error);
        console.error(`User scheduler ${doc._id} ${userId} sessiyasini uzib bo'lmadi:`, error.message);
      } finally {
        if (entry) {
          await entry.controls.stop().catch((error) => {
            console.error(`User scheduler ${doc._id} ${userId} runtime to'xtamadi:`, error.message);
          });
        }
      }
    }
    sessions.clear();
    await UserSchedulerUsers.deleteMany({ botId: doc._id });
    if (failures.length) {
      throw new Error(`${failures.length} foydalanuvchining Telegram sessiyasini avtomatik uzib bo'lmadi.`);
    }
  }

  return {
    start,
    stop,
    delete: deleteRuntime,
    cancelPending,
    handleApiRequest,
  };
}

module.exports = Object.assign(registerUserScheduler, {
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  buildMiniAppUrl,
  formatInterval,
  getDialogKind,
  parseInterval,
  registerUserScheduler,
  validateWebAppInitData,
});
