"use strict";

const crypto = require("node:crypto");
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");

const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60;
const DIALOG_LIMIT = 500;
const TARGETS_PER_PAGE = 8;
const RUNNER_INTERVAL_MS = 15_000;
const TARGET_SEND_DELAY_MS = 1_000;
const LOGIN_TIMEOUT_MS = 8 * 60_000;
const LOGIN_DATA_MAX_AGE_SECONDS = 10 * 60;
const LOGIN_START_WINDOW_MS = 60 * 60_000;
const MAX_LOGIN_STARTS_PER_HOUR = 5;
const MAX_CREDENTIAL_ATTEMPTS = 5;
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

function registerUserScheduler(bot, options) {
  const {
    doc,
    Bots,
    encryptSecret,
    decryptSecret,
    publicApiBaseUrl,
  } = options;
  const ownerId = doc.ownerId;
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH || "";
  const miniAppUrl = buildMiniAppUrl(publicApiBaseUrl, doc._id);
  const inputModes = new Map();
  const loginStarts = [];
  let userClient = null;
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
        [userClient
          ? {
              text: `Akkaunt: ${doc.userAccount?.username ? `@${doc.userAccount.username}` : "ulangan"}`,
              callback_data: "userbot:account",
              style: "success",
            }
          : {
              text: "Mini App orqali akkauntni ulash",
              ...(miniAppUrl
                ? { web_app: { url: miniAppUrl } }
                : { callback_data: "userbot:connect" }),
              style: "primary",
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
      `Interval: ${formatInterval(Number(schedule.intervalSeconds) || MIN_INTERVAL_SECONDS)}\n` +
      `Jadval: ${schedule.enabled ? "Faol" : "To'xtatilgan"}\n` +
      `Keyingi yuborish: ${nextRun}\n\n` +
      (schedule.message ? `Xabar: ${schedule.message.slice(0, 250)}` : "Xabar matni hali sozlanmagan.") +
      (extraText ? `\n\n${extraText}` : "") +
      `\n\nAkkauntingiz a'zo bo'lgan guruh va kanallar ko'rsatiladi. ` +
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

  async function renderTargetCategories(ctx, edit = true) {
    if (!userClient) {
      await ctx.reply("Avval shaxsiy Telegram akkauntingizni ulang.", {
        reply_markup: panelKeyboard(),
      });
      return;
    }
    const targets = await availableTargets();
    const groups = targets.filter((target) => target.kind === "groups").length;
    const channels = targets.filter((target) => target.kind === "channels").length;
    const selected = new Set(getSchedule().chatIds);
    const keyboard = [
      [{ text: `👥 Guruhlar (${groups})`, callback_data: "userbot:chat-list:groups:0", style: "primary" }],
      [{ text: `📢 Kanallar (${channels})`, callback_data: "userbot:chat-list:channels:0", style: "primary" }],
      [{ text: "Boshqaruv paneli", callback_data: "userbot:panel", style: "primary" }],
    ];
    const text =
      `CHAT TURINI TANLANG\n\n` +
      `Tanlangan chatlar: ${selected.size}\n` +
      `Admin bo'lish shart emas. Telegram yozishga ruxsat bermagan chatlarga yuborish muvaffaqiyatsiz bo'ladi.`;
    if (edit && typeof ctx.edit === "function") {
      await ctx.edit(text, { reply_markup: { inline_keyboard: keyboard } });
    } else {
      await ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });
    }
  }

  async function renderTargets(ctx, kind, page = 0, edit = true) {
    if (!userClient) {
      await ctx.reply("Avval shaxsiy Telegram akkauntingizni ulang.", {
        reply_markup: panelKeyboard(),
      });
      return;
    }
    if (!["groups", "channels"].includes(kind)) {
      await renderTargetCategories(ctx, edit);
      return;
    }
    const targets = await availableTargets(kind);
    if (!targets.length) {
      const label = kind === "groups" ? "guruh" : "kanal";
      const text = `Telegram akkauntingizda tanlash uchun ${label} topilmadi.`;
      const keyboard = [[{
        text: "⬅️ Guruhlar va kanallar",
        callback_data: "userbot:chats",
        style: "primary",
      }]];
      if (edit && typeof ctx.edit === "function") {
        await ctx.edit(text, { reply_markup: { inline_keyboard: keyboard } });
      } else {
        await ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });
      }
      return;
    }
    const pages = Math.ceil(targets.length / TARGETS_PER_PAGE);
    const currentPage = Math.min(Math.max(0, page), pages - 1);
    const selected = new Set(getSchedule().chatIds);
    const keyboard = targets
      .slice(currentPage * TARGETS_PER_PAGE, (currentPage + 1) * TARGETS_PER_PAGE)
      .map((target) => [{
        text: `${selected.has(target.peerId) ? "✓ " : ""}${target.title}`.slice(0, 64),
        callback_data: `userbot:toggle:${kind}:${currentPage}:${target.peerId}`,
        style: selected.has(target.peerId) ? "success" : "primary",
      }]);
    if (pages > 1) {
      keyboard.push([
        ...(currentPage > 0
          ? [{ text: "⬅️ Oldingi", callback_data: `userbot:chat-list:${kind}:${currentPage - 1}` }]
          : []),
        ...(currentPage + 1 < pages
          ? [{ text: "Keyingi ➡️", callback_data: `userbot:chat-list:${kind}:${currentPage + 1}` }]
          : []),
      ]);
    }
    keyboard.push([{
      text: "⬅️ Guruhlar va kanallar",
      callback_data: "userbot:chats",
      style: "primary",
    }]);
    const text =
      `${kind === "groups" ? "GURUHLAR" : "KANALLAR"}\n\n` +
      `Tanlangan: ${selected.size} · Sahifa ${currentPage + 1}/${pages}\n\n` +
      "Chatni tanlash yoki tanlovdan chiqarish uchun bosing:";
    if (edit && typeof ctx.edit === "function") {
      await ctx.edit(text, { reply_markup: { inline_keyboard: keyboard } });
    } else {
      await ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });
    }
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
        nextRunAt: new Date(Date.now() + intervalSeconds * 1_000),
      });

      const allowed = await availableTargets();
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
      if (failed > 0) {
        await notifyOwner(
          `${failed} ta chatga rejalashtirilgan xabar yuborilmadi. /start orqali holatni tekshiring.`,
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
      client: createTelegramClient("", apiId, apiHash),
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
    stopping = true;
    stopScheduler();
    await waitForSend();
    await cancelMiniAppLogin();
    if (loginAttempt?.phase === "success") {
      clearTimeout(loginAttempt.cleanupTimer);
      loginAttempt = null;
    }
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
    await cancelMiniAppLogin();
    stopScheduler();

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
        await showPanel(ctx, false, "Kiritish bekor qilindi.");
      } else if (action === "chats") {
        await renderTargetCategories(ctx);
      } else if (action === "chat-list") {
        await renderTargets(ctx, args[0], Number(args[1]) || 0);
      } else if (action === "toggle") {
        const kind = args[0];
        const page = Number(args[1]) || 0;
        const peerId = args[2];
        const targets = await availableTargets(kind);
        const target = targets.find((item) => item.peerId === peerId);
        if (!target) {
          await ctx.reply("Bu chat endi Telegram akkauntingizdagi chatlar ro'yxatida yo'q.");
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
        await renderTargets(ctx, kind, page);
      } else if (action === "message" || action === "interval") {
        inputModes.set(ownerId, { type: action });
        await ctx.reply(
          action === "message"
            ? "Takror yuboriladigan matnni yuboring (1–4096 belgi). Saqlashdan oldin xabarni ko'rib chiqasiz."
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
        await ctx.reply("XABAR MATNI OLDIDAN KO'RISH:");
        await ctx.reply(schedule.message);
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
      typeof schedule.message !== "string" ||
      !schedule.message.trim() ||
      schedule.message.length > 4096
    ) {
      return { error: "Xabar matnini 1–4096 belgi oralig'ida sozlang." };
    }
    if (
      !Number.isInteger(Number(schedule.intervalSeconds)) ||
      schedule.intervalSeconds < MIN_INTERVAL_SECONDS ||
      schedule.intervalSeconds > MAX_INTERVAL_SECONDS
    ) {
      return { error: "Interval noto'g'ri. Eng qisqa interval — 10 soniya." };
    }
    if (!schedule.chatIds.length) return { error: "Kamida bitta guruh yoki kanalni tanlang." };
    const allowed = await availableTargets();
    const targets = schedule.chatIds.map((id) => allowed.find((target) => target.peerId === id)).filter(Boolean);
    if (targets.length !== schedule.chatIds.length) {
      return { error: "Tanlangan chatlardan ayrimlari akkauntingizda topilmadi. Chatlar ro'yxatini yangilang." };
    }
    return { targets };
  }

  bot.onText(/[\s\S]+/, async (ctx) => {
    if (!isOwnerPrivateChat(ctx)) return;
    if (typeof ctx.message?.text !== "string") return;
    const mode = inputModes.get(ownerId);
    if (!mode) return;
    const value = ctx.text.trim();
    try {
      if (mode.type === "message") {
        if (!value || value.length > 4096) throw new Error("Matn 1–4096 belgi bo'lishi kerak.");
        await saveSchedule({ message: value, enabled: false, nextRunAt: null });
      } else if (mode.type === "interval") {
        const intervalSeconds = parseInterval(value);
        await saveSchedule({ intervalSeconds, enabled: false, nextRunAt: null });
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
