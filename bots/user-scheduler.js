"use strict";

const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const QRCode = require("qrcode");

const MIN_INTERVAL_MINUTES = 60;
const MAX_INTERVAL_MINUTES = 30 * 24 * 60;
const DIALOG_LIMIT = 500;
const TARGETS_PER_PAGE = 8;
const RUNNER_INTERVAL_MS = 15_000;
const PASSWORD_TIMEOUT_MS = 2 * 60_000;
const TARGET_SEND_DELAY_MS = 1_000;
const EMPTY_SCHEDULE = Object.freeze({
  message: "",
  intervalMinutes: MIN_INTERVAL_MINUTES,
  chatIds: [],
  enabled: false,
  nextRunAt: null,
  lastSentAt: null,
});

function parseInterval(value) {
  const match = String(value).trim().match(/^(\d{1,3}):([0-5]\d)$/);
  if (!match) throw new Error("Intervalni soat:daqiqa formatida yuboring, masalan 01:30.");
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes < MIN_INTERVAL_MINUTES) {
    throw new Error("Xavfsizlik uchun eng qisqa interval 01:00.");
  }
  if (minutes > MAX_INTERVAL_MINUTES) {
    throw new Error("Interval 30 kundan oshmasin.");
  }
  return minutes;
}

function canPostToDialog(dialog) {
  const entity = dialog?.entity;
  if (!entity || entity.left || (!dialog.isGroup && !dialog.isChannel)) return false;
  if (entity.creator) return true;
  if (!entity.adminRights) return false;
  return entity.className !== "Channel" ||
    !entity.broadcast ||
    entity.adminRights.postMessages === true;
}

function formatInterval(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function createTelegramClient(session, apiId, apiHash) {
  return new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
  });
}

function registerUserScheduler(bot, options) {
  const { doc, Bots, encryptSecret, decryptSecret } = options;
  const ownerId = doc.ownerId;
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH || "";
  const inputModes = new Map();
  let userClient = null;
  let activeLogin = null;
  let schedulerTimer = null;
  let sending = false;
  let sendCompletion = null;

  const isOwnerPrivateChat = (ctx) =>
    ctx.chat?.type === "private" && ctx.from?.id === ownerId;

  const getSchedule = () => ({
    ...EMPTY_SCHEDULE,
    ...(doc.userSchedule || {}),
    chatIds: Array.isArray(doc.userSchedule?.chatIds)
      ? doc.userSchedule.chatIds
      : [],
  });

  async function saveSchedule(changes) {
    const userSchedule = { ...getSchedule(), ...changes };
    await Bots.updateOne(
      { _id: doc._id, ownerId },
      { $set: { userSchedule } },
    );
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
    const schedule = getSchedule();
    return {
      inline_keyboard: [
        [{
          text: userClient
            ? `Akkaunt: ${doc.userAccount?.username ? `@${doc.userAccount.username}` : "ulangan"}`
            : "Telegram akkauntni ulash",
          callback_data: "userbot:connect",
          style: userClient ? "success" : "primary",
        }],
        [{ text: "Guruh va kanallarni tanlash", callback_data: "userbot:chats", style: "primary" }],
        [{ text: "Xabar matnini sozlash", callback_data: "userbot:message", style: "primary" }],
        [{ text: "Takrorlanish intervali", callback_data: "userbot:interval", style: "primary" }],
        [{ text: "Ko'rib chiqish va boshlash", callback_data: "userbot:preview", style: "success" }],
        [{ text: "Jadvalni to'xtatish", callback_data: "userbot:stop", style: "danger" }],
        ...(doc.userSessionEncrypted
          ? [[{ text: "Akkauntni uzish", callback_data: "userbot:unlink", style: "danger" }]]
          : []),
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
    const text =
      `USER BOT — BOSHQARUV PANELI\n\n` +
      `${account}\n` +
      `Tanlangan chatlar: ${schedule.chatIds.length}\n` +
      `Interval: ${formatInterval(Number(schedule.intervalMinutes) || MIN_INTERVAL_MINUTES)}\n` +
      `Jadval: ${schedule.enabled ? "Faol" : "To'xtatilgan"}\n` +
      `Keyingi yuborish: ${nextRun}\n\n` +
      (schedule.message ? `Xabar: ${schedule.message.slice(0, 250)}` : "Xabar matni hali sozlanmagan.") +
      (extraText ? `\n\n${extraText}` : "") +
      `\n\nFaqat siz admin yoki egasi bo'lgan guruh/kanallar ko'rsatiladi. ` +
      `Eng qisqa interval: 01:00.`;
    const markup = panelKeyboard();
    if (edit && typeof ctx.edit === "function") {
      await ctx.edit(text, { reply_markup: markup });
    } else {
      await ctx.reply(text, { reply_markup: markup });
    }
  }

  async function managedTargets(client = userClient) {
    if (!client) return [];
    const dialogs = await client.getDialogs({ limit: DIALOG_LIMIT });
    const targets = [];
    for (const dialog of dialogs) {
      if (!canPostToDialog(dialog)) continue;
      const peerId = await client.getPeerId(dialog.entity, true);
      targets.push({
        peerId: String(peerId),
        title: dialog.title || dialog.entity.title || "Nomsiz chat",
        dialog,
      });
    }
    return targets;
  }

  async function renderTargets(ctx, page = 0, edit = true) {
    if (!userClient) {
      await ctx.reply("Avval shaxsiy Telegram akkauntingizni ulang.", {
        reply_markup: panelKeyboard(),
      });
      return;
    }
    const targets = await managedTargets();
    if (!targets.length) {
      await ctx.reply(
        "Siz admin yoki egasi bo'lgan guruh/kanal topilmadi. Ruxsatlarni tekshirib, qayta urinib ko'ring.",
        { reply_markup: panelKeyboard() },
      );
      return;
    }
    const pages = Math.ceil(targets.length / TARGETS_PER_PAGE);
    const currentPage = Math.min(Math.max(0, page), pages - 1);
    const selected = new Set(getSchedule().chatIds);
    const keyboard = targets
      .slice(currentPage * TARGETS_PER_PAGE, (currentPage + 1) * TARGETS_PER_PAGE)
      .map((target) => [{
        text: `${selected.has(target.peerId) ? "✓ " : ""}${target.title}`.slice(0, 64),
        callback_data: `userbot:toggle:${currentPage}:${target.peerId}`,
        style: selected.has(target.peerId) ? "success" : "primary",
      }]);
    if (pages > 1) {
      keyboard.push([
        ...(currentPage > 0
          ? [{ text: "⬅️ Oldingi", callback_data: `userbot:chats:${currentPage - 1}` }]
          : []),
        ...(currentPage + 1 < pages
          ? [{ text: "Keyingi ➡️", callback_data: `userbot:chats:${currentPage + 1}` }]
          : []),
      ]);
    }
    keyboard.push([{ text: "Boshqaruv paneli", callback_data: "userbot:panel", style: "primary" }]);
    const text =
      `YUBORISH MANZILLARI\n\n` +
      `Faqat egasi yoki admini bo'lgan chatlar ko'rsatiladi.\n` +
      `Tanlangan: ${selected.size} · Sahifa ${currentPage + 1}/${pages}\n\n` +
      "Yuborish uchun chat tugmasini bosing:";
    if (edit && typeof ctx.edit === "function") {
      await ctx.edit(text, { reply_markup: { inline_keyboard: keyboard } });
    } else {
      await ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });
    }
  }

  function stopScheduler() {
    if (schedulerTimer) clearInterval(schedulerTimer);
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
      const intervalMinutes = Number(schedule.intervalMinutes);
      if (
        !Number.isInteger(intervalMinutes) ||
        intervalMinutes < MIN_INTERVAL_MINUTES ||
        intervalMinutes > MAX_INTERVAL_MINUTES
      ) {
        await saveSchedule({ enabled: false, nextRunAt: null });
        stopScheduler();
        await notifyOwner("Jadval xavfsiz interval tekshiruvidan o'tmadi va to'xtatildi.");
        return;
      }
      if (
        typeof schedule.message !== "string" ||
        !schedule.message.trim() ||
        schedule.message.length > 4096
      ) {
        await saveSchedule({ enabled: false, nextRunAt: null });
        stopScheduler();
        await notifyOwner("Xabar matni noto'g'ri bo'lgani uchun jadval to'xtatildi.");
        return;
      }

      await saveSchedule({
        nextRunAt: new Date(Date.now() + intervalMinutes * 60_000),
      });

      const allowed = await managedTargets();
      const byId = new Map(allowed.map((target) => [target.peerId, target]));
      const selectedIds = getSchedule().chatIds;
      const targets = selectedIds.map((id) => byId.get(id)).filter(Boolean);
      const removedIds = selectedIds.filter((id) => !byId.has(id));
      if (removedIds.length) {
        await saveSchedule({
          chatIds: targets.map((target) => target.peerId),
          enabled: targets.length > 0,
          nextRunAt: targets.length ? getSchedule().nextRunAt : null,
        });
        await notifyOwner(
          targets.length
            ? "Admin huquqi yo'qolgan chatlar jadvaldan olib tashlandi."
            : "Tanlangan chatlarda admin huquqi qolmadi. Jadval to'xtatildi.",
        );
      }
      if (!targets.length) {
        await saveSchedule({ enabled: false, nextRunAt: null });
        stopScheduler();
        await notifyOwner("Jadvalda yuborish uchun ruxsati bor chat qolmadi; jadval to'xtatildi.");
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
          await userClient.sendMessage(target.dialog, { message: schedule.message });
          sent++;
        } catch (error) {
          failed++;
          console.error(
            `User scheduler ${doc._id} ${target.peerId} chatiga yubora olmadi:`,
            error.message,
          );
        }
      }
      await saveSchedule({
        lastSentAt: new Date(),
        lastResult: { sent, failed },
      });
      await notifyOwner(
        `Rejalashtirilgan yuborish tugadi.\nMuvaffaqiyatli: ${sent}\nXatolik: ${failed}`,
      );
    } catch (error) {
      console.error(`User scheduler ${doc._id} jadval xatosi:`, error.message);
      await notifyOwner("Rejalashtirilgan yuborishda xatolik yuz berdi. /start orqali holatni tekshiring.");
    } finally {
      sending = false;
      sendCompletion = null;
      completeSend();
    }
  }

  function startScheduler() {
    stopScheduler();
    if (!userClient || !getSchedule().enabled) return;
    schedulerTimer = setInterval(() => {
      runDueSchedule().catch((error) => {
        console.error(`User scheduler ${doc._id} ishga tushmadi:`, error.message);
      });
    }, RUNNER_INTERVAL_MS);
    schedulerTimer.unref?.();
    runDueSchedule().catch((error) => {
      console.error(`User scheduler ${doc._id} ishga tushmadi:`, error.message);
    });
  }

  async function cancelLogin() {
    const login = activeLogin;
    if (!login) return;
    login.abortController.abort();
    if (login.passwordWaiter) {
      clearTimeout(login.passwordWaiter.timer);
      login.passwordWaiter.reject(new Error("QR ulash bekor qilindi."));
      login.passwordWaiter = null;
    }
    try {
      await login.client.disconnect();
    } catch (error) {
      console.error(`User scheduler ${doc._id} vaqtinchalik ulanishni yopmadi:`, error.message);
    }
  }

  async function removeQrMessage(login) {
    if (!login.qrMessageId) return;
    const messageId = login.qrMessageId;
    login.qrMessageId = null;
    try {
      await bot.api("deleteMessage", { chat_id: ownerId, message_id: messageId });
    } catch (error) {
      console.error(`User scheduler ${doc._id} QR xabarini o'chirmadi:`, error.message);
    }
  }

  async function requestTwoFactorPassword(login, hint) {
    let waiter;
    const passwordPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        login.passwordWaiter = null;
        reject(new Error("2FA parolini kiritish vaqti tugadi."));
      }, PASSWORD_TIMEOUT_MS);
      timer.unref?.();
      waiter = { resolve, reject, timer };
      login.passwordWaiter = waiter;
    });
    passwordPromise.catch(() => {});
    try {
      await bot.sendMessage(
        ownerId,
        `Telegram ikki bosqichli parol so'radi${hint ? ` (ishora: ${hint})` : ""}.\n` +
          "Parolni shu yerga yuborsangiz, xabar darhol o'chiriladi va parol saqlanmaydi. /cancel bilan bekor qiling.",
      );
    } catch (error) {
      if (login.passwordWaiter === waiter) {
        clearTimeout(waiter.timer);
        login.passwordWaiter = null;
        waiter.reject(error);
      }
      throw error;
    }
    return passwordPromise;
  }

  async function beginQrLogin() {
    if (!Number.isSafeInteger(apiId) || apiId < 1 || !apiHash) {
      await notifyOwner(
        "Akkaunt ulash sozlanmagan. Server admini TELEGRAM_API_ID va TELEGRAM_API_HASH qiymatlarini sozlashi kerak.",
      );
      return;
    }
    if (userClient) {
      await notifyOwner("Telegram akkauntingiz allaqachon ulangan.");
      return;
    }
    if (activeLogin) {
      await notifyOwner("QR orqali ulash jarayoni allaqachon ketmoqda.");
      return;
    }

    stopScheduler();
    await waitForSend();
    const login = {
      client: createTelegramClient("", apiId, apiHash),
      abortController: new AbortController(),
      qrMessageId: null,
      passwordWaiter: null,
    };
    activeLogin = login;
    let authenticated = false;
    try {
      await login.client.connect();
      await login.client.signInUserWithQrCode(
        { apiId, apiHash },
        {
          qrCode: async ({ token, expires }) => {
            if (login.abortController.signal.aborted) return;
            await removeQrMessage(login);
            const link = `tg://login?token=${token.toString("base64url")}`;
            const image = await QRCode.toBuffer(link, { width: 320, margin: 1 });
            if (login.abortController.signal.aborted) return;
            const expiryMinutes = Number.isFinite(Number(expires))
              ? Math.max(1, Math.ceil((Number(expires) - Date.now() / 1000) / 60))
              : null;
            const sent = await bot.sendPhoto(ownerId, image, "telegram-login.png", {
              caption:
                "Telegram ilovasida Sozlamalar → Qurilmalar → Qurilmani ulash orqali QR kodni skanerlang.\n" +
                (expiryMinutes ? `Kod ${expiryMinutes} daqiqada yangilanadi.` : "Kod tez orada yangilanadi."),
              reply_markup: {
                inline_keyboard: [[{
                  text: "Ulashni bekor qilish",
                  callback_data: "userbot:cancel-login",
                  style: "danger",
                }]],
              },
            });
            login.qrMessageId = sent.message_id;
            if (login.abortController.signal.aborted) await removeQrMessage(login);
          },
          password: (hint) => requestTwoFactorPassword(login, hint),
          onError: (error) => {
            console.error(`User scheduler ${doc._id} QR login xatosi:`, error.name);
            return false;
          },
          abortSignal: login.abortController.signal,
        },
      );
      const me = await login.client.getMe();
      const encryptedSession = encryptSecret(login.client.session.save());
      const userAccount = {
        id: String(me.id),
        username: me.username || "",
      };
      await Bots.updateOne(
        { _id: doc._id, ownerId },
        { $set: { userSessionEncrypted: encryptedSession, userAccount } },
      );
      if (userClient) {
        await userClient.disconnect().catch((error) => {
          console.error(`User scheduler ${doc._id} eski sessiyasini yopmadi:`, error.message);
        });
      }
      userClient = login.client;
      doc.userSessionEncrypted = encryptedSession;
      doc.userAccount = userAccount;
      authenticated = true;
      startScheduler();
      await notifyOwner("Akkaunt xavfsiz ulandi. /start orqali guruh-kanallar va jadvalni sozlang.");
    } catch (error) {
      if (!login.abortController.signal.aborted) {
        console.error(`User scheduler ${doc._id} akkaunt ulash xatosi:`, error.name);
        await notifyOwner("Akkauntni ulab bo'lmadi. QR kodni yangilab qayta urinib ko'ring.");
      }
    } finally {
      await removeQrMessage(login);
      if (login.passwordWaiter) {
        clearTimeout(login.passwordWaiter.timer);
        login.passwordWaiter.reject(new Error("Akkaunt ulash tugadi."));
        login.passwordWaiter = null;
      }
      if (!authenticated) {
        try {
          await login.client.disconnect();
        } catch (error) {
          console.error(`User scheduler ${doc._id} login ulanishi yopilmadi:`, error.message);
        }
        if (userClient && getSchedule().enabled) startScheduler();
      }
      if (activeLogin === login) activeLogin = null;
    }
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
      client = createTelegramClient(decryptSecret(doc.userSessionEncrypted), apiId, apiHash);
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
    stopScheduler();
    await waitForSend();
    await cancelLogin();
    if (userClient) {
      const client = userClient;
      userClient = null;
      await client.disconnect();
    }
  }

  async function unlinkAccount() {
    stopScheduler();
    await saveSchedule({ enabled: false, nextRunAt: null, chatIds: [] });
    await waitForSend();
    await cancelLogin();

    let client = userClient;
    if (!client && doc.userSessionEncrypted) {
      if (!Number.isSafeInteger(apiId) || apiId < 1 || !apiHash) {
        throw new Error(
          "Akkaunt sessiyasini bekor qilish uchun serverda TELEGRAM_API_ID va TELEGRAM_API_HASH kerak.",
        );
      }
      client = createTelegramClient(decryptSecret(doc.userSessionEncrypted), apiId, apiHash);
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
        throw new Error(
          "Telegram sessiyasini bekor qilib bo'lmadi. Saqlangan sessiya o'chirilmadi; Telegram → Sozlamalar → Qurilmalar bo'limida uni qo'lda bekor qiling.",
        );
      }
      userClient = null;
    }
    await Bots.updateOne(
      { _id: doc._id, ownerId },
      { $unset: { userSessionEncrypted: "", userAccount: "" } },
    );
    delete doc.userSessionEncrypted;
    delete doc.userAccount;
  }

  async function deleteRuntime() {
    if (doc.userSessionEncrypted) await unlinkAccount();
    await stopRuntime();
  }

  async function cancelPending() {
    const mode = inputModes.get(ownerId);
    const hadPending = Boolean(mode || activeLogin);
    inputModes.delete(ownerId);
    if (mode) {
      clearTimeout(mode.timer);
      mode.reject?.(new Error("Kiritish bekor qilindi."));
    }
    if (activeLogin) await cancelLogin();
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
        void beginQrLogin().catch((error) => {
          console.error(`User scheduler ${doc._id} QR ulash jarayoni xatosi:`, error.message);
          notifyOwner("Akkaunt ulashni boshlashda xatolik yuz berdi. Keyinroq qayta urinib ko'ring.");
        });
        await ctx.reply(
          "Akkaunt ulash boshlandi. QR kodni Telegram ilovasidan skanerlang. QR kodni hech kimga yubormang.",
        );
      } else if (action === "cancel-login") {
        await cancelLogin();
        await ctx.reply("QR orqali akkaunt ulash bekor qilindi.");
      } else if (action === "cancel-input") {
        inputModes.delete(ownerId);
        await showPanel(ctx, false, "Kiritish bekor qilindi.");
      } else if (action === "chats") {
        await renderTargets(ctx, Number(args[0]) || 0);
      } else if (action === "toggle") {
        const page = Number(args[0]) || 0;
        const peerId = args[1];
        const targets = await managedTargets();
        if (!targets.some((target) => target.peerId === peerId)) {
          await ctx.reply("Bu chat endi admin huquqi bor manzillar ro'yxatida yo'q.");
          return;
        }
        const selected = new Set(schedule.chatIds);
        if (selected.has(peerId)) selected.delete(peerId);
        else selected.add(peerId);
        await saveSchedule({
          chatIds: [...selected],
          enabled: false,
          nextRunAt: null,
        });
        stopScheduler();
        await renderTargets(ctx, page);
      } else if (action === "message" || action === "interval") {
        inputModes.set(ownerId, { type: action });
        await ctx.reply(
          action === "message"
            ? "Takror yuboriladigan matnni yuboring (1–4096 belgi). Saqlashdan oldin xabarni ko'rib chiqasiz."
            : "Takrorlanish intervalini soat:daqiqa formatida yuboring (masalan, 01:30). Eng qisqa interval — 01:00.",
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
        await ctx.reply("XABAR MATNI OLDIDAN KO'RISH:");
        await ctx.reply(schedule.message);
        await ctx.reply(
          `Manzillar: ${validation.targets.length}\n` +
            `Interval: ${formatInterval(schedule.intervalMinutes)}\n` +
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
      typeof schedule.message !== "string" ||
      !schedule.message.trim() ||
      schedule.message.length > 4096
    ) {
      return { error: "Xabar matnini 1–4096 belgi oralig'ida sozlang." };
    }
    if (
      !Number.isInteger(Number(schedule.intervalMinutes)) ||
      schedule.intervalMinutes < MIN_INTERVAL_MINUTES ||
      schedule.intervalMinutes > MAX_INTERVAL_MINUTES
    ) {
      return { error: "Interval noto'g'ri. Eng qisqa interval — 01:00." };
    }
    if (!schedule.chatIds.length) return { error: "Kamida bitta boshqariladigan chatni tanlang." };
    const allowed = await managedTargets();
    const targets = schedule.chatIds.map((id) => allowed.find((target) => target.peerId === id)).filter(Boolean);
    if (targets.length !== schedule.chatIds.length) {
      return { error: "Tanlangan chatlardan ayrimlarida admin huquqi yo'q. Chatlar ro'yxatini yangilang." };
    }
    return { targets };
  }

  bot.onText(/[\s\S]+/, async (ctx) => {
    if (!isOwnerPrivateChat(ctx)) return;
    if (typeof ctx.message?.text !== "string") return;
    const login = activeLogin;
    if (login?.passwordWaiter) {
      const waiter = login.passwordWaiter;
      try {
        await ctx.api("deleteMessage", {
          chat_id: ctx.chat.id,
          message_id: ctx.message.message_id,
        });
      } catch (error) {
        clearTimeout(waiter.timer);
        login.passwordWaiter = null;
        waiter.reject(new Error("2FA parol xabarini chatdan xavfsiz o'chirib bo'lmadi."));
        console.error(`User scheduler ${doc._id} parol xabarini o'chira olmadi:`, error.message);
        await ctx.reply("Xabarni o'chira olmadim, akkaunt ulash bekor qilindi. Xabarni qo'lda o'chiring.");
        return;
      }
      clearTimeout(waiter.timer);
      login.passwordWaiter = null;
      waiter.resolve(ctx.text);
      return;
    }

    const mode = inputModes.get(ownerId);
    if (!mode) return;
    const value = ctx.text.trim();
    try {
      if (mode.type === "message") {
        if (!value || value.length > 4096) throw new Error("Matn 1–4096 belgi bo'lishi kerak.");
        await saveSchedule({ message: value, enabled: false, nextRunAt: null });
      } else if (mode.type === "interval") {
        const intervalMinutes = parseInterval(value);
        await saveSchedule({ intervalMinutes, enabled: false, nextRunAt: null });
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
    async stop() {
      await stopRuntime();
    },
  };
}

module.exports = {
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  canPostToDialog,
  formatInterval,
  parseInterval,
  registerUserScheduler,
};
