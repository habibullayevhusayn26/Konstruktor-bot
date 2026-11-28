"use strict";

const crypto = require("node:crypto");
const { Api, TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const { NewMessage } = require("teleproto/events");
const { BotConstructor } = require("../bot-constructor");
const { createTolovApi } = require("./user-scheduler/tolov-api");
const { createTolovPaymentService } = require("./user-scheduler/tolov-payments");

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
const PREMIUM_PLANS = Object.freeze({
  1: Object.freeze({ months: 1, stars: 100, label: "1 oy" }),
  3: Object.freeze({ months: 3, stars: 250, label: "3 oy" }),
  12: Object.freeze({ months: 12, stars: 800, label: "12 oy" }),
});
const DEFAULT_TOLOV_PRICES = Object.freeze({ 1: 50000, 3: 120000, 12: 400000 });

function getTolovPremiumPrices(settings) {
  const saved = settings?.tolovApiPrices || settings?.card || {};
  return {
    1: Number(saved[1]) || DEFAULT_TOLOV_PRICES[1],
    3: Number(saved[3]) || DEFAULT_TOLOV_PRICES[3],
    12: Number(saved[12]) || DEFAULT_TOLOV_PRICES[12],
  };
}

async function purchasePremiumWithBalance({
  UserSchedulerUsers,
  botId,
  userId,
  months,
  prices,
  now = new Date(),
}) {
  const plan = PREMIUM_PLANS[months];
  const amount = Number(prices?.[months]);
  if (!plan || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Premium narxi yoki muddati noto'g'ri.");
  }
  const user = await UserSchedulerUsers.findOne({ botId, userId });
  const currentBalance = Number(user?.balance) || 0;
  const currentUntil = user?.premiumUntil instanceof Date
    ? user.premiumUntil
    : user?.premiumUntil
      ? new Date(user.premiumUntil)
      : null;
  const start = currentUntil && currentUntil > now ? currentUntil : now;
  const premiumUntil = new Date(start);
  premiumUntil.setUTCMonth(premiumUntil.getUTCMonth() + plan.months);
  const result = await UserSchedulerUsers.updateOne(
    { botId, userId, balance: { $gte: amount } },
    {
      $set: { premium: true, premiumUntil, premiumPlan: plan.label },
      $inc: { balance: -amount },
      $push: {
        premiumHistory: {
          plan: plan.label,
          amount,
          method: "balance",
          paidAt: now,
        },
      },
    },
  );
  if (result.matchedCount !== 1) {
    return { status: "insufficient", amount, currentBalance };
  }
  return {
    status: "purchased",
    amount,
    premiumUntil,
    user: await UserSchedulerUsers.findOne({ botId, userId }),
  };
}

function getTolovPaymentReply(result) {
  if (result.status === "amount_busy") {
    return {
      text: `Bu summa hozir band. TolovAPI ${Number(result.suggestedAmount).toLocaleString("uz-UZ")} so'm taklif qildi.\n` +
        "Davom etishdan oldin taklif qilingan summani tasdiqlang.",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Shu summada davom etish", callback_data: "userbot:tolov-confirm", style: "success" },
          { text: "❌ Bekor qilish", callback_data: "userbot:tolov-cancel", style: "danger" },
        ]],
      },
    };
  }
  if (result.status === "created" || result.status === "existing") {
    const payment = result.payment;
    const expiresAt = new Date(payment.expiresAt);
    return {
      text: `💳 To'lovni 5 daqiqa ichida amalga oshiring.\n\n` +
        `Karta: ${payment.cardNumber}\n` +
        `Summa: ${Number(payment.amount).toLocaleString("uz-UZ")} so'm\n` +
        `Amal qilish muddati: ${expiresAt.toLocaleTimeString("uz-UZ", { timeZone: "Asia/Tashkent" })}\n\n` +
        "To'lov tasdiqlangach, balans yoki Premium avtomatik yangilanadi.",
      reply_markup: {
        inline_keyboard: [[{
          text: "❌ To'lovni bekor qilish",
          callback_data: "userbot:tolov-cancel",
          style: "danger",
        }]],
      },
    };
  }
  if (result.status === "pending") {
    return {
      text: `To'lov hali kutilmoqda: ${Number(result.payment.amount).toLocaleString("uz-UZ")} so'm.`,
      reply_markup: {
        inline_keyboard: [[{
          text: "❌ To'lovni bekor qilish",
          callback_data: "userbot:tolov-cancel",
          style: "danger",
        }]],
      },
    };
  }
  if (["cancelled", "cancel", "expired"].includes(result.status)) {
    return { text: "To'lov bekor qilindi. Istasangiz, yangidan boshlang." };
  }
  return { text: "Hozircha kutayotgan TolovAPI to'lovi yo'q." };
}

const EMPTY_SCHEDULE = Object.freeze({
  message: "",
  intervalSeconds: MIN_INTERVAL_SECONDS,
  chatIds: [],
  chatTitles: {},
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

function makeAutoFooter(username) {
  const normalizedUsername = String(username || "").replace(/^@/, "");
  return normalizedUsername
    ? `\n\nXabar @${normalizedUsername} orqali yuborildi!`
    : "";
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

function normalizePhoneNumber(value) {
  let normalized = String(value || "").replace(/[^\d+]/g, "");
  normalized = normalized.replace(/(?!^)\+/g, "");
  if (normalized.startsWith("00")) normalized = `+${normalized.slice(2)}`;
  if (/^\d{9,15}$/.test(normalized)) normalized = `+${normalized}`;
  return normalized;
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
    tolovPayments,
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
  let footerUsername = String(doc.username || "").replace(/^@/, "");
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
      chatTitles:
        savedSchedule.chatTitles &&
        typeof savedSchedule.chatTitles === "object" &&
        !Array.isArray(savedSchedule.chatTitles)
          ? savedSchedule.chatTitles
          : {},
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
              text: `👤 Akkaunt: ${doc.userAccount?.username ? `@${doc.userAccount.username}` : "ulangan"}`,
              callback_data: "userbot:account",
              style: "primary",
            }
          : {
              text: "🔐 Akkauntni Mini App orqali ulash",
              ...(miniAppUrl
                ? { web_app: { url: miniAppUrl } }
                : { callback_data: "userbot:connect" }),
              style: "primary",
            }],
        [
          { text: "💬 Chatlarni tanlash", callback_data: "userbot:chats", style: "primary" },
          { text: "📨 Xabarni tanlash", callback_data: "userbot:message", style: "primary" },
        ],
        [
          { text: "⏱ Interval", callback_data: "userbot:interval", style: "primary" },
          { text: "📅 Jadval", callback_data: "userbot:preview", style: "primary" },
        ],
        [{
          text: doc.premium ? "⭐ Premium faol" : "⭐ Premium tarif",
          callback_data: "premium:show",
          style: "primary",
        }, ...(tolovPayments?.isConfigured()
          ? [{ text: "💳 Balansni to'ldirish", callback_data: "userbot:balance", style: "success" }]
          : [])],
        [{
          text: "▶️ Ko'rib chiqish va boshlash",
          callback_data: "userbot:preview",
          style: "success",
        }],
        [
          { text: "⏸ To'xtatish", callback_data: "userbot:stop", style: "danger" },
          ...(doc.userSessionEncrypted
            ? [{ text: "🔓 Akkauntni uzish", callback_data: "userbot:unlink", style: "danger" }]
            : [{ text: "🔄 Yangilash", callback_data: "userbot:panel", style: "danger" }]),
        ],
      ],
    };
  }

  async function showPanel(ctx, edit = false, extraText = "") {
    const schedule = getSchedule();
    const account = doc.userAccount?.username
      ? `@${doc.userAccount.username}`
      : userClient
        ? "Telegram akkaunt"
        : "ulangan emas";
    const nextRun = schedule.nextRunAt
      ? new Date(schedule.nextRunAt).toLocaleString("uz-UZ", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZone: "Asia/Tashkent",
        })
      : "Belgilanmagan";
    let messageText = "Belgilanmagan";
    if (isValidMessageRef(schedule.messageRef)) {
      const description = schedule.messageRef.description || "xabar";
      if (["rasm", "video"].includes(description)) {
        messageText = `${description}${schedule.messageRef.text?.trim() ? " (izohli)" : " (izohsiz)"}`;
      } else {
        messageText = description;
      }
    } else if (typeof schedule.message === "string" && schedule.message.trim()) {
      messageText = "matn";
    }
    const chatCount = schedule.chatIds.length;
    const text =
      `🖼 USER BOT — BOSHQARUV PANELI\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 Akkaunt: ${account}\n` +
      `⭐ Tarif: ${doc.premium ? "Premium" : "Bepul"}\n` +
      `💰 Balans: ${Number(doc.balance) || 0} so'm\n` +
      `💬 Tanlangan chatlar: ${chatCount} ta\n` +
      `⏱ Interval: ${formatInterval(Number(schedule.intervalSeconds) || MIN_INTERVAL_SECONDS)}\n` +
      `📨 Xabar turi: ${messageText}\n\n` +
      `📅 Jadval: ${schedule.enabled ? "🟢 Faol" : "🔴 To'xtatilgan"}\n` +
      `⏭ Keyingi yuborish: ${nextRun}`;
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

  async function ensureTargetMembership(target) {
    if (!userClient || !target) return true;
    const entity = target.dialog?.entity || target.dialog;
    const canJoinDirectly =
      typeof userClient.joinChannel === "function" &&
      (
        entity?.className === "Channel" ||
        entity?.broadcast ||
        entity?.megagroup
      );
    if (!canJoinDirectly) return true;
    try {
      await userClient.joinChannel(entity);
      return true;
    } catch (error) {
      const code = error?.errorMessage || error?.message || "";
      if (/already|CHAT_INVITE_ALREADY|USER_ALREADY_PARTICIPANT/i.test(code)) return true;
      console.error(
        `User scheduler ${doc._id} ${target.peerId} chatiga avtomatik qo'shila olmadi: ${code}`,
      );
      return false;
    }
  }

  async function ensureRequiredSubscriptions() {
    if (!userClient) return { joined: 0, failed: [] };
    const requiredChannels = Array.isArray(doc.requiredChannels)
      ? doc.requiredChannels
      : doc.requiredChannel
        ? [{
            chatId: doc.requiredChannel,
            title: doc.requiredChannelTitle,
            link: doc.requiredChannelLink,
          }]
        : [];
    let joined = 0;
    const failed = [];
    for (const required of requiredChannels) {
      try {
        const privateInvite =
          typeof required.link === "string" &&
          (/t\.me\/\+(?:[^/?#]+)/i.test(required.link) ||
           /t\.me\/joinchat\//i.test(required.link));
        if (privateInvite && typeof userClient.importChatInvite === "function") {
          await userClient.importChatInvite(required.link);
          joined++;
          continue;
        }
        if (typeof userClient.joinChannel === "function") {
          const entity = await userClient.getEntity(required.chatId);
          await userClient.joinChannel(entity);
          joined++;
          continue;
        }
        failed.push(required.title || String(required.chatId));
      } catch (error) {
        const code = error?.errorMessage || error?.message || "";
        if (/already|CHAT_INVITE_ALREADY|USER_ALREADY_PARTICIPANT/i.test(code)) {
          joined++;
        } else {
          failed.push(required.title || String(required.chatId));
          console.error(
            `User scheduler ${doc._id} majburiy obuna ${required.title || required.chatId} ga qo‘shilmadi: ${code}`,
          );
        }
      }
    }
    return { joined, failed };
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

  function convertFormattingEntities(entities) {
    if (!Array.isArray(entities)) return [];
    const converted = [];
    for (const entity of entities) {
      if (!entity || !Number.isInteger(entity.offset) || !Number.isInteger(entity.length)) continue;
      const params = { offset: entity.offset, length: entity.length };
      let convertedEntity;
      switch (entity.type) {
        case "bold":
          convertedEntity = new Api.MessageEntityBold(params);
          break;
        case "italic":
          convertedEntity = new Api.MessageEntityItalic(params);
          break;
        case "underline":
          convertedEntity = new Api.MessageEntityUnderline(params);
          break;
        case "strikethrough":
          convertedEntity = new Api.MessageEntityStrike(params);
          break;
        case "code":
          convertedEntity = new Api.MessageEntityCode(params);
          break;
        case "pre":
          convertedEntity = new Api.MessageEntityPre({ ...params, language: entity.language || "" });
          break;
        case "text_link":
          convertedEntity = new Api.MessageEntityTextUrl({ ...params, url: entity.url || "" });
          break;
        case "text_mention":
          convertedEntity = new Api.MessageEntityMentionName({
            ...params,
            userId: entity.user?.id,
          });
          break;
        case "custom_emoji":
          continue;
        case "spoiler":
          convertedEntity = new Api.MessageEntitySpoiler(params);
          break;
        default:
          continue;
      }
      converted.push(convertedEntity);
    }
    return converted;
  }

  function convertReplyMarkup(replyMarkup) {
    if (!Array.isArray(replyMarkup?.inline_keyboard)) return undefined;
    const rows = replyMarkup.inline_keyboard.map((row) =>
      row.map((button) => {
        if (button.url) {
          return new Api.KeyboardButtonUrl({ text: button.text, url: button.url });
        }
        if (button.callback_data) {
          return new Api.KeyboardButtonCallback({
            text: button.text,
            data: Buffer.from(button.callback_data, "utf8"),
          });
        }
        return null;
      }).filter(Boolean),
    ).filter((row) => row.length);
    return rows.length ? rows : undefined;
  }

  function buildAutoFooter() {
    return doc.premium ? "" : makeAutoFooter(footerUsername);
  }

  async function refreshFooterUsername() {
    try {
      const botInfo = await bot.api("getMe");
      const liveUsername = String(botInfo?.username || "").replace(/^@/, "");
      if (liveUsername) footerUsername = liveUsername;
    } catch (error) {
      console.error(`User scheduler ${doc._id} bot username aniqlanmadi:`, error.message);
    }
    return footerUsername;
  }

  function appendAutoFooter(text) {
    const footer = buildAutoFooter();
    if (!footer) return { text: text || "", entities: [] };
    const base = String(text || "");
    const separator = base.endsWith("\n\n")
      ? ""
      : base.endsWith("\n")
        ? "\n"
        : "\n\n";
    const footerWithSeparator = `${separator}${footer.replace(/^\n\n/, "")}`;
    const result = `${base}${footerWithSeparator}`;
    const mentionIndex = result.indexOf("@", base.length);
    const mentionText = footerUsername ? `@${footerUsername}` : "";
    const entities = [];
    if (mentionText && mentionIndex >= 0) {
      entities.push(new Api.MessageEntityMention({
        offset: mentionIndex,
        length: mentionText.length,
      }));
    }
    return { text: result, entities };
  }

  function buildTextSendParams(text, messageRef) {
    const originalEntities = convertFormattingEntities(messageRef?.entities);
    const appended = appendAutoFooter(text);
    const originalText = String(text || "").trimEnd();
    const footerEntities = appended.entities.map((entity) => {
      if (entity.offset >= originalText.length) return entity;
      return entity;
    });
    const entities = [
      ...originalEntities,
      ...footerEntities,
    ].sort((left, right) => left.offset - right.offset);
    const buttons = convertReplyMarkup(messageRef?.replyMarkup);
    return {
      message: appended.text,
      formattingEntities: entities,
      ...(buttons ? { buttons } : {}),
    };
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
        const mediaClassName = message.media?.className || "";
        const description = mediaClassName.includes("Photo")
          ? "rasm"
          : mediaClassName.includes("Video")
            ? "video"
            : mediaClassName.includes("Document")
              ? "fayl"
              : text
                ? "matn"
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
    await refreshFooterUsername();
    if (!isValidMessageRef(schedule.messageRef)) {
      await userClient.sendMessage(target, buildTextSendParams(schedule.message, {}));
      return;
    }
    if (
      schedule.messageRef.description === "matn" &&
      typeof schedule.messageRef.text === "string" &&
      schedule.messageRef.text
    ) {
      const sendParams = buildTextSendParams(schedule.messageRef.text, schedule.messageRef);
      await userClient.sendMessage(target, sendParams);
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
        if (
          schedule.messageRef.description === "matn" &&
          typeof schedule.messageRef.text === "string" &&
          schedule.messageRef.text
        ) {
          await userClient.sendMessage(
            target,
            buildTextSendParams(schedule.messageRef.text, schedule.messageRef),
          );
          return;
        }
        throw error;
      }
      const validIds = sourceMessages
        .filter((message) => message && Number.isSafeInteger(message.id))
        .map((message) => message.id);
      if (!validIds.length) {
        if (
          schedule.messageRef.description === "matn" &&
          schedule.messageRef.text
        ) {
          await userClient.sendMessage(
            target,
            buildTextSendParams(schedule.messageRef.text, schedule.messageRef),
          );
          return;
        }
        throw new Error(
          "Telegram botdagi manba xabari topilmadi. Xabarni qayta yuborib, jadvalni yangilang.",
        );
      }
      for (let index = 0; index < messageIds.length; index++) {
        if (!validIds.includes(messageIds[index])) {
          if (
            schedule.messageRef.description === "matn" &&
            schedule.messageRef.text
          ) {
            await userClient.sendMessage(
              target,
              buildTextSendParams(schedule.messageRef.text, schedule.messageRef),
            );
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
    if (Array.isArray(sent) && sent.length) {
      for (let sentIndex = 0; sentIndex < sent.length; sentIndex++) {
        const sentMessage = sent[sentIndex];
        if (!sentMessage) continue;
        const originalCaption =
          typeof sentMessage.message === "string"
            ? sentMessage.message
            : schedule.messageRef.text || "";
        const captionParams = buildTextSendParams(originalCaption, schedule.messageRef);
        try {
          await userClient.editMessage(target, {
            message: sentMessage,
            text: captionParams.message,
            formattingEntities: captionParams.formattingEntities,
            ...(captionParams.buttons ? { buttons: captionParams.buttons } : {}),
          });
        } catch (error) {
          const code = error?.errorMessage || error?.message || "";
          if (!/not modified|identical/i.test(code)) {
            console.error(
              `User scheduler ${doc._id} media/captionga bot reklamasini qo'shib bo'lmadi: ${code}`,
            );
            if (typeof sourceMessages?.length === "number" && typeof userClient.sendFile === "function") {
              try {
                if (sentMessage.id && typeof userClient.deleteMessages === "function") {
                  await userClient.deleteMessages(target, [sentMessage.id], { revoke: true });
                }
                const sourceMessage = sourceMessages[sentIndex] || sourceMessages[0];
                if (sourceMessage?.media) {
                  await userClient.sendFile(target, {
                    file: sourceMessage.media,
                    caption: captionParams.message,
                    formattingEntities: captionParams.formattingEntities,
                  });
                }
              } catch (fallbackError) {
                console.error(
                  `User scheduler ${doc._id} media/caption footer fallbacki ishlamadi:`,
                  fallbackError?.message || fallbackError?.errorMessage || fallbackError?.name,
                );
              }
            }
          }
        }
      }
    }
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

    if (!await ensureTargetMembership(target)) {
      await ctx.reply(
        "Chatga User akkaunti bilan avtomatik qo‘shilib bo‘lmadi.\n" +
          "Public guruh/kanal bo‘lsa, botga yana taqdim eting; private chat uchun invite-link orqali qo‘shiling.",
        { reply_markup: chatPickerKeyboard() },
      );
      return;
    }

    const selected = new Set(getSchedule().chatIds);
    const wasSelected = selected.has(target.peerId);
    if (!wasSelected && !doc.premium && selected.size >= 20) {
      await ctx.reply("Bepul tarifda 20 ta chat limiti bor. Cheksiz chatlar uchun Premium sotib oling.", {
        reply_markup: chatPickerKeyboard(),
      });
      return;
    }
    if (wasSelected) selected.delete(target.peerId);
    else selected.add(target.peerId);
    try {
      const nextChatTitles = { ...getSchedule().chatTitles };
      if (!wasSelected) {
        nextChatTitles[target.peerId] =
          String(shared.title || target.title || "").trim() || `Chat ${target.peerId}`;
      } else {
        delete nextChatTitles[target.peerId];
      }
      await saveSchedule({
        chatIds: [...selected],
        chatTitles: nextChatTitles,
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
      {
        reply_markup: chatPickerKeyboard(),
      },
    );
    await showConnectedChatActions(ctx);
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
      "💬 Qaysi chatga xabar yuborilsin?\n\nGuruh yoki kanal tugmasini bosing, so'ng Telegram ro'yxatidan chatni tanlang.\nChatni qayta tanlasangiz — u jadvaldan olib tashlanadi.",
      { reply_markup: chatPickerKeyboard() },
    );
    await showConnectedChatActions(ctx);
  }

  async function showConnectedChatActions(ctx) {
    const selectedIds = getSchedule().chatIds;
    const chatTitles = getSchedule().chatTitles;
    if (!selectedIds.length) {
      await ctx.reply(
        "📭 Hozir hech qanday chat tanlanmagan.",
        {
          reply_markup: {
            inline_keyboard: [[{
              text: "Chat tanlash",
              callback_data: "userbot:chats",
              style: "primary",
            }]],
          },
        },
      );
      return;
    }
    let targets = [];
    try {
      targets = await resolveSelectedTargets(selectedIds);
    } catch (error) {
      console.error(`User scheduler ${doc._id} ulangan chatlarni ololmadi:`, error.message);
    }
    if (targets.length !== selectedIds.length) {
      const resolvedById = new Map(targets.map((target) => [target.peerId, target]));
      targets = selectedIds.map((peerId) => resolvedById.get(peerId) || {
        peerId,
        title: chatTitles[peerId] || "Chat nomi mavjud emas",
      });
    }
    const rows = [];
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      const title =
        chatTitles[target.peerId] ||
        target.title ||
        "Chat nomi mavjud emas";
      rows.push([{
        text: `❌ Uzish: ${title.slice(0, 35)}`,
        callback_data: `userbot:chat-remove:${target.peerId}`,
        style: "danger",
      }]);
    }
    await ctx.reply(
      "✅ Tanlangan chatlar:",
      {
        reply_markup: {
          inline_keyboard: [
            ...rows,
            [{ text: "Chat tanlash", callback_data: "userbot:chats", style: "primary" }],
          ],
        },
      },
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
        intervalSeconds < (doc.premium ? MIN_INTERVAL_SECONDS : 600) ||
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
          if (!await ensureTargetMembership(target)) {
            throw new Error("Telegram User akkaunti chatga avtomatik a'zo bo'lmadi.");
          }
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
      if (!footerUsername) {
        try {
          const botInfo = await bot.api("getMe");
          footerUsername = String(botInfo?.username || "").replace(/^@/, "");
        } catch (error) {
          console.error(`User scheduler ${doc._id} bot username topilmadi:`, error.message);
        }
      }
      await ensureRequiredSubscriptions();
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
      const phoneNumber = normalizePhoneNumber(body.phoneNumber);
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
      if (!footerUsername) {
        try {
          const botInfo = await bot.api("getMe");
          footerUsername = String(botInfo?.username || "").replace(/^@/, "");
        } catch (error) {
          console.error(`User scheduler ${doc._id} bot username topilmadi:`, error.message);
        }
      }
      await ensureRequiredSubscriptions();
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

  async function replyAutoPayment(ctx, result) {
    const reply = getTolovPaymentReply(result);
    await ctx.reply(reply.text, reply.reply_markup ? { reply_markup: reply.reply_markup } : {});
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
      } else if (action === "premium") {
        await ctx.reply(
          doc.premium
            ? "⭐ Premium tarif faol.\nCheksiz chatlar, 10 soniya interval va reklamasiz xabarlar."
            : "⭐ Premium tarif\nBepul: 20 chat va 10 daqiqa interval.\nPremium: cheksiz chat, 10 soniya interval va reklamasiz xabarlar.",
          { reply_markup: panelKeyboard() },
        );
      } else if (action === "balance") {
        if (!tolovPayments?.isConfigured()) {
          await ctx.reply("Avto to'lov hozircha sozlanmagan. Bot egasi server sozlamalarini tekshirishi kerak.");
          return;
        }
        inputModes.set(ownerId, { type: "balance-topup" });
        await ctx.reply(
          "Balansga qo'shmoqchi bo'lgan summangizni so'mda yuboring (faqat butun son).\n/cancel — bekor qilish.",
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
      } else if (action === "tolov-confirm") {
        await replyAutoPayment(ctx, await tolovPayments.confirm(ownerId));
      } else if (action === "tolov-cancel") {
        await replyAutoPayment(ctx, await tolovPayments.cancel(ownerId));
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
      } else if (action === "chat-remove") {
        const peerId = args.join(":");
        const schedule = getSchedule();
        if (!schedule.chatIds.includes(peerId)) {
          await ctx.reply("Bu chat allaqachon ulanmagan.");
          await showConnectedChatActions(ctx);
          return;
        }
        const nextChatIds = schedule.chatIds.filter((id) => id !== peerId);
        const nextChatTitles = { ...schedule.chatTitles };
        delete nextChatTitles[peerId];
        await saveSchedule({
          chatIds: nextChatIds,
          chatTitles: nextChatTitles,
          enabled: false,
          nextRunAt: null,
        });
        stopScheduler();
        await ctx.reply("Chat User Bot jadvalidan uzildi.", {
          reply_markup: chatPickerKeyboard(),
        });
        await showConnectedChatActions(ctx);
      } else if (action === "chat-list" || action === "toggle") {
        await promptChatSelection(ctx);
      } else if (action === "message" || action === "interval") {
        inputModes.set(ownerId, { type: action });
        await ctx.reply(
          action === "message"
            ? "📨 Qaysi xabar takror yuborilsin?\n\nMatn, rasm, video, fayl yoki forward yuboring.\nBot xabarni asl ko'rinishida yuboradi."
            : doc.premium
              ? "⏱ Qanday intervalda yuborilsin?\n\nFormat: soat:daqiqa:soniya\nMasalan: 00:00:10\n\nPremium minimal interval: 10 soniya."
              : "⏱ Qanday intervalda yuborilsin?\n\nFormat: soat:daqiqa:soniya\nMasalan: 00:10:00\n\nBepul tarif minimal interval: 10 daqiqa.",
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
        await ctx.reply("👀 XABAR KO'RINISHI:");
        await previewScheduledMessage(ctx, schedule);
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
          await ctx.reply("ℹ️ Jadval allaqachon faol.\nAvval «To'xtatish» tugmasini bosing.");
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
        await showPanel(ctx, false, "✅ Jadval faollashtirildi.");
      } else if (action === "stop") {
        await saveSchedule({ enabled: false, nextRunAt: null });
        stopScheduler();
        await showPanel(ctx, false, "⏸ Jadval to'xtatildi.");
      } else if (action === "unlink") {
        await ctx.reply("🔓 Akkaunt uzilsinmi?\nBarcha chat va xabar sozlamalari ham tozalanadi.", {
          reply_markup: {
            inline_keyboard: [[
              { text: "Ha, akkauntni uzish", callback_data: "userbot:unlink-confirm", style: "danger" },
              { text: "Bekor qilish", callback_data: "userbot:panel", style: "primary" },
            ]],
          },
        });
      } else if (action === "unlink-confirm") {
        await unlinkAccount();
        await showPanel(ctx, false, "✅ Telegram akkaunt uzildi.");
      }
    } catch (error) {
      console.error(`User scheduler ${doc._id} panel amali bajarilmadi:`, error.message);
      await ctx.reply(`Amal bajarilmadi: ${error.message}`, { reply_markup: panelKeyboard() });
    }
  });

  async function previewScheduledMessage(ctx, schedule) {
    if (!isValidMessageRef(schedule.messageRef)) {
      if (typeof schedule.message === "string" && schedule.message.trim()) {
        await ctx.reply(buildTextSendParams(schedule.message, {}).message);
      }
      return;
    }

    for (const messageId of schedule.messageRef.messageIds) {
      try {
        const preview = await ctx.api("copyMessage", {
          chat_id: ownerId,
          from_chat_id: ownerId,
          message_id: messageId,
          disable_notification: true,
        });
        const previewMessageId = preview?.message_id;
        if (!previewMessageId) continue;

        if (!doc.premium) {
          const baseText = schedule.messageRef.description === "matn"
            ? schedule.messageRef.text || preview.text || ""
            : schedule.messageRef.text || preview.caption || "";
          if (baseText) {
            const withFooter = buildTextSendParams(baseText, schedule.messageRef);
            if (schedule.messageRef.description === "matn") {
              await ctx.api("editMessageText", {
                chat_id: ownerId,
                message_id: previewMessageId,
                text: withFooter.message,
                entities: withFooter.formattingEntities,
              });
            } else {
              await ctx.api("editMessageCaption", {
                chat_id: ownerId,
                message_id: previewMessageId,
                caption: withFooter.message,
                caption_entities: withFooter.formattingEntities,
              });
            }
          }
        }
      } catch (error) {
        console.error(`User scheduler ${doc._id} preview xabarini ko'rsata olmadi:`, error.message);
      }
    }
  }

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
      schedule.intervalSeconds < (doc.premium ? MIN_INTERVAL_SECONDS : 600) ||
      schedule.intervalSeconds > MAX_INTERVAL_SECONDS
    ) {
      return {
        error: doc.premium
          ? "Interval noto'g'ri. Eng qisqa interval — 10 soniya."
          : "Bepul tarifda eng qisqa interval — 10 daqiqa.",
      };
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
      const sourceMessage = ctx.message;
      if (sourceMessage) {
        messageRef.entities =
          sourceMessage.entities ||
          sourceMessage.caption_entities ||
          [];
        messageRef.replyMarkup = sourceMessage.reply_markup || null;
      }
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
        if (!doc.premium && intervalSeconds < 600) {
          throw new Error("Bepul tarifda eng qisqa interval 10 daqiqa. Premium bilan 10 soniya.");
        }
        await saveSchedule({ intervalSeconds, enabled: false, nextRunAt: null });
      } else if (mode.type === "balance-topup") {
        const amount = Number(value.replace(/\s/g, ""));
        if (!Number.isSafeInteger(amount) || amount <= 0) {
          throw new Error("Summani musbat butun so'mda yuboring.");
        }
        const result = await tolovPayments.create(ownerId, { purpose: "balance", amount });
        inputModes.delete(ownerId);
        await replyAutoPayment(ctx, result);
        return;
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
  const decryptSecret = options.decryptSecret;
  const createSessionBot = options.createSessionBot ||
    ((token, botOptions) => new BotConstructor(token, {
      ...botOptions,
      disablePremiumEmoji: true,
    }));
  const sessions = new Map();
  const pendingSessions = new Map();
  let migrationPromise = null;
  let stopping = false;
  const tolovApi = options.tolovApi || createTolovApi({
    getCredentials: () => {
      const settings = doc.premiumSettings?.tolovApi || {};
      if (!settings.shopKeyEncrypted) {
        return { shopId: settings.shopId, shopKey: "" };
      }
      if (typeof decryptSecret !== "function") {
        throw new Error("TolovAPI kalitini ochish uchun shifrlash konfiguratsiyasi mavjud emas.");
      }
      return {
        shopId: settings.shopId,
        shopKey: decryptSecret(settings.shopKeyEncrypted),
      };
    },
    isConfigured: () => Boolean(
      doc.premiumSettings?.tolovApi?.shopId &&
      doc.premiumSettings?.tolovApi?.shopKeyEncrypted
    ),
  });
  const tolovPayments = options.tolovPayments || createTolovPaymentService({
    botId: doc._id,
    UserSchedulerUsers,
    api: tolovApi,
    notifyUser: (userId, text) => bot.sendMessage(userId, text),
    onPaymentApplied: async (userId, user) => {
      const runtime = sessions.get(userId);
      if (!runtime || !user) return;
      runtime.doc.balance = Number(user.balance) || 0;
      runtime.doc.premium = Boolean(user.premiumUntil && new Date(user.premiumUntil) > new Date());
    },
  });

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
          balance: 0,
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
    const premiumUntil = record.premiumUntil instanceof Date
      ? record.premiumUntil
      : record.premiumUntil
        ? new Date(record.premiumUntil)
        : null;
    const premium = Boolean(premiumUntil && premiumUntil > new Date());
    const sessionDoc = {
      ...doc,
      ownerId: userId,
      userSchedule: record.userSchedule || { ...EMPTY_SCHEDULE },
      balance: Number(record.balance) || 0,
      premium,
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
      tolovPayments,
    });
    const entry = { bot: userBot, controls, doc: sessionDoc };
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

  function getPremiumSettings() {
    const settings = doc.premiumSettings && typeof doc.premiumSettings === "object"
      ? doc.premiumSettings
      : {};
    const stars = settings.stars && typeof settings.stars === "object"
      ? settings.stars
      : {};
    return {
      stars: {
        1: Number(stars[1]) || 100,
        3: Number(stars[3]) || 250,
        12: Number(stars[12]) || 800,
      },
      tolovApiPrices: getTolovPremiumPrices(settings),
    };
  }

  async function getPremiumStatus(userId) {
    const record = await loadOrCreateUserRecord(userId);
    const premiumUntil = record.premiumUntil instanceof Date
      ? record.premiumUntil
      : record.premiumUntil
        ? new Date(record.premiumUntil)
        : null;
    return {
      active: Boolean(premiumUntil && premiumUntil > new Date()),
      premiumUntil,
      balance: Number(record.balance) || 0,
    };
  }

  async function showPremium(ctx) {
    const status = await getPremiumStatus(ctx.from.id);
    const premiumSettings = getPremiumSettings();
    const statusText = status.active
      ? `Faol — ${status.premiumUntil.toLocaleDateString("uz-UZ")} gacha`
      : "Faol emas";
    await ctx.reply(
      `⭐ PREMIUM TARIF\n\n` +
        `Bepul:\n` +
        `• Chatlar: 20 ta\n` +
        `• Minimal interval: 10 daqiqa\n` +
        `• Akkauntlar: 1 ta\n` +
        `• Xabar oxirida reklama bor\n\n` +
        `Premium:\n` +
        `• Chatlar: cheksiz\n` +
        `• Minimal interval: 10 soniya\n` +
        `• Akkauntlar: ko'p\n` +
        `• Premium emoji, rasm, video va fayllar\n` +
        `• Xabarda reklama yo'q\n\n` +
        `Holatingiz: ${statusText}\n` +
        `Balans: ${status.balance.toLocaleString("uz-UZ")} so'm`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `1 oy — ⭐ ${premiumSettings.stars[1]}`, callback_data: "premium:buy:1", style: "primary" },
              { text: `3 oy — ⭐ ${premiumSettings.stars[3]}`, callback_data: "premium:buy:3", style: "primary" },
              { text: `12 oy — ⭐ ${premiumSettings.stars[12]}`, callback_data: "premium:buy:12", style: "primary" },
            ],
            ...(tolovPayments.isConfigured()
              ? [[{ text: "💳 TolovAPI orqali to'lash", callback_data: "premium:autopay", style: "success" }]]
              : []),
            [[{ text: "💰 Balansdan Premium olish", callback_data: "premium:balance", style: "primary" }]],
            [
              { text: "📋 Mening tarifim", callback_data: "premium:mine", style: "primary" },
              { text: "📨 To'lov tarixi", callback_data: "premium:history", style: "primary" },
            ],
          ],
        },
      },
    );
  }

  async function sendPremiumInvoice(ctx, months) {
    const plan = PREMIUM_PLANS[months];
    if (!plan) return;
    const premiumSettings = getPremiumSettings();
    const payload = `userbot_premium_${doc._id}_${ctx.from.id}_${months}_${crypto.randomBytes(8).toString("hex")}`;
    await UserSchedulerUsers.updateOne(
      { botId: doc._id, userId: ctx.from.id },
      { $set: { pendingPremiumPayload: payload } },
      { upsert: true },
    );
    await bot.api("sendInvoice", {
      chat_id: ctx.chat.id,
      title: `User Bot — ${plan.label} Premium`,
      description: "Cheksiz chatlar, 10 soniya interval, premium emoji va reklamasiz xabarlar.",
      payload,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: plan.label, amount: premiumSettings.stars[months] }],
    });
  }

  bot.command("start", dispatchUpdate);
  bot.onCallbackData(/^userbot:(.+)$/, dispatchUpdate);
  bot.onCallbackData(/^premium:(show|mine|history|duration|autopay|balance)$/, async (ctx, match) => {
    await ctx.answer();
    if (ctx.chat?.type !== "private") return;
    const action = match[1];
    if (action === "show") {
      await showPremium(ctx);
      return;
    }
    if (action === "mine") {
      const status = await getPremiumStatus(ctx.from.id);
      await ctx.reply(
        status.active
          ? `⭐ Premium faol\nAmal qilish muddati: ${status.premiumUntil.toLocaleDateString("uz-UZ")} gacha\nReklama: o‘chirilgan`
          : "⭐ Sizda hozir Premium yo'q.",
        { reply_markup: { inline_keyboard: [[{ text: "⭐ Premiumni ko'rish", callback_data: "premium:show", style: "success" }]] } },
      );
      return;
    }
    if (action === "history") {
      const record = await loadOrCreateUserRecord(ctx.from.id);
      const history = Array.isArray(record.premiumHistory) ? record.premiumHistory : [];
      const lines = history.length
        ? history.slice(-10).reverse().map((item) =>
            `${new Date(item.paidAt).toLocaleDateString("uz-UZ")} — ${item.plan}` +
              (item.method === "tolovapi"
                ? " (TolovAPI)"
                : item.method === "balance"
                  ? " (balans)"
                  : " (Stars)"),
          ).join("\n")
        : "To'lovlar topilmadi.";
      await ctx.reply(`📨 Premium to'lov tarixi\n\n${lines}`);
      return;
    }
    if (action === "autopay") {
      if (!tolovPayments.isConfigured()) {
        await ctx.reply("TolovAPI hozircha sozlanmagan. Bot egasi server sozlamalarini tekshirishi kerak.");
        return;
      }
      const { tolovApiPrices } = getPremiumSettings();
      await ctx.reply("TolovAPI orqali Premium muddatini tanlang:", {
        reply_markup: {
          inline_keyboard: [1, 3, 12].map((months) => [{
            text: `${PREMIUM_PLANS[months].label} — ${tolovApiPrices[months].toLocaleString("uz-UZ")} so'm`,
            callback_data: `premium:autobuy:${months}`,
            style: "primary",
          }]),
        },
      });
      return;
    }
    if (action === "balance") {
      const status = await getPremiumStatus(ctx.from.id);
      const { tolovApiPrices } = getPremiumSettings();
      await ctx.reply(
        `Balans: ${status.balance.toLocaleString("uz-UZ")} so'm\nBalansdan Premium muddatini tanlang:`,
        {
          reply_markup: {
            inline_keyboard: [1, 3, 12].map((months) => [{
              text: `${PREMIUM_PLANS[months].label} — ${tolovApiPrices[months].toLocaleString("uz-UZ")} so'm`,
              callback_data: `premium:balance:${months}`,
              style: "primary",
            }]),
          },
        },
      );
      return;
    }
    if (action === "duration") {
      const premiumSettings = getPremiumSettings();
      await ctx.reply("📅 Premium muddatini tanlang:", {
        reply_markup: {
          inline_keyboard: [
            ...[1, 3, 12].map((months) => [{
              text: `${PREMIUM_PLANS[months].label} — ⭐ ${premiumSettings.stars[months]}`,
              callback_data: `premium:buy:${months}`,
              style: "primary",
            }]),
          ],
        },
      });
    }
  });
  bot.onCallbackData(/^premium:buy:(1|3|12)$/, async (ctx, match) => {
    await ctx.answer();
    if (ctx.chat?.type !== "private") return;
    await sendPremiumInvoice(ctx, Number(match[1]));
  });

  bot.onCallbackData(/^premium:autobuy:(1|3|12)$/, async (ctx, match) => {
    await ctx.answer();
    if (ctx.chat?.type !== "private") return;
    const months = Number(match[1]);
    const amount = getPremiumSettings().tolovApiPrices[months];
    try {
      const result = await tolovPayments.create(ctx.from.id, {
        purpose: "premium",
        amount,
        months,
      });
      const reply = getTolovPaymentReply(result);
      await ctx.reply(reply.text, reply.reply_markup ? { reply_markup: reply.reply_markup } : {});
    } catch (error) {
      console.error(`User scheduler ${doc._id} TolovAPI Premium to'lovini yarata olmadi:`, error.message);
      await ctx.reply(`TolovAPI to'lovini yaratib bo'lmadi: ${error.message}`);
    }
  });

  bot.onCallbackData(/^premium:balance:(1|3|12)$/, async (ctx, match) => {
    await ctx.answer();
    if (ctx.chat?.type !== "private") return;
    const months = Number(match[1]);
    const plan = PREMIUM_PLANS[months];
    const prices = getPremiumSettings().tolovApiPrices;
    try {
      const result = await purchasePremiumWithBalance({
        UserSchedulerUsers,
        botId: doc._id,
        userId: ctx.from.id,
        months,
        prices,
      });
      if (result.status === "insufficient") {
        const topupButton = tolovPayments.isConfigured()
          ? {
              text: "💳 Balansni TolovAPI orqali to'ldirish",
              callback_data: "userbot:balance",
              style: "success",
            }
          : {
              text: "⭐ Premium tarifini ko'rish",
              callback_data: "premium:show",
              style: "primary",
            };
        await ctx.reply(
          `Balansingizda mablag' yetarli emas. Kerak: ${result.amount.toLocaleString("uz-UZ")} so'm; ` +
            `mavjud: ${result.currentBalance.toLocaleString("uz-UZ")} so'm.`,
          {
            reply_markup: {
              inline_keyboard: [[topupButton]],
            },
          },
        );
        return;
      }
      const runtime = sessions.get(ctx.from.id);
      if (runtime && result.user) {
        runtime.doc.balance = Number(result.user.balance) || 0;
        runtime.doc.premium = true;
      }
      await ctx.reply(
        `Balansdan ${result.amount.toLocaleString("uz-UZ")} so'm yechildi.\n` +
          `${plan.label} Premium ${result.premiumUntil.toLocaleDateString("uz-UZ")} gacha faollashtirildi.`,
      );
    } catch (error) {
      console.error(`User scheduler ${doc._id} balansdan Premium xaridini bajara olmadi:`, error.message);
      await ctx.reply(`Premium xaridini bajarib bo'lmadi: ${error.message}`);
    }
  });

  bot.onUpdate("pre_checkout_query", async (ctx) => {
    const record = await UserSchedulerUsers.findOne({
      botId: doc._id,
      userId: ctx.from.id,
      pendingPremiumPayload: ctx.preCheckoutQuery.invoice_payload,
    });
    await ctx.answerPreCheckout(Boolean(record), record ? undefined : "To'lov eskirgan. Qayta urinib ko'ring.");
  });

  bot.onUpdate("successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
    if (payment.currency !== "XTR") return;
    const record = await UserSchedulerUsers.findOne({
      botId: doc._id,
      userId: ctx.from.id,
      pendingPremiumPayload: payment.invoice_payload,
    });
    if (!record) return;
    const match = String(payment.invoice_payload).match(/^userbot_premium_(\d+)_(\d+)_(1|3|12)_/);
    if (!match) return;
    const months = Number(match[3]);
    const plan = PREMIUM_PLANS[months];
    const now = new Date();
    const currentUntil = record.premiumUntil instanceof Date
      ? record.premiumUntil
      : record.premiumUntil
        ? new Date(record.premiumUntil)
        : null;
    const start = currentUntil && currentUntil > now ? currentUntil : now;
    const premiumUntil = new Date(start);
    premiumUntil.setUTCMonth(premiumUntil.getUTCMonth() + plan.months);
    await UserSchedulerUsers.updateOne(
      { botId: doc._id, userId: ctx.from.id },
      {
        $set: {
          premium: true,
          premiumUntil,
          premiumPlan: plan.label,
        },
        $push: {
          premiumHistory: {
            plan: plan.label,
            stars: plan.stars,
            paidAt: now,
          },
        },
        $unset: { pendingPremiumPayload: "" },
      },
    );
    const updatedUser = await UserSchedulerUsers.findOne({ botId: doc._id, userId: ctx.from.id });
    const runtime = sessions.get(ctx.from.id);
    if (runtime && updatedUser) {
      runtime.doc.balance = Number(updatedUser.balance) || 0;
      runtime.doc.premium = true;
    }
    await ctx.reply(
      `⭐ PREMIUM FAOLLASHTIRILDI\n` +
        `Muddat: ${plan.label}\n` +
        `Amal qilish: ${premiumUntil.toLocaleDateString("uz-UZ")} gacha\n` +
        `Reklama o‘chirildi.`,
    );
  });
  bot.onUpdate("message", dispatchUpdate);

  async function start() {
    await migrateLegacyOwnerSession();
    await tolovPayments.resume();
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
    tolovPayments.stop();
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
    tolovPayments.stop();
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
  makeAutoFooter,
  getDialogKind,
  normalizePhoneNumber,
  parseInterval,
  purchasePremiumWithBalance,
  registerUserScheduler,
  validateWebAppInitData,
});
