/**
 * Telegram bot konstruktori: tayyor bot turini tanlatadi va token bilan ishga tushiradi.
 */
require("dotenv").config();

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");
const { webhookCallback } = require("grammy");
const { createGuardBot } = require("./bots/guard-bot");
const {
  closeGuardDatabase,
  getGuardDatabase,
} = require("./bots/guard/database");
const { BotConstructor } = require("./bot-constructor");
const {
  BillingService,
  getBillingSettings,
  parseSampleBotUsername,
} = require("./billing");
const {
  BOT_TYPES,
  removeGeneratedBotFile,
  writeGeneratedBotFile,
} = require("./bots/generated-file");
const {
  registerAdminPanel,
  registerSubscriptionGate,
} = require("./bots/admin-panel");
const normalizeBotType = require("./bots/normalize-bot-type");

const {
  TELEGRAM_BOT_TOKEN,
  MONGODB_URI,
  TOKEN_SECRET,
  CRON_SECRET,
  PORT = 3000,
} = process.env;
const PUBLIC_API_URL =
  process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || "";
const PUBLIC_PATH_PREFIX = (() => {
  try {
    const pathname = new URL(PUBLIC_API_URL).pathname.replace(/\/+$/, "");
    return pathname === "/" ? "" : pathname;
  } catch {
    return "";
  }
})();
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter(Boolean);
const MAX_BOTS = Number(process.env.MAX_BOTS_PER_USER || 3);

for (const [k, v] of Object.entries({
  TELEGRAM_BOT_TOKEN,
  MONGODB_URI,
  TOKEN_SECRET,
  CRON_SECRET,
})) {
  if (!v) {
    console.error(`${k} o'zgaruvchisi berilmagan (.env.example ga qarang)`);
    process.exit(1);
  }
}
if (!Number.isInteger(MAX_BOTS) || MAX_BOTS < 1) {
  console.error("MAX_BOTS_PER_USER musbat butun son bo'lishi kerak");
  process.exit(1);
}

/* ---------- Token shifrlash (AES-256-GCM) ---------- */
const KEY = crypto.createHash("sha256").update(TOKEN_SECRET).digest();
const encrypt = (text) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
};
const decrypt = (s) => {
  const [iv, tag, enc] = s.split(".").map((p) => Buffer.from(p, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
};

/* ---------- Umumiy yordamchilar ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAdmin = (id) => ADMIN_IDS.includes(id);
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const back = (to, text = "⬅️ Orqaga") => [{ text, callback_data: to }];
const fullAdminRights = () => ({
  can_manage_chat: true,
  can_delete_messages: true,
  can_manage_video_chats: true,
  can_restrict_members: true,
  can_promote_members: true,
  can_change_info: true,
  can_invite_users: true,
  can_post_messages: true,
  can_edit_messages: true,
  can_pin_messages: true,
  can_manage_topics: true,
});

let Bots, Users, Subs, FooterSettings, WatermarkProfiles, UserSchedulerUsers;
let PlatformSettings, Topups, BalanceTransactions, billingService, ConstructorDb;
let constructorGate = null;
const getConstructorGateChats = () => {
  if (!constructorGate) return [];
  if (Array.isArray(constructorGate.chats)) return constructorGate.chats;
  if (constructorGate.chatId) {
    return [{ chatId: constructorGate.chatId, title: constructorGate.title, link: constructorGate.link }];
  }
  return [];
};
const children = new Map(); // botId -> ishlayotgan mijoz bot runtime
const childPolls = new Set();
const guardWebhooks = new Map(); // webhook pathname -> grammY HTTP handler
const states = new Map(); // userId -> kutilayotgan kiritish holati

/* ---------- Mijoz botlarini ishga tushirish ---------- */
async function buildChild(doc) {
  if (!BOT_TYPES[doc.type]) throw new Error("Noma'lum tayyor bot turi.");
  if (doc.type === "guard") {
    if (!PUBLIC_API_URL) {
      throw new Error(
        "Guard Bot webhook'i uchun ommaviy HTTPS URL topilmadi. Render'da RENDER_EXTERNAL_URL avtomatik beriladi; boshqa hostingda PUBLIC_API_URL kiriting.",
      );
    }
    const publicUrl = new URL(PUBLIC_API_URL);
    if (publicUrl.protocol !== "https:") {
      throw new Error("Guard Bot webhook'i uchun PUBLIC_API_URL HTTPS bo'lishi kerak.");
    }
    if (publicUrl.search || publicUrl.hash) {
      throw new Error("PUBLIC_API_URL query yoki fragment qismini o'z ichiga olmasin.");
    }
    if (!doc.webhookSecret) {
      doc.webhookSecret = crypto.randomBytes(32).toString("hex");
      await Bots.updateOne(
        { _id: doc._id },
        { $set: { webhookSecret: doc.webhookSecret } },
      );
    }
    if (!/^[\w-]{1,256}$/.test(doc.webhookSecret)) {
      throw new Error("Guard Bot webhook secret formati noto'g'ri.");
    }
    const runtime = createGuardBot(decrypt(doc.token), {
      botId: doc._id,
      database: await getGuardDatabase(),
    });
    await runtime.initialize();
    runtime.config = doc;
    const pathPrefix = publicUrl.pathname.replace(/\/+$/, "");
    runtime.webhookPath = `${pathPrefix}/webhook/guard/${doc._id}/${doc.webhookSecret}`;
    runtime.isWebhook = true;
    runtime.stop = () => runtime.cleanup();
    return runtime;
  }

  const filePath = await writeGeneratedBotFile(doc);
  const generated = require(filePath);
  if (generated.botId !== Number(doc._id)) {
    throw new Error("Yaratilgan bot fayli ID'si mos kelmadi.");
  }

  const child = new BotConstructor(decrypt(doc.token));
  child.config = doc;
  const templateControls = generated.register(child, {
    doc,
    Bots,
    Subs,
    Settings: FooterSettings,
    WatermarkProfiles,
    SmmUsers: ConstructorDb.collection(`smm_users_${doc._id}`),
    SmmOrders: ConstructorDb.collection(`smm_orders_${doc._id}`),
    SmmTopups: ConstructorDb.collection(`smm_topups_${doc._id}`),
    UserSchedulerUsers,
    encryptSecret: encrypt,
    decryptSecret: decrypt,
    publicApiBaseUrl: PUBLIC_API_URL,
  });
  child.templateControls = templateControls;
  if (typeof templateControls?.handleApiRequest === "function") {
    child.handleSmmApiRequest = templateControls.handleApiRequest;
  }
  if (typeof templateControls?.handleApiRequest === "function" && doc.type === "user-scheduler") {
    child.handleUserSchedulerApiRequest = templateControls.handleApiRequest;
  }
  registerSubscriptionGate(child, { doc, Subs });
  registerAdminPanel(child, {
    doc,
    Bots,
    Subs,
    onCancel: templateControls?.cancelPending,
  });
  return child;
}

async function startChild(doc) {
  if (children.has(doc._id) || doc.banned || doc.billingStatus === "suspended") return;
  const child = await buildChild(doc);
  if (child.isWebhook) {
    const callback = webhookCallback(child.bot, "http", {
      secretToken: doc.webhookSecret,
    });
    guardWebhooks.set(child.webhookPath, callback);
    try {
      await child.bot.api.setWebhook(
        `${new URL(PUBLIC_API_URL).origin}${child.webhookPath}`,
        {
          secret_token: doc.webhookSecret,
          allowed_updates: ["message", "callback_query", "my_chat_member"],
        },
      );
      children.set(doc._id, child);
    } catch (error) {
      guardWebhooks.delete(child.webhookPath);
      child.stop();
      throw error;
    }
    return;
  }

  try {
    await child.deleteWebhook();
    await child.templateControls?.start?.();
  } catch (error) {
    try {
      await child.templateControls?.stop?.();
    } catch (stopError) {
      console.error(`@${doc.username} runtime to'xtamadi:`, stopError.message);
    }
    throw error;
  }
  children.set(doc._id, child);
  child.polling = child.launch();
  childPolls.add(child.polling);
  child.polling.then(
    () => {
      childPolls.delete(child.polling);
      if (children.get(doc._id) === child) children.delete(doc._id);
    },
    (error) => {
      childPolls.delete(child.polling);
      if (children.get(doc._id) === child) children.delete(doc._id);
      console.error(`Bot ${doc.username} to'xtadi:`, error.message);
    },
  );
  await child.api("setMyCommands", {
    commands: [
      { command: "start", description: "Boshlash" },
      { command: "admin", description: "Admin panel" },
      { command: "cancel", description: "Amalni bekor qilish" },
    ],
  }).catch((error) => {
    console.error(`@${doc.username} komandalarini sozlab bo'lmadi:`, error.message);
  });
}

function stopChild(id) {
  const c = children.get(id);
  if (c) {
    if (c.webhookPath) {
      guardWebhooks.delete(c.webhookPath);
      c.bot.api.deleteWebhook().catch((error) => {
        console.error(`@${c.config.username} webhook'ini o'chirib bo'lmadi:`, error.message);
      });
    }
    let templateStop;
    try {
      templateStop = Promise.resolve(c.templateControls?.stop?.());
    } catch (error) {
      templateStop = Promise.reject(error);
    }
    templateStop.catch((error) => {
      console.error(`@${c.config.username} runtime resurslarini yopib bo'lmadi:`, error.message);
    });
    c.stop();
    children.delete(id);
    return templateStop;
  }
  return Promise.resolve();
}

async function createBot(ownerId, botType, token) {
  if (!BOT_TYPES[botType]) throw new Error("Avval tayyor bot turini tanlang.");
  const billingSettings = getBillingSettings(
    (await PlatformSettings.findOne({ _id: "billing" })) || {},
  );
  if (!billingSettings.prices[botType].enabled) {
    throw new Error("Bu bot turi hozircha yangi foydalanuvchilar uchun yopiq.");
  }
  if (!isAdmin(ownerId) && (await Bots.countDocuments({ ownerId })) >= MAX_BOTS) {
    throw new Error(`Siz maksimal ${MAX_BOTS} ta bot yarata olasiz.`);
  }
  if (!/^\d{6,}:[\w-]{30,}$/.test(token)) throw new Error("Token formati noto'g'ri.");
  let info;
  try {
    info = await new BotConstructor(token).api("getMe");
  } catch {
    throw new Error("Token ishlamadi. BotFather'dan to'g'ri token oling.");
  }
  if (await Bots.findOne({ _id: info.id })) throw new Error("Bu bot allaqachon ulangan.");

  const doc = {
    _id: info.id,
    token: encrypt(token),
    username: info.username,
    ownerId,
    type: botType,
    ...(botType === "guard"
      ? { webhookSecret: crypto.randomBytes(32).toString("hex") }
      : {}),
    welcome:
      botType === "smm"
        ? "Nakrutka/SMM xizmatlariga buyurtma berish botiga xush kelibsiz!"
        : botType === "qr"
        ? "Matn yoki havola yuboring — QR-kod yarataman. QR-kodni rasm sifatida yuborsangiz, ichidagi matnni o'qiyman."
        : botType === "nickname"
          ? "Nickname yoki matn yuboring — 17 xil bezatilgan yozuv variantini tayyorlayman."
          : botType === "footer"
            ? "Kanal postlariga o'z matningizni avtomatik qo'shing."
            : botType === "watermark"
              ? "Logo, rasm o'lchami va watermark joyini tanlab, rasmingizga belgi qo'shing."
              : botType === "guard"
                ? "Guruhni captcha va spamdan himoyalash uchun Telegram Qorovul Bot."
                : botType === "user-scheduler"
                  ? "Telegram akkauntingizni ulang va a'zo bo'lgan guruh/kanallarga postlarni jadval bilan yuboring."
                  : "Fayl yuboring — nomi, rasmi va MP3 ma'lumotlarini tahrirlayman.",
    requiredChannel: null,
    banned: false,
    billingStatus: "trial",
    trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    initialFeePaid: false,
    pricing: {
      initial: billingSettings.prices[botType].initial,
      monthly: billingSettings.prices[botType].monthly,
    },
    ...(botType === "smm"
      ? {
          smmApiUrl: process.env.SMM_API_URL || "",
          smmApiKey: process.env.SMM_API_KEY || "",
          smmUsdRate: Number(process.env.SMM_USD_RATE || 12700),
          smmMarkupPercent: Number(process.env.SMM_MARKUP_PERCENT || 30),
          smmCardNumber: process.env.SMM_CARD_NUMBER || "",
          smmCardOwner: process.env.SMM_CARD_OWNER || "",
        }
      : {}),
    createdAt: new Date(),
  };
  await Bots.insertOne(doc);
  try {
    await startChild(doc);
  } catch (error) {
    await Bots.deleteOne({ _id: doc._id, ownerId });
    await Subs.deleteMany({ botId: doc._id });
    await removeGeneratedBotFile(doc._id).catch((cleanupError) => {
      console.error("Yaratilgan bot faylini tozalab bo'lmadi:", cleanupError.message);
    });
    throw new Error(`Bot ishga tushmadi: ${error.message}`);
  }
  return doc;
}

async function broadcast(bot, coll, filter, field, text) {
  let ok = 0;
  let fail = 0;
  for await (const d of coll.find(filter)) {
    try {
      await bot.sendMessage(d[field], text);
      ok++;
    } catch {
      fail++;
    }
    await sleep(50); // Telegram limiti: ~30 xabar/soniya
  }
  return { ok, fail };
}

async function readSmmApiBody(request) {
  const contentType = String(request.headers["content-type"] || "")
    .split(";", 1)[0].trim().toLowerCase();
  if (!["application/json", "application/x-www-form-urlencoded"].includes(contentType)) {
    const error = new Error("Content-Type JSON yoki form-urlencoded bo'lishi kerak.");
    error.statusCode = 415;
    throw error;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) {
      const error = new Error("So'rov hajmi juda katta.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const value = contentType === "application/json"
      ? JSON.parse(raw)
      : Object.fromEntries(new URLSearchParams(raw));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Object expected.");
    }
    return value;
  } catch {
    const error = new Error("So'rov tanasi noto'g'ri formatda.");
    error.statusCode = 400;
    throw error;
  }
}

async function readUserSchedulerApiBody(request) {
  const contentType = String(request.headers["content-type"] || "")
    .split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("Content-Type application/json bo'lishi kerak.");
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) {
      const error = new Error("So'rov hajmi juda katta.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Object expected.");
    }
    return body;
  } catch {
    const error = new Error("So'rov tanasi noto'g'ri formatda.");
    error.statusCode = 400;
    throw error;
  }
}

async function startHealthServer(mother) {
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    const routePath = PUBLIC_PATH_PREFIX && pathname.startsWith(`${PUBLIC_PATH_PREFIX}/`)
      ? pathname.slice(PUBLIC_PATH_PREFIX.length)
      : pathname;
    const guardWebhook = guardWebhooks.get(pathname);
    if (guardWebhook) {
      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" });
        response.end();
        return;
      }
      try {
        await guardWebhook(request, response);
      } catch (error) {
        console.error("Guard Bot webhook update xatosi:", error.message);
        if (!response.headersSent) {
          response.writeHead(500);
          response.end("Webhook update bajarilmadi.");
        }
      }
      return;
    }

    if (routePath === "/user-scheduler/mini-app.js") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }
      try {
        const script = await fs.readFile(
          path.join(__dirname, "bots", "user-scheduler", "mini-app.js"),
        );
        response.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'",
        });
        response.end(script);
      } catch (error) {
        console.error("User Bot Mini App skriptini o'qib bo'lmadi:", error.message);
        response.writeHead(500);
        response.end("Mini App fayli mavjud emas.");
      }
      return;
    }

    const miniAppMatch = routePath.match(/^\/user-scheduler\/app\/(\d+)$/);
    if (miniAppMatch) {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }
      try {
        const page = await fs.readFile(
          path.join(__dirname, "bots", "user-scheduler", "mini-app.html"),
        );
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'",
        });
        response.end(page);
      } catch (error) {
        console.error("User Bot Mini App sahifasini o'qib bo'lmadi:", error.message);
        response.writeHead(500);
        response.end("Mini App sahifasi mavjud emas.");
      }
      return;
    }

    const userLoginMatch = routePath.match(
      /^\/user-scheduler\/api\/(\d+)\/(status|start|code|password|email|email-code|cancel)$/,
    );
    if (userLoginMatch) {
      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" });
        response.end();
        return;
      }
      const child = children.get(Number(userLoginMatch[1]));
      if (typeof child?.handleUserSchedulerApiRequest !== "function") {
        response.writeHead(404, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ error: "User Bot topilmadi yoki ishlamayapti." }));
        return;
      }
      try {
        const body = await readUserSchedulerApiBody(request);
        const result = await child.handleUserSchedulerApiRequest(userLoginMatch[2], body);
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(JSON.stringify(result));
      } catch (error) {
        const statusCode = error.statusCode || 500;
        if (statusCode >= 500) {
          console.error("User Bot Mini App API xatosi:", error.name);
        }
        response.writeHead(statusCode, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(JSON.stringify({
          error: error.statusCode ? error.message : "Ichki server xatosi.",
        }));
      }
      return;
    }

    const smmApiMatch = pathname.match(/^\/api\/smm\/(\d+)\/v2$/);
    if (smmApiMatch) {
      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" });
        response.end();
        return;
      }
      const child = children.get(Number(smmApiMatch[1]));
      if (typeof child?.handleSmmApiRequest !== "function") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "SMM API topilmadi yoki bot ishlamayapti." }));
        return;
      }
      try {
        const params = await readSmmApiBody(request);
        const result = await child.handleSmmApiRequest(params);
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify(result));
      } catch (error) {
        const statusCode = error.statusCode || 500;
        if (statusCode >= 500) {
          console.error("SMM tashqi API xatosi:", error.message);
        }
        response.writeHead(statusCode, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({
          error: error.statusCode ? error.message : "Ichki server xatosi.",
        }));
      }
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end();
      return;
    }
    if (pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (pathname !== "/health" && pathname !== "/cron") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    if (pathname === "/cron") {
      const url = new URL(request.url || "/", "http://localhost");
      const authorization = request.headers.authorization || "";
      const bearerSecret = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : "";
      const suppliedSecret = Buffer.from(
        request.headers["x-cron-secret"] ||
        bearerSecret ||
        url.searchParams.get("secret") ||
        "",
      );
      const expectedSecret = Buffer.from(CRON_SECRET);
      if (
        suppliedSecret.length !== expectedSecret.length ||
        !crypto.timingSafeEqual(suppliedSecret, expectedSecret)
      ) {
        response.writeHead(401);
        response.end("Unauthorized");
        return;
      }
    }
    if (!mother.running) {
      response.writeHead(pathname === "/cron" ? 202 : 503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ status: "starting", ...(pathname === "/cron" ? { retry: true } : {}) }));
      return;
    }

    try {
      await mother.db.command({ ping: 1 });
      const billing = pathname === "/cron"
        ? await billingService.processDueBots()
        : undefined;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", ...(billing ? { billing } : {}) }));
    } catch (error) {
      console.error("Health check MongoDB xatosi:", error.message);
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "unavailable" }));
    }
  });

  const port = Number(PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT 1–65535 oralig'idagi butun son bo'lishi kerak");
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  return server;
}

/* ---------- Ko'rinishlar (matn + tugmalar) ---------- */
const mainMenu = (id) => [
  "👋 Konstruktor botga xush kelibsiz!\nBu yerda o'z Telegram botingizni kodsiz yaratasiz.",
  kb([
    [{ text: "➕ Bot yaratish", callback_data: "new" }],
    [{ text: "🤖 Botlarim", callback_data: "my" }],
    [{ text: "💰 Balans", callback_data: "balance" }],
    [{ text: "👤 Profil", callback_data: "profile" }],
    ...(isAdmin(id) ? [[{ text: "🛠 Admin panel", callback_data: "adm" }]] : []),
  ]),
];

const botPanel = (b) => [
  `🤖 @${b.username}\n` +
    `Holati: ${b.banned ? "🚫 bloklangan" : children.has(b._id) ? "✅ ishlayapti" : "⏸ to'xtagan"}\n` +
    `Turi: ${BOT_TYPES[b.type]?.label || "Noma'lum"}\n\n` +
    (b.billingStatus === "trial"
      ? `🎁 Bepul sinov: ${Math.max(0, Math.ceil((b.trialEndsAt - Date.now()) / 86400000))} kun qoldi\n`
      : b.nextBillingAt
        ? `💳 Keyingi oylik to'lov: ${new Date(b.nextBillingAt).toLocaleDateString("uz-UZ")}\n`
        : "") +
    (b.pricing
      ? `Tarif: ${b.pricing.initial.toLocaleString("uz-UZ")} + ${b.pricing.monthly.toLocaleString("uz-UZ")} so'm/oy\n\n`
      : "") +
    (b.type === "guard"
      ? "Guruhga qo'shib administrator qiling, so'ng guruh egasi /claim yuborsin. Panelni bot bilan shaxsiy chatdagi /start orqali oching."
      : b.type === "footer"
      ? "Tag matni va kanalni sozlash uchun bot ichida /start bosing.\nAdmin panel: /admin."
      : b.type === "watermark"
        ? "Logo, rasm o'lchami va watermark joyini tanlash uchun bot ichida /start bosing.\nAdmin panel: /admin."
        : b.type === "file-editor"
          ? "Fayl yuborib nomi yoki rasmini o'zgartiring. MP3 uchun ijrochi va musiqa nomi ham tahrirlanadi."
          : b.type === "image-text"
            ? "Uzum shabloniga O'tkazildi ostidagi 10 000 quti va mahsulot ma'lumotini qo'shish uchun /start yuboring."
            : "Bot tayyor. Boshqaruv uchun botning o'zida /admin buyrug'ini yuboring."),
  kb([
    [{ text: "🗑 O'chirish", callback_data: `del:${b._id}` }],
    back("my"),
  ]),
];

async function show(ctx, text, extra = {}) {
  try {
    await ctx.edit(text, extra);
  } catch (e) {
    if (!/not modified/i.test(e.message)) await ctx.reply(text, extra).catch(() => {});
  }
}

async function getOwned(ctx, id) {
  const b = await Bots.findOne({ _id: Number(id) });
  if (!b || (b.ownerId !== ctx.from.id && !isAdmin(ctx.from.id))) return null;
  return b;
}

/* ---------- Asosiy ---------- */
async function main() {
  const mother = new BotConstructor(TELEGRAM_BOT_TOKEN);
  await mother.connectDatabase(MONGODB_URI);
  ConstructorDb = mother.db;
  Bots = mother.collection("bots");
  Users = mother.collection("users");
  Subs = mother.collection("subscribers");
  UserSchedulerUsers = mother.collection("user_scheduler_users");
  FooterSettings = mother.collection("channel_footer_settings");
  WatermarkProfiles = mother.collection("watermark_profiles");
  PlatformSettings = mother.collection("platform_settings");
  Topups = mother.collection("balance_topups");
  BalanceTransactions = mother.collection("balance_transactions");
  await Subs.createIndex({ botId: 1, userId: 1 }, { unique: true });
  await UserSchedulerUsers.createIndex(
    { botId: 1, userId: 1 },
    { unique: true },
  );
  await UserSchedulerUsers.createIndex({ botId: 1, "userSchedule.enabled": 1 });
  await Bots.createIndex({ ownerId: 1 });
  await FooterSettings.createIndex({ botId: 1 }, { unique: true });
  await FooterSettings.createIndex({ channelId: 1 });
  await WatermarkProfiles.createIndex(
    { botId: 1, userId: 1 },
    { unique: true },
  );
  await Topups.createIndex({ payload: 1 }, { unique: true, sparse: true });
  await Topups.createIndex({ ownerId: 1, status: 1, createdAt: -1 });
  await BalanceTransactions.createIndex({ reference: 1 }, { unique: true });
  await BalanceTransactions.createIndex({ ownerId: 1, createdAt: -1 });
  constructorGate =
    (await PlatformSettings.findOne({ _id: "constructor_gate" })) || null;
  const blockedUsers = new Set(
    (await Users.find({ blocked: true }, { projection: { _id: 1 } }).toArray())
      .map((user) => user._id),
  );
  billingService = new BillingService({
    client: mother.mongoClient,
    Bots,
    Users,
    Topups,
    BalanceTransactions,
    PlatformSettings,
    stopChild,
    startChild,
    notifyOwner: async (ownerId, text) => {
      try {
        await mother.sendMessage(ownerId, text);
      } catch (error) {
        console.error(`Foydalanuvchi ${ownerId} ga billing xabari yuborilmadi:`, error.message);
      }
    },
  });
  const healthServer = await startHealthServer(mother);
  const getPlatformBilling = async () =>
    getBillingSettings((await PlatformSettings.findOne({ _id: "billing" })) || {});
  const sendStarsInvoice = async (ctx, stars) => {
    if (!Number.isSafeInteger(stars) || stars < 10) {
      throw new Error("Stars miqdori kamida 10 bo'lgan butun son bo'lishi kerak.");
    }
    const settings = await getPlatformBilling();
    const amount = Math.floor(
      stars * settings.stars.amount / settings.stars.count,
    );
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error("Stars kursi admin panelida noto'g'ri sozlangan.");
    }
    const payload = `stars_${crypto.randomBytes(16).toString("hex")}`;
    await Topups.insertOne({
      ownerId: ctx.from.id,
      method: "stars",
      status: "pending",
      payload,
      currency: "XTR",
      stars,
      amount,
      createdAt: new Date(),
    });
    try {
      await mother.api("sendInvoice", {
        chat_id: ctx.chat.id,
        title: "Konstruktor bot balansi",
        description: `${stars} Stars evaziga ${money(amount)} balans.`,
        payload,
        provider_token: "",
        currency: "XTR",
        prices: [{ label: "Balans", amount: stars }],
      });
    } catch (error) {
      await Topups.updateOne(
        { payload, status: "pending" },
        { $set: { status: "failed", error: error.message } },
      );
      throw error;
    }
  };
  const savePlatformBilling = async (settings) =>
    PlatformSettings.updateOne(
      { _id: "billing" },
      {
        $set: {
          prices: settings.prices,
          stars: settings.stars,
          paymentInstructions: settings.paymentInstructions,
          sampleBots: settings.sampleBots,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  const money = (amount) => `${Number(amount || 0).toLocaleString("uz-UZ")} so'm`;
  const settleOwnerBilling = async (ownerId) => {
    try {
      await billingService.processDueBots(ownerId);
    } catch (error) {
      console.error(`Foydalanuvchi ${ownerId} billingini yangilab bo'lmadi:`, error.message);
      await mother.sendMessage(
        ownerId,
        "Balans to'ldirildi, ammo to'lov muddati kelgan botni qayta yoqishda xato yuz berdi. Tizim cron orqali qayta urinadi.",
      ).catch((notifyError) => {
        console.error("Billing xato xabari yuborilmadi:", notifyError.message);
      });
    }
  };

  const tariffPanel = async () => {
    const settings = await getPlatformBilling();
    const lines = Object.entries(BOT_TYPES).map(([type, definition]) => {
      const price = settings.prices[type];
      return `${price.enabled ? "🛒 Marketda" : "➖ Marketdan olingan"} — ${definition.label}: ` +
        `${money(price.initial)} boshlang'ich + ${money(price.monthly)}/oy · ` +
        `Namuna: ${settings.sampleBots[type] ? `@${settings.sampleBots[type]}` : "yo'q"}`;
    });
    return [
      `💳 Tariflar\n\n${lines.join("\n")}\n\n` +
        `⭐ ${settings.stars.count} Stars = ${money(settings.stars.amount)}\n` +
        `To'lov ko'rsatmasi: ${settings.paymentInstructions ? "sozlangan" : "sozlanmagan"}`,
      kb([
        ...Object.entries(BOT_TYPES).flatMap(([type, definition]) => [
          [
            { text: `💵 ${definition.label}`, callback_data: `adm_price:${type}` },
            {
              text: settings.prices[type].enabled
                ? "➖ Marketdan olish"
                : "🛒 Marketga qo'yish",
              callback_data: `adm_toggle:${type}`,
            },
          ],
          [
            {
              text: settings.sampleBots[type] ? "🧪 Namunani o'zgartirish" : "🧪 Namuna bot",
              callback_data: `adm_sample:${type}`,
            },
          ],
        ]),
        [{ text: "⭐ Stars kursi", callback_data: "adm_stars" }],
        [{ text: "💳 To'lov ko'rsatmasi", callback_data: "adm_payinfo" }],
        back("adm"),
      ]),
    ];
  };
  const getUserProfile = async (userId) => {
    const [user, bots] = await Promise.all([
      Users.findOne({ _id: userId }),
      Bots.find({ ownerId: userId }).sort({ createdAt: -1 }).toArray(),
    ]);
    return {
      user,
      bots,
      activeBots: bots.filter((bot) => children.has(bot._id)).length,
    };
  };
  const userProfileView = async (userId, adminView = false) => {
    const profile = await getUserProfile(userId);
    if (!profile.user && !profile.bots.length) return null;
    const displayName = profile.user?.username
      ? `@${profile.user.username}`
      : profile.user?.name || "Foydalanuvchi";
    const status = profile.user?.blocked ? "🚫 bloklangan" : "✅ faol";
    return [
      `${adminView ? "👤 Foydalanuvchi" : "👤 Profil"}\n` +
        `Ism: ${displayName}\n` +
        `🆔 ID: ${userId}\n` +
        `💰 Balans: ${money(profile.user?.balance)}\n` +
        `🤖 Ishlayotgan botlar: ${profile.activeBots}/${profile.bots.length}` +
        (adminView ? `\nHolati: ${status}` : ""),
      adminView
        ? kb([
            [
              { text: "💰 Balansni o'zgartirish", callback_data: `adm_user_balance:${userId}` },
              { text: "✉️ Xabar yuborish", callback_data: `adm_user_msg:${userId}` },
            ],
            ...(isAdmin(userId)
              ? []
              : [[{
                  text: profile.user?.blocked ? "♻️ Blokdan chiqarish" : "🚫 Foydalanuvchini bloklash",
                  callback_data: `adm_user_block:${userId}`,
                }]]),
            [{ text: `🤖 Botlari (${profile.bots.length})`, callback_data: `adm_user_bots:${userId}:0` }],
            back("adm"),
          ])
        : kb([
            [{ text: "🤖 Botlarim", callback_data: "my" }],
            [{ text: "💰 Balans", callback_data: "balance" }],
            back("menu"),
          ]),
    ];
  };

  // Callback yordamchisi: spinnerni o'chiradi, xatolarni ushlaydi
  const cb = (pattern, fn, adminOnly = false) =>
    mother.onCallbackData(pattern, async (ctx) => {
      await ctx.answer().catch(() => {});
      if (adminOnly && !isAdmin(ctx.from.id)) return;
      try {
        await fn(ctx, ctx.text.match(pattern));
      } catch (e) {
        console.error(e);
        await ctx.reply("❌ Xatolik: " + e.message).catch(() => {});
      }
    });

  const recentUserWrites = new Map();
  mother.use(async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    if (
      blockedUsers.has(userId) &&
      !isAdmin(userId) &&
      (ctx.chat?.type === "private" || ctx.preCheckoutQuery)
    ) {
      ctx.handled = true;
      if (ctx.preCheckoutQuery) {
        await ctx.answerPreCheckout(false, "Ushbu botdan foydalanish cheklangan.")
          .catch((error) => console.error("To'lovni rad qilib bo'lmadi:", error.message));
      } else if (ctx.callbackQuery) {
        await ctx.answer({ text: "Ushbu botdan foydalanish cheklangan." })
          .catch((error) => console.error("Bloklangan callback'ni yopib bo'lmadi:", error.message));
      } else {
        await ctx.reply("🚫 Ushbu botdan foydalanish cheklangan.");
      }
      return;
    }
    if (ctx.chat?.type !== "private") return;
    const constructorGateChats = getConstructorGateChats();
    if (!isAdmin(userId) && constructorGateChats.length) {
      const missingChats = [];
      for (const chat of constructorGateChats) {
        try {
          const member = await mother.api("getChatMember", {
            chat_id: chat.chatId,
            user_id: userId,
          });
          const isMember = ["creator", "administrator", "member"].includes(member.status) ||
            (member.status === "restricted" && member.is_member);
          if (!isMember) missingChats.push(chat);
        } catch (error) {
          missingChats.push(chat);
        }
      }
      if (missingChats.length) {
          ctx.handled = true;
          await ctx.reply(
            "Botdan foydalanish uchun barcha majburiy kanal va guruhlarga obuna bo'ling:",
            kb([
              ...missingChats.map((chat, index) => [{
                text: `📢 ${index + 1}. ${String(chat.title).slice(0, 45)}`,
                url: chat.link,
              }]),
              [{ text: "✅ Obunani tekshirish", callback_data: "constructor_gate_check" }],
            ]),
          );
          return;
        }
    }
    const name = ctx.from.first_name;
    const username = ctx.from.username || null;
    const recent = recentUserWrites.get(userId);
    if (
      recent &&
      recent.name === name &&
      recent.username === username &&
      Date.now() - recent.savedAt < 5 * 60 * 1000
    ) {
      return;
    }
    try {
      const result = await Users.updateOne(
        { _id: userId },
        {
          $set: { name, username },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );
      if (result.upsertedCount > 0 && !isAdmin(userId)) {
        const label = username ? `@${username}` : name || `ID ${userId}`;
        for (const adminId of ADMIN_IDS) {
          await mother.sendMessage(
            adminId,
            `👤 Yangi foydalanuvchi qo'shildi\n${label}\nTelegram ID: ${userId}`,
          ).catch((error) =>
            console.error(`Yangi foydalanuvchi haqida adminga xabar yuborib bo'lmadi:`, error.message),
          );
        }
      }
      recentUserWrites.set(userId, { name, username, savedAt: Date.now() });
      if (recentUserWrites.size > 5000) {
        recentUserWrites.delete(recentUserWrites.keys().next().value);
      }
    } catch (error) {
      console.error("Foydalanuvchini saqlab bo'lmadi:", error.message);
    }
  });

  const notifyTopupAdmins = async (topup, user, receiptMessage) => {
    const userLabel = user?.username ? `@${user.username}` : `ID ${topup.ownerId}`;
    for (const adminId of ADMIN_IDS) {
      let receiptMessageId;
      if (receiptMessage?.photo) {
        try {
          const forwarded = await mother.api("forwardMessage", {
            chat_id: adminId,
            from_chat_id: topup.ownerId,
            message_id: receiptMessage.message_id,
          });
          receiptMessageId = forwarded.message_id;
        } catch (error) {
          console.error("To'lov chekini adminga uzatib bo'lmadi:", error.message);
          try {
            const photo = await mother.api("sendPhoto", {
              chat_id: adminId,
              photo: topup.receipt?.fileId || receiptMessage.photo.at(-1).file_id,
              caption: `🧾 Chek — ${userLabel} (${topup.ownerId}), ${money(topup.amount)}`,
            });
            receiptMessageId = photo.message_id;
          } catch (photoError) {
            console.error("To'lov chekini admin chatiga yuborib bo'lmadi:", photoError.message);
          }
        }
      }
      const notice = await mother.sendMessage(
        adminId,
        `💳 Yangi balans to'ldirish so'rovi\n` +
          `Foydalanuvchi: ${userLabel} (${topup.ownerId})\n` +
          `Summa: ${money(topup.amount)}\n` +
          ((receiptMessage?.text || receiptMessage?.caption)
            ? `Chek/izoh: ${(receiptMessage.text || receiptMessage.caption).slice(0, 1000)}`
            : ""),
        kb([
          [{ text: "🔎 Ko'rish", callback_data: `adm_topup:${topup._id}` }],
        ]),
      ).catch((error) => {
        console.error(`Admin ${adminId} ga to'lov xabari yuborilmadi:`, error.message);
        return null;
      });
      const messageIdToPin = receiptMessageId || notice?.message_id;
      if (messageIdToPin) {
        try {
          await mother.api("pinChatMessage", {
            chat_id: adminId,
            message_id: messageIdToPin,
            disable_notification: true,
          });
        } catch (error) {
          console.error(`Admin ${adminId} chatida chekni pin qilib bo'lmadi:`, error.message);
        }
      }
    }
  };

  const submitManualReceipt = async (ctx, receiptMessage) => {
    const state = states.get(ctx.from.id);
    if (state?.type !== "manual_receipt") return false;
    const topupId = new ObjectId(state.topupId);
    const receipt = receiptMessage.photo
      ? {
          type: "photo",
          fileId: receiptMessage.photo.at(-1).file_id,
          caption: (receiptMessage.caption || "").slice(0, 1000),
        }
      : { type: "text", text: (receiptMessage.text || "").trim().slice(0, 1000) };
    if (receipt.type === "text" && !receipt.text) {
      await ctx.reply("Chek raqami yoki to'lov izohini yuboring.");
      return true;
    }

    const result = await Topups.updateOne(
      { _id: topupId, ownerId: ctx.from.id, status: "awaiting_receipt" },
      { $set: { status: "pending", receipt, submittedAt: new Date() } },
    );
    if (!result.modifiedCount) {
      states.delete(ctx.from.id);
      await ctx.reply("Bu to'ldirish so'rovi topilmadi yoki allaqachon yuborilgan.");
      return true;
    }

    states.delete(ctx.from.id);
    const topup = await Topups.findOne({ _id: topupId });
    const user = await Users.findOne({ _id: ctx.from.id });
    await notifyTopupAdmins(topup, user, receiptMessage);
    await ctx.reply("✅ Chek adminga yuborildi. Tasdiqlangach balansingizga qo'shiladi.");
    return true;
  };

  mother.onUpdate("message", async (ctx) => {
    const gateState = ctx.from ? states.get(ctx.from.id) : null;
    if (
      ctx.chat?.type === "private" &&
      isAdmin(ctx.from?.id) &&
      gateState?.type === "adm_gate_select" &&
      ctx.message.chat_shared
    ) {
      try {
        const chat = await mother.api("getChat", { chat_id: ctx.message.chat_shared.chat_id });
        if (!["channel", "group", "supergroup"].includes(chat.type)) {
          throw new Error("Faqat kanal yoki guruh tanlanishi kerak.");
        }
        const botMember = await mother.api("getChatMember", {
          chat_id: chat.id,
          user_id: ctx.me?.id ?? (await mother.api("getMe")).id,
        });
        if (!["administrator", "creator"].includes(botMember.status)) {
          throw new Error("Bot tanlangan kanal yoki guruhga to'liq admin huquqi bilan qo'shilishi kerak.");
        }
        let link = chat.username ? `https://t.me/${chat.username}` : chat.invite_link;
        if (!link) {
          try {
            link = await mother.api("exportChatInviteLink", { chat_id: chat.id });
          } catch {
            link = `tg://resolve?domain=`;
          }
        }
        const selectedChat = {
          chatId: chat.id,
          title: chat.title || chat.username || String(chat.id),
          link,
        };
        const chats = getConstructorGateChats().filter(
          (item) => String(item.chatId) !== String(chat.id),
        );
        chats.push(selectedChat);
        constructorGate = {
          chats,
          chatId: selectedChat.chatId,
          title: selectedChat.title,
          link: selectedChat.link,
        };
        await PlatformSettings.updateOne(
          { _id: "constructor_gate" },
          { $set: { ...constructorGate, updatedAt: new Date() } },
          { upsert: true },
        );
        states.delete(ctx.from.id);
        await ctx.reply(
          `✅ Majburiy obuna ulandi: ${constructorGate.title}`,
          kb([
            [{ text: "🔓 Majburiy obunani o'chirish", callback_data: "adm_gate_off" }],
            back("adm"),
          ]),
        );
      } catch (error) {
        await ctx.reply(`❌ ${error.message}\nChatni qayta tanlang va botga barcha admin huquqlarini bering.`);
      }
      ctx.handled = true;
      return;
    }
    const broadcastState = ctx.from ? states.get(ctx.from.id) : null;
    if (
      ctx.chat?.type === "private" &&
      isAdmin(ctx.from?.id) &&
      broadcastState?.type === "adm_bc_media"
    ) {
      const hasMedia =
        ctx.message.photo?.length ||
        ctx.message.video ||
        ctx.message.animation ||
        ctx.message.document;
      if (hasMedia) {
        broadcastState.mediaMessageId = ctx.message.message_id;
        broadcastState.type = "adm_bc_text";
        states.set(ctx.from.id, broadcastState);
        await ctx.reply("2/3 — Premium emoji qo'llab-quvvatlaydigan matnni yuboring:");
        ctx.handled = true;
        return;
      }
    }

    if (
      ctx.chat?.type === "private" &&
      isAdmin(ctx.from?.id) &&
      broadcastState?.type === "adm_bc_text"
    ) {
      const text = ctx.message.text || ctx.message.caption;
      if (text) {
        broadcastState.textMessageId = ctx.message.message_id;
        broadcastState.type = "adm_bc_buttons";
        states.set(ctx.from.id, broadcastState);
        await ctx.reply(
          "3/3 — Inline tugma rangini tanlang:",
          kb([
            [
              { text: "Ko'k", callback_data: "adm_bc:style:primary", style: "primary" },
              { text: "Yashil", callback_data: "adm_bc:style:success", style: "success" },
            ],
            [
              { text: "Qizil", callback_data: "adm_bc:style:danger", style: "danger" },
              { text: "Standart", callback_data: "adm_bc:style:default", style: "default" },
            ],
          ]),
        );
        ctx.handled = true;
        return;
      }
    }

    if (
      ctx.chat?.type === "private" &&
      ctx.message.photo?.length &&
      states.get(ctx.from.id)?.type === "manual_receipt"
    ) {
      await submitManualReceipt(ctx, ctx.message);
      ctx.handled = true;
      return;
    }

    const state = ctx.from ? states.get(ctx.from.id) : null;
    if (
      ctx.chat?.type === "private" &&
      isAdmin(ctx.from?.id) &&
      state?.type === "adm_user_message"
    ) {
      try {
        await mother.api("copyMessage", {
          chat_id: state.userId,
          from_chat_id: ctx.chat.id,
          message_id: ctx.message.message_id,
        });
        states.delete(ctx.from.id);
        await ctx.reply(
          `✅ Xabar ID ${state.userId} foydalanuvchisiga yuborildi.`,
        );
      } catch (error) {
        console.error(`ID ${state.userId} ga admin xabarini yuborib bo'lmadi:`, error.message);
        await ctx.reply(`❌ Xabar yuborilmadi: ${error.message}`);
      }
      ctx.handled = true;
    }
  });

  mother.onUpdate("pre_checkout_query", async (ctx) => {
    const query = ctx.preCheckoutQuery;
    const topup = await Topups.findOne({
      ownerId: ctx.from.id,
      method: "stars",
      status: "pending",
      payload: query.invoice_payload,
      stars: query.total_amount,
      currency: query.currency,
    });
    if (!topup || query.currency !== "XTR") {
      await ctx.answerPreCheckout(false, "To'lov ma'lumoti eskirgan. Qaytadan urinib ko'ring.");
      return;
    }
    await ctx.answerPreCheckout(true);
  });

  mother.onUpdate("successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
    const credited = await billingService.completeStarsTopup(ctx.from.id, payment);
    if (!credited) {
      const existing = await Topups.findOne({
        ownerId: ctx.from.id,
        payload: payment.invoice_payload,
        status: "approved",
      });
      if (existing) return;
      console.error(
        `Stars to'lovi topilmadi yoki tekshiruvdan o'tmadi: user=${ctx.from.id}, payload=${payment.invoice_payload}`,
      );
      await ctx.reply("⚠️ To'lovni avtomatik tasdiqlab bo'lmadi. Admin bilan bog'laning.");
      for (const adminId of ADMIN_IDS) {
        await mother.sendMessage(
          adminId,
          `⚠️ Tekshiruv talab qiladigan Stars to'lovi: user ${ctx.from.id}, ` +
            `${payment.total_amount} Stars, payload ${payment.invoice_payload}`,
        ).catch((error) => console.error("Admin ogohlantirilmadi:", error.message));
      }
      return;
    }

    await settleOwnerBilling(ctx.from.id);
    const user = await Users.findOne({ _id: ctx.from.id });
    await ctx.reply(`✅ ${money(credited.amount)} balansingizga qo'shildi. Balans: ${money(user?.balance)}.`);
  });

  /* --- Komandalar --- */
  mother.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    states.delete(ctx.from.id);
    await ctx.reply(...mainMenu(ctx.from.id));
  });

  mother.command("cancel", async (ctx) => {
    const state = states.get(ctx.from.id);
    if (state?.type === "manual_receipt") {
      await Topups.updateOne(
        {
          _id: new ObjectId(state.topupId),
          ownerId: ctx.from.id,
          status: "awaiting_receipt",
        },
        { $set: { status: "cancelled" } },
      );
    }
    states.delete(ctx.from.id);
    await ctx.reply("Bekor qilindi.", kb([back("menu", "🏠 Menyu")]));
  });

  /* --- Foydalanuvchi menyusi --- */
  cb(/^menu$/, async (ctx) => {
    states.delete(ctx.from.id);
    await show(ctx, ...mainMenu(ctx.from.id));
  });

  cb(/^new$/, async (ctx) => {
    const count = await Bots.countDocuments({ ownerId: ctx.from.id });
    if (count >= MAX_BOTS && !isAdmin(ctx.from.id)) {
      return show(ctx, `Siz maksimal ${MAX_BOTS} ta bot yarata olasiz.`, kb([back("menu")]));
    }
    const settings = await getPlatformBilling();
    const availableTypes = Object.entries(BOT_TYPES).filter(
      ([type]) => settings.prices[type].enabled,
    );
    if (!availableTypes.length) {
      return show(ctx, "Hozircha yangi bot turlari yopiq.", kb([back("menu")]));
    }
    await show(
      ctx,
      "Bot tavsifi va namunasini ko'rish uchun turini tanlang:",
      kb([
        ...availableTypes.map(([type, definition]) => [
          {
            text: definition.label,
            callback_data: `market:${type}`,
          },
        ]),
        back("menu"),
      ]),
    );
  });

  cb(/^market:([a-z-]+)$/, async (ctx, match) => {
    const botType = match[1];
    const definition = BOT_TYPES[botType];
    const settings = await getPlatformBilling();
    if (!settings.prices[botType].enabled) {
      return show(ctx, "Bu bot turi admin tomonidan vaqtincha yopilgan.", kb([back("new")]));
    }

    const sampleBot = settings.sampleBots[botType];
    const price = settings.prices[botType];
    const rows = [];
    if (sampleBot) {
      rows.push([{ text: "🧪 Namuna botni ko'rish", url: `https://t.me/${sampleBot}` }]);
    }
    rows.push([{ text: "🤖 Shu botni yaratish", callback_data: `type:${botType}` }], back("new"));
    await show(
      ctx,
      `${definition.label}\n\n${definition.description}\n\n` +
        `Namuna bot: ${sampleBot ? `@${sampleBot}` : "admin tomonidan hali belgilanmagan"}\n` +
        `Narxi: ${money(price.initial)} boshlang'ich + ${money(price.monthly)}/oy`,
      kb(rows),
    );
  });

  cb(/^type:([a-z-]+)$/, async (ctx, match) => {
    const botType = match[1];
    if (!BOT_TYPES[botType]) return;
    const settings = await getPlatformBilling();
    if (!settings.prices[botType].enabled) {
      return show(ctx, "Bu bot turi admin tomonidan vaqtincha yopilgan.", kb([back("new")]));
    }
    if (!isAdmin(ctx.from.id) && (await Bots.countDocuments({ ownerId: ctx.from.id })) >= MAX_BOTS) {
      return show(ctx, `Siz maksimal ${MAX_BOTS} ta bot yarata olasiz.`, kb([back("menu")]));
    }
    states.set(ctx.from.id, { type: "token", botType });
    await show(
      ctx,
      `${BOT_TYPES[botType].label} tanlandi.\n` +
        "BotFather'dan olingan API tokenni yuboring. Qolgan sozlamalar avtomatik bajariladi.\n\n" +
        "Bekor qilish: /cancel",
      kb([back("new")]),
    );
  });

  cb(/^balance$/, async (ctx) => {
    states.delete(ctx.from.id);
    const user = await Users.findOne({ _id: ctx.from.id });
    const amount = Number(user?.balance) || 0;
    await show(
      ctx,
      `💰 Balansingiz: ${money(amount)}\n\n` +
        "Balansni karta orqali to'ldirish chekni admin tasdiqlagach o'tkaziladi. " +
        "Stars to'lovi esa Telegram orqali avtomatik tasdiqlanadi.",
      kb([
        [
          { text: "💳 Karta orqali", callback_data: "topup:manual" },
          { text: "⭐ Stars", callback_data: "topup:stars" },
        ],
        back("menu"),
      ]),
    );
  });

  cb(/^profile$/, async (ctx) => {
    states.delete(ctx.from.id);
    await show(ctx, ...await userProfileView(ctx.from.id));
  });

  cb(/^topup:manual$/, async (ctx) => {
    if (!ADMIN_IDS.length) {
      return show(
        ctx,
        "Qo'lda to'ldirish hozircha yoqilmagan: konstruktor admini sozlanmagan.",
        kb([back("balance")]),
      );
    }
    const settings = await getPlatformBilling();
    if (!settings.paymentInstructions) {
      return show(
        ctx,
        "Karta orqali to'lov ma'lumotlari hali admin tomonidan sozlanmagan.",
        kb([back("balance")]),
      );
    }
    states.set(ctx.from.id, { type: "topup_amount" });
    await show(
      ctx,
      "To'ldirmoqchi bo'lgan summani so'mda yuboring (faqat butun musbat son).\nBekor qilish: /cancel",
      kb([back("balance")]),
    );
  });

  cb(/^topup:stars$/, async (ctx) => {
    const settings = await getPlatformBilling();
    await show(
      ctx,
      `Balans Stars orqali to'ldiriladi. Kurs: ${settings.stars.count} Stars = ` +
        `${money(settings.stars.amount)}.\nMinimal to'lov: 10 Stars.\nMiqdorni tanlang:`,
      kb([
        ...[10, 25, 50, 100, 200, 500].map((stars) => [
          {
            text: `⭐ ${stars} Stars — ${money(
              Math.floor(stars * settings.stars.amount / settings.stars.count),
            )}`,
            callback_data: `stars:${stars}`,
          },
        ]),
        [{ text: "✏️ Boshqa miqdor", callback_data: "stars:custom" }],
        back("balance"),
      ]),
    );
  });

  cb(/^stars:(custom)$/, async (ctx) => {
    states.set(ctx.from.id, { type: "stars_amount" });
    await show(
      ctx,
      "To'ldirmoqchi bo'lgan Stars miqdorini yuboring.\nMinimal miqdor: 10 Stars.",
      kb([back("balance")]),
    );
  });

  cb(/^stars:(\d+)$/, async (ctx, match) => {
    const stars = Number(match[1]);
    if (!Number.isSafeInteger(stars) || stars < 10) {
      await ctx.reply("Stars miqdori kamida 10 bo'lgan butun son bo'lishi kerak.");
      return;
    }
    await sendStarsInvoice(ctx, stars);
  });

  cb(/^my$/, async (ctx) => {
    states.delete(ctx.from.id);
    const list = await Bots.find({ ownerId: ctx.from.id }).toArray();
    if (!list.length) {
      return show(ctx, "Sizda hali bot yo'q.", kb([[{ text: "➕ Bot yaratish", callback_data: "new" }], back("menu")]));
    }
    await show(
      ctx,
      "🤖 Botlaringiz:",
      kb([
        ...list.map((b) => [{
          text: `${BOT_TYPES[b.type]?.label || "Bot"} — @${b.username}`,
          callback_data: `bot:${b._id}`,
        }]),
        back("menu"),
      ]),
    );
  });

  cb(/^bot:(\d+)$/, async (ctx, m) => {
    const b = await getOwned(ctx, m[1]);
    if (!b) return;
    states.delete(ctx.from.id);
    await show(ctx, ...botPanel(b));
  });

  cb(/^del:(\d+)$/, async (ctx, m) => {
    const b = await getOwned(ctx, m[1]);
    if (!b) return;
    await show(
      ctx,
      `@${b.username} ni o'chirishga ishonchingiz komilmi?`,
      kb([[{ text: "✅ Ha, o'chirish", callback_data: `delok:${b._id}` }], back(`bot:${b._id}`, "❌ Yo'q")]),
    );
  });

  cb(/^delok:(\d+)$/, async (ctx, m) => {
    const b = await getOwned(ctx, m[1]);
    if (!b) return;
    let userSessionWarning = "";
    const activeChild = children.get(b._id);
    if (b.type === "user-scheduler") {
      let cleanupChild = activeChild;
      try {
        if (!cleanupChild) cleanupChild = await buildChild(b);
        await cleanupChild.templateControls?.delete?.();
      } catch (error) {
        userSessionWarning =
          "\n\nDiqqat: ayrim Telegram sessiyalarini avtomatik bekor qilib bo'lmadi. " +
          "Telegram → Sozlamalar → Qurilmalar bo'limida ularni qo'lda bekor qiling.";
        console.error(`@${b.username} User Bot sessiyalari bekor qilinmadi:`, error.message);
      } finally {
        if (cleanupChild && cleanupChild !== activeChild) {
          await cleanupChild.templateControls?.stop?.().catch((error) => {
            console.error(`@${b.username} User Bot runtime to'xtamadi:`, error.message);
          });
        }
        await UserSchedulerUsers.deleteMany({ botId: b._id });
      }
    }
    stopChild(b._id);
    await Bots.deleteOne({ _id: b._id });
    await Subs.deleteMany({ botId: b._id });
    await FooterSettings.deleteOne({ botId: b._id });
    await WatermarkProfiles.deleteMany({ botId: b._id });
    if (b.type === "guard") await (await getGuardDatabase()).deleteBot(b._id);
    await removeGeneratedBotFile(b._id).catch((error) => {
      console.error(`@${b.username} bot faylini o'chirib bo'lmadi:`, error.message);
    });
    await show(ctx, `🗑 Bot o'chirildi.${userSessionWarning}`, kb([back("menu", "🏠 Menyu")]));
  });

  /* --- Admin panel --- */
  cb(/^adm$/, async (ctx) => {
    states.delete(ctx.from.id);
    await show(
      ctx,
      "🛠 Admin panel",
      kb([
        [{ text: "📊 Statistika", callback_data: "adm_stats" }],
        [{ text: "🔎 Foydalanuvchini ID orqali topish", callback_data: "adm_user_search" }],
        [{ text: "💳 Tariflar va to'lovlar", callback_data: "adm_tariffs" }],
        [{ text: "💰 To'ldirish so'rovlari", callback_data: "adm_topups" }],
        [{ text: "🤖 Barcha botlar", callback_data: "adm_bots:0" }],
        [{ text: "📢 Hammaga xabar", callback_data: "adm_bc" }],
        [{ text: "🔒 Majburiy obuna", callback_data: "adm_gate" }],
        back("menu"),
      ]),
    );
  }, true);

  cb(/^adm_gate$/, async (ctx) => {
    states.set(ctx.from.id, { type: "adm_gate_select" });
    const chats = getConstructorGateChats();
    const list = chats.length
      ? chats.map((chat, index) => `${index + 1}. ${chat.title}`).join("\n")
      : "Sozlanmagan";
    await ctx.reply(
      `Majburiy obunalar:\n${list}\n\nYana kanal yoki guruh qo'shing:`,
      {
        reply_markup: {
          resize_keyboard: true,
          one_time_keyboard: true,
          keyboard: [
            [{
              text: "📢 Kanal tanlash",
              request_chat: {
                request_id: 9201,
                chat_is_channel: true,
                bot_is_member: true,
                user_administrator_rights: fullAdminRights(),
                bot_administrator_rights: fullAdminRights(),
              },
            }],
            [{
              text: "👥 Guruh tanlash",
              request_chat: {
                request_id: 9202,
                chat_is_channel: false,
                bot_is_member: true,
                user_administrator_rights: fullAdminRights(),
                bot_administrator_rights: fullAdminRights(),
              },
            }],
          ],
        },
      },
    );
  }, true);

  cb(/^adm_gate_off$/, async (ctx) => {
    await PlatformSettings.updateOne(
      { _id: "constructor_gate" },
      { $set: { chats: [], chatId: null, title: "", link: "" } },
      { upsert: true },
    );
    constructorGate = { chats: [] };
    await show(ctx, "Majburiy obuna o'chirildi.", kb([back("adm")]));
  }, true);

  cb(/^constructor_gate_check$/, async (ctx) => {
    const chats = getConstructorGateChats();
    if (!chats.length) return show(ctx, "Majburiy obuna sozlanmagan.", kb([back("menu")]));
    try {
      const missing = [];
      for (const chat of chats) {
        const member = await mother.api("getChatMember", {
          chat_id: chat.chatId,
          user_id: ctx.from.id,
        });
        const joined = ["creator", "administrator", "member"].includes(member.status) ||
          (member.status === "restricted" && member.is_member);
        if (!joined) missing.push(chat);
      }
      if (!missing.length) {
        states.delete(ctx.from.id);
        await show(ctx, "✅ Obuna tasdiqlandi.", kb([back("menu")]));
      } else {
        await ctx.reply("Hali obuna topilmadi. Avval chatga obuna bo'ling.");
      }
    } catch (error) {
      await ctx.reply("Obunani tekshirib bo'lmadi. Keyinroq urinib ko'ring.");
    }
  });

  cb(/^adm_tariffs$/, async (ctx) => {
    states.delete(ctx.from.id);
    await show(ctx, ...await tariffPanel());
  }, true);

  cb(/^adm_price:([a-z-]+)$/, async (ctx, match) => {
    const type = match[1];
    const settings = await getPlatformBilling();
    states.set(ctx.from.id, { type: "adm_price", botType: type });
    await show(
      ctx,
      `${BOT_TYPES[type].label} narxini "boshlang'ich/oylik" shaklida yuboring.\n` +
        `Hozir: ${settings.prices[type].initial}/${settings.prices[type].monthly} so'm.\nBekor qilish: /cancel`,
      kb([back("adm_tariffs")]),
    );
  }, true);

  cb(/^adm_sample:([a-z-]+)$/, async (ctx, match) => {
    const type = match[1];
    const settings = await getPlatformBilling();
    states.set(ctx.from.id, { type: "adm_sample", botType: type });
    await show(
      ctx,
      `${BOT_TYPES[type].label} uchun namuna bot username yoki t.me havolasini yuboring.\n` +
        `Hozir: ${settings.sampleBots[type] ? `@${settings.sampleBots[type]}` : "belgilanmagan"}\n` +
        "O'chirish uchun /clear, bekor qilish uchun /cancel yuboring.",
      kb([back("adm_tariffs")]),
    );
  }, true);

  cb(/^adm_toggle:([a-z-]+)$/, async (ctx, match) => {
    const settings = await getPlatformBilling();
    const type = match[1];
    settings.prices[type].enabled = !settings.prices[type].enabled;
    await savePlatformBilling(settings);
    await show(ctx, ...await tariffPanel());
  }, true);

  cb(/^adm_stars$/, async (ctx) => {
    const settings = await getPlatformBilling();
    states.set(ctx.from.id, { type: "adm_stars" });
    await show(
      ctx,
      `Stars kursini "Stars/so'm" shaklida yuboring.\n` +
        `Hozir: ${settings.stars.count}/${settings.stars.amount}.\nBekor qilish: /cancel`,
      kb([back("adm_tariffs")]),
    );
  }, true);

  cb(/^adm_payinfo$/, async (ctx) => {
    const settings = await getPlatformBilling();
    states.set(ctx.from.id, { type: "adm_payinfo" });
    await show(
      ctx,
      `Karta yoki to'lov bo'yicha ko'rsatmani yuboring. U foydalanuvchiga ko'rsatiladi.\n` +
        `Hozir: ${settings.paymentInstructions || "sozlanmagan"}\n` +
        "O'chirish uchun /clear, bekor qilish uchun /cancel yuboring.",
      kb([back("adm_tariffs")]),
    );
  }, true);

  cb(/^adm_topups$/, async (ctx) => {
    const pending = await Topups.find({
      method: "manual",
      status: "pending",
    }).sort({ submittedAt: 1 }).limit(10).toArray();
    await show(
      ctx,
      pending.length
        ? `⏳ Tasdiqlanishi kutilayotgan to'lovlar: ${pending.length}`
        : "⏳ Kutilayotgan qo'lda to'lovlar yo'q.",
      kb([
        ...pending.map((topup) => [
          {
            text: `${money(topup.amount)} — ${topup.ownerId}`,
            callback_data: `adm_topup:${topup._id}`,
          },
        ]),
        back("adm"),
      ]),
    );
  }, true);

  cb(/^adm_user_search$/, async (ctx) => {
    states.set(ctx.from.id, { type: "adm_user_search" });
    await show(
      ctx,
      "Topmoqchi bo'lgan foydalanuvchining Telegram ID raqamini yuboring.",
      kb([back("adm")]),
    );
  }, true);

  cb(/^adm_user:(\d+)$/, async (ctx, match) => {
    states.delete(ctx.from.id);
    const userId = Number(match[1]);
    const view = await userProfileView(userId, true);
    if (!view) {
      return show(ctx, "Bu ID bilan foydalanuvchi topilmadi.", kb([back("adm_user_search")]));
    }
    await show(ctx, ...view);
  }, true);

  cb(/^adm_user_bots:(\d+):(\d+)$/, async (ctx, match) => {
    states.delete(ctx.from.id);
    const userId = Number(match[1]);
    const page = Number(match[2]);
    const size = 8;
    const [bots, total] = await Promise.all([
      Bots.find({ ownerId: userId })
        .sort({ createdAt: -1 })
        .skip(page * size)
        .limit(size)
        .toArray(),
      Bots.countDocuments({ ownerId: userId }),
    ]);
    const rows = bots.map((bot) => [{
      text: `${bot.banned ? "🚫" : children.has(bot._id) ? "✅" : "⏸"} @${bot.username}`,
      callback_data: `adm_bot:${bot._id}`,
    }]);
    const navigation = [];
    if (page > 0) navigation.push({ text: "⬅️", callback_data: `adm_user_bots:${userId}:${page - 1}` });
    if ((page + 1) * size < total) navigation.push({ text: "➡️", callback_data: `adm_user_bots:${userId}:${page + 1}` });
    await show(
      ctx,
      total ? `🤖 Foydalanuvchi ${userId} botlari (${total})` : "Foydalanuvchida botlar yo'q.",
      kb([
        ...rows,
        ...(navigation.length ? [navigation] : []),
        back(`adm_user:${userId}`, "⬅️ Profilga qaytish"),
      ]),
    );
  }, true);

  cb(/^adm_user_balance:(\d+)$/, async (ctx, match) => {
    const userId = Number(match[1]);
    const user = await Users.findOne({ _id: userId });
    states.set(ctx.from.id, { type: "adm_user_balance", userId });
    await show(
      ctx,
      `ID ${userId} joriy balansi: ${money(user?.balance)}.\n` +
        "Yangi balansni so'mda yuboring (0 yoki undan katta butun son).",
      kb([back(`adm_user:${userId}`)]),
    );
  }, true);

  cb(/^adm_user_msg:(\d+)$/, async (ctx, match) => {
    const userId = Number(match[1]);
    states.set(ctx.from.id, { type: "adm_user_message", userId });
    await show(
      ctx,
      `ID ${userId} foydalanuvchisiga yuboriladigan xabarni yozing.\n` +
        "Bekor qilish: /cancel",
      kb([back(`adm_user:${userId}`)]),
    );
  }, true);

  cb(/^adm_user_block:(\d+)$/, async (ctx, match) => {
    states.delete(ctx.from.id);
    const userId = Number(match[1]);
    if (isAdmin(userId)) {
      return show(ctx, "Konstruktor adminini bloklab bo'lmaydi.", kb([back(`adm_user:${userId}`)]));
    }
    const user = await Users.findOne({ _id: userId });
    if (!user) {
      return show(ctx, "Foydalanuvchi topilmadi.", kb([back("adm")]));
    }
    const blocked = !user.blocked;
    await Users.updateOne(
      { _id: userId },
      blocked
        ? { $set: { blocked: true, blockedAt: new Date() } }
        : { $set: { blocked: false }, $unset: { blockedAt: "" } },
    );
    if (blocked) blockedUsers.add(userId);
    else blockedUsers.delete(userId);
    await mother.sendMessage(
      userId,
      blocked
        ? "🚫 Konstruktor botdan foydalanishingiz bloklandi."
        : "✅ Konstruktor botdan foydalanish blokdan chiqarildi.",
    ).catch((error) => console.error(`ID ${userId} ga blok xabari yuborilmadi:`, error.message));
    const view = await userProfileView(userId, true);
    await show(ctx, ...view);
  }, true);

  cb(/^adm_topup:([a-f\d]{24})$/i, async (ctx, match) => {
    const topup = await Topups.findOne({
      _id: new ObjectId(match[1]),
      method: "manual",
      status: "pending",
    });
    if (!topup) {
      return show(ctx, "Bu to'lov so'rovi allaqachon ko'rib chiqilgan.", kb([back("adm_topups")]));
    }
    const user = await Users.findOne({ _id: topup.ownerId });
    if (topup.receipt?.type === "photo") {
      try {
        await mother.api("sendPhoto", {
          chat_id: ctx.chat.id,
          photo: topup.receipt.fileId,
          caption: `To'lov cheki: ${money(topup.amount)} — ${topup.ownerId}`,
        });
      } catch (error) {
        console.error("Saqlangan to'lov chekini ko'rsatib bo'lmadi:", error.message);
      }
    }
    await show(
      ctx,
      `💳 To'ldirish so'rovi\nID: ${topup._id}\n` +
        `Foydalanuvchi: ${user?.username ? `@${user.username}` : topup.ownerId}\n` +
        `Summa: ${money(topup.amount)}\n` +
        `Chek: ${topup.receipt?.text || topup.receipt?.caption || (topup.receipt?.type === "photo" ? "Rasm adminlarga yuborilgan" : "yo'q")}`,
      kb([
        [
          { text: "✅ Tasdiqlash", callback_data: `topup_ok:${topup._id}` },
          { text: "❌ Rad etish", callback_data: `topup_no:${topup._id}` },
        ],
        back("adm_topups"),
      ]),
    );
  }, true);

  cb(/^topup_ok:([a-f\d]{24})$/i, async (ctx, match) => {
    const topup = await billingService.approveManualTopup(
      new ObjectId(match[1]),
      ctx.from.id,
    );
    if (!topup) {
      return show(ctx, "To'lov so'rovi allaqachon ko'rib chiqilgan.", kb([back("adm_topups")]));
    }
    await settleOwnerBilling(topup.ownerId);
    const user = await Users.findOne({ _id: topup.ownerId });
    await mother.sendMessage(
      topup.ownerId,
      `✅ ${money(topup.amount)} balansingizga qo'shildi. Joriy balans: ${money(user?.balance)}.`,
    ).catch((error) => console.error("To'lov tasdiq xabari yuborilmadi:", error.message));
    await show(ctx, `To'lov tasdiqlandi: ${money(topup.amount)}.`, kb([back("adm_topups")]));
  }, true);

  cb(/^topup_no:([a-f\d]{24})$/i, async (ctx, match) => {
    const result = await billingService.rejectManualTopup(
      new ObjectId(match[1]),
      ctx.from.id,
    );
    if (!result.modifiedCount) {
      return show(ctx, "To'lov so'rovi allaqachon ko'rib chiqilgan.", kb([back("adm_topups")]));
    }
    const topup = await Topups.findOne({ _id: new ObjectId(match[1]) });
    await mother.sendMessage(
      topup.ownerId,
      `❌ ${money(topup.amount)} to'ldirish so'rovi rad etildi. To'lov ma'lumotini tekshirib qayta yuboring.`,
    ).catch((error) => console.error("Rad etish xabari yuborilmadi:", error.message));
    await show(ctx, "To'lov so'rovi rad etildi.", kb([back("adm_topups")]));
  }, true);

  cb(/^adm_stats$/, async (ctx) => {
    const [users, bots, banned, subs] = await Promise.all([
      Users.countDocuments(),
      Bots.countDocuments(),
      Bots.countDocuments({ banned: true }),
      Subs.countDocuments(),
    ]);
    await show(
      ctx,
      `📊 Platforma statistikasi\n\nFoydalanuvchilar: ${users}\nBotlar: ${bots}\nIshlayotgan: ${children.size}\nBloklangan: ${banned}\nMijoz botlaridagi jami obunachilar: ${subs}`,
      kb([back("adm")]),
    );
  }, true);

  cb(/^adm_bots:(\d+)$/, async (ctx, m) => {
    const page = Number(m[1]);
    const size = 8;
    const total = await Bots.countDocuments();
    const list = await Bots.find().sort({ createdAt: -1 }).skip(page * size).limit(size).toArray();
    const nav = [];
    if (page > 0) nav.push({ text: "⬅️", callback_data: `adm_bots:${page - 1}` });
    if ((page + 1) * size < total) nav.push({ text: "➡️", callback_data: `adm_bots:${page + 1}` });
    await show(
      ctx,
      `🤖 Botlar (${total})`,
      kb([
        ...list.map((b) => [{ text: `${b.banned ? "🚫" : "✅"} @${b.username}`, callback_data: `adm_bot:${b._id}` }]),
        ...(nav.length ? [nav] : []),
        back("adm"),
      ]),
    );
  }, true);

  cb(/^adm_bot:(\d+)$/, async (ctx, m) => {
    const b = await Bots.findOne({ _id: Number(m[1]) });
    if (!b) return;
    const subs = await Subs.countDocuments({ botId: b._id });
    const smmButtons = b.type === "smm"
      ? [
          [{ text: "🌐 SMM API havolasi", callback_data: `adm_smm:url:${b._id}` }, { text: "🔑 SMM API kaliti", callback_data: `adm_smm:key:${b._id}` }],
          [{ text: "💱 USD kursi", callback_data: `adm_smm:rate:${b._id}` }, { text: "📈 Ustama", callback_data: `adm_smm:markup:${b._id}` }],
          [{ text: "🏦 Karta raqami", callback_data: `adm_smm:card:${b._id}` }, { text: "👤 Karta egasi", callback_data: `adm_smm:cardowner:${b._id}` }],
        ]
      : [];
    await show(
      ctx,
      `🤖 @${b.username}\n` +
        `Turi: ${BOT_TYPES[b.type]?.label || "Eski bot"}\n` +
        `Egasi (ID): ${b.ownerId}\nObunachilar: ${subs}\n` +
        `Holati: ${b.banned ? "🚫 bloklangan" : "✅ faol"}` +
        (b.type === "smm"
          ? `\n\nSMM API: ${b.smmApiUrl ? "✅ ulangan" : "❌ ulanmagan"}\nUSD kursi: ${Number(b.smmUsdRate || 12700).toLocaleString("uz-UZ")} so'm\nUstama: ${Number(b.smmMarkupPercent || 30)}%`
          : ""),
      kb([
        ...smmButtons,
        [{ text: b.banned ? "♻️ Blokdan chiqarish" : "🚫 Bloklash", callback_data: `adm_ban:${b._id}` }],
        [{ text: "🗑 O'chirish", callback_data: `del:${b._id}` }],
        [{ text: "👤 Egasi profilini ko'rish", callback_data: `adm_user:${b.ownerId}` }],
        back("adm_bots:0"),
      ]),
    );
  }, true);

  cb(/^adm_smm:(url|key|rate|markup|card|cardowner):(\d+)$/, async (ctx, match) => {
    const field = match[1];
    const botId = Number(match[2]);
    const b = await Bots.findOne({ _id: botId, type: "smm" });
    if (!b) return show(ctx, "SMM bot topilmadi.", kb([back("adm_bots:0")]));
    states.set(ctx.from.id, { type: `adm_smm:${field}`, botId });
    const prompts = {
      url: "SMM API havolasini https://.../api/v2 ko'rinishida yuboring:",
      key: "SMM provider API kalitini yuboring:",
      rate: "1 USD uchun kursni so'mda yuboring:",
      markup: "Narx ustamasini foizda yuboring:",
      card: "Hisob to'ldirish uchun karta raqamini yuboring:",
      cardowner: "Karta egasi nomini yuboring:",
    };
    await show(
      ctx,
      prompts[field],
      kb([back(`adm_bot:${botId}`)]),
    );
  }, true);

  cb(/^adm_ban:(\d+)$/, async (ctx, m) => {
    const b = await Bots.findOne({ _id: Number(m[1]) });
    if (!b) return;
    const banned = !b.banned;
    await Bots.updateOne({ _id: b._id }, { $set: { banned } });
    if (banned) {
      stopChild(b._id);
    } else {
      await startChild({ ...b, banned });
    }
    mother
      .sendMessage(b.ownerId, banned ? `🚫 @${b.username} boti bloklandi.` : `♻️ @${b.username} boti qayta yoqildi.`)
      .catch(() => {});
    await show(ctx, banned ? "🚫 Bot bloklandi." : "♻️ Bot blokdan chiqarildi.", kb([back("adm_bots:0")]));
  }, true);

  cb(/^adm_bc$/, async (ctx) => {
    states.set(ctx.from.id, { type: "adm_bc_media", mediaMessageId: null, textMessageId: null, buttons: [], style: "default" });
    await show(
      ctx,
      "Konstruktor botning barcha foydalanuvchilariga xabar yuborish.\n1/3 — GIF, video, rasm yoki fayl yuboring:",
      kb([[{ text: "➡️ Mediasiz davom etish", callback_data: "adm_bc:skip_media" }], back("adm")]),
    );
  }, true);

  cb(/^adm_bc:skip_media$/, async (ctx) => {
    if (states.get(ctx.from.id)?.type !== "adm_bc_media") return;
    states.set(ctx.from.id, { ...states.get(ctx.from.id), type: "adm_bc_text" });
    await show(ctx, "2/3 — Premium emoji qo'llab-quvvatlaydigan matnni yuboring:", kb([back("adm")]));
  }, true);

  cb(/^adm_bc:style:(default|primary|success|danger)$/, async (ctx, match) => {
    const state = states.get(ctx.from.id);
    if (state?.type !== "adm_bc_buttons") return;
    state.style = match[1];
    const stylePreview = {
      primary: "🔵",
      success: "🟢",
      danger: "🔴",
      default: "⚪",
    }[match[1]];
    await show(
      ctx,
      `3/3 — Havolali tugma qo'shing.\nTanlangan rang: ${stylePreview}\nFormat: Tugma matni | https://example.com\nBir nechta tugmani har qatorda alohida yuboring.`,
      kb([
        [{
          text: "Ko'k",
          callback_data: "adm_bc:style:primary",
          style: "primary",
        }, {
          text: "Yashil",
          callback_data: "adm_bc:style:success",
          style: "success",
        }],
        [{
          text: "Qizil",
          callback_data: "adm_bc:style:danger",
          style: "danger",
        }, {
          text: "Standart",
          callback_data: "adm_bc:style:default",
          style: "default",
        }],
        [{ text: "✅ Xabarni ko'rish", callback_data: "adm_bc:preview" }],
        back("adm"),
      ]),
    );
  }, true);

  cb(/^adm_bc:send$/, async (ctx) => {
    const state = states.get(ctx.from.id);
    if (state?.type !== "adm_bc_buttons") return;
    await broadcastSend(ctx, state);
  }, true);

  cb(/^adm_bc:preview$/, async (ctx) => {
    const state = states.get(ctx.from.id);
    if (state?.type !== "adm_bc_buttons") return;
    const inlineKeyboard = state.buttons.map((button) => [{
      text: button.text,
      url: button.url,
      ...(state.style === "default" ? {} : { style: state.style }),
    }]);

    try {
      if (state.mediaMessageId) {
        await mother.api("copyMessage", {
          chat_id: ctx.chat.id,
          from_chat_id: ctx.chat.id,
          message_id: state.mediaMessageId,
        });
      }
      if (state.textMessageId) {
        const copied = await mother.api("copyMessage", {
          chat_id: ctx.chat.id,
          from_chat_id: ctx.chat.id,
          message_id: state.textMessageId,
        });
        if (inlineKeyboard.length) {
          await mother.api("editMessageReplyMarkup", {
            chat_id: ctx.chat.id,
            message_id: copied.message_id,
            disablePremiumEmoji: true,
            reply_markup: { inline_keyboard: inlineKeyboard },
          });
        }
      }
      await ctx.reply(
        "Yuqoridagi ko'rinish preview. Xabarni yuborishni tasdiqlaysizmi?",
        kb([
          [{ text: "✅ Ha, barchaga yuborish", callback_data: "adm_bc:send" }],
          [{ text: "❌ Bekor qilish", callback_data: "adm_bc:cancel" }],
        ]),
      );
    } catch (error) {
      await ctx.reply(`Preview yaratib bo'lmadi: ${error.message}`);
    }
  }, true);

  cb(/^adm_bc:cancel$/, async (ctx) => {
    states.delete(ctx.from.id);
    await show(ctx, "Xabar yuborish bekor qilindi.", kb([back("adm")]));
  }, true);

  const broadcastSend = async (ctx, state) => {
    states.delete(ctx.from.id);

    const sent = [];
    for await (const user of Users.find({})) {
      try {
        if (state.mediaMessageId) {
          await mother.api("copyMessage", {
            chat_id: user._id,
            from_chat_id: ctx.chat.id,
            message_id: state.mediaMessageId,
          });
        }
        if (state.textMessageId) {
          const copied = await mother.api("copyMessage", {
            chat_id: user._id,
            from_chat_id: ctx.chat.id,
            message_id: state.textMessageId,
          });
          if (state.buttons.length) {
            const inlineKeyboard = state.buttons.map((button) => [{
              text: button.text,
              url: button.url,
              ...(state.style === "default" ? {} : { style: state.style }),
            }]);
            await mother.api("editMessageReplyMarkup", {
              chat_id: user._id,
              message_id: copied.message_id,
              disablePremiumEmoji: true,
              reply_markup: { inline_keyboard: inlineKeyboard },
            });
          }
        }
        sent.push(user._id);
      } catch (error) {
        console.error(`Umumiy xabar ${user._id} ga yuborilmadi:`, error.message);
      }
      await sleep(50);
    }
    await ctx.reply(`✅ Xabar yuborildi: ${sent.length} foydalanuvchi.`);
  };

  /* --- Matn kiritish holatlari --- */
  mother.onText(/[\s\S]*/, async (ctx) => {
    if (ctx.chat?.type !== "private" || !ctx.text) return;
    const uid = ctx.from.id;
    const st = states.get(uid);
    if (!st) return ctx.reply("Menyuni ochish uchun /start bosing.");

    try {
      switch (st.type) {
        case "adm_bc_buttons": {
          if (!isAdmin(uid)) return;
          const value = ctx.text.trim();
          const match = value.match(/^(.+?)\s*\|\s*(https?:\/\/\S+)$/i);
          if (!match) {
            await ctx.reply("Format: Tugma matni | https://havola.uz");
            break;
          }
          st.buttons.push({ text: match[1].trim().slice(0, 64), url: match[2] });
          states.set(uid, st);
          await ctx.reply(
            `Tugma qo'shildi. Yana tugma matnini yuboring yoki yuborishni boshlang.`,
            kb([
              [{ text: "✅ Xabarni yuborish", callback_data: "adm_bc:send" }],
              back("adm"),
            ]),
          );
          break;
        }
        case "stars_amount": {
          const value = ctx.text.trim();
          if (!/^\d+$/.test(value)) {
            await ctx.reply("Stars miqdorini faqat butun raqam bilan yuboring. Minimal: 10 Stars.");
            break;
          }
          const stars = Number(value);
          if (!Number.isSafeInteger(stars) || stars < 10) {
            await ctx.reply("Stars miqdori kamida 10 bo'lgan butun son bo'lishi kerak.");
            break;
          }
          states.delete(uid);
          await sendStarsInvoice(ctx, stars);
          break;
        }
        case "adm_user_search": {
          if (!isAdmin(uid)) return;
          const value = ctx.text.trim();
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
            await ctx.reply("Telegram ID raqamini faqat raqamlar bilan yuboring.");
            break;
          }
          const userId = Number(value);
          const view = await userProfileView(userId, true);
          states.delete(uid);
          if (!view) {
            await ctx.reply("Bu ID bilan foydalanuvchi topilmadi.");
            break;
          }
          await ctx.reply(...view);
          break;
        }
        case "adm_user_balance": {
          if (!isAdmin(uid)) return;
          const value = ctx.text.trim();
          const balance = Number(value);
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(balance)) {
            await ctx.reply("Yangi balansni musbat butun so'mda yuboring.");
            break;
          }
          const result = await billingService.setUserBalance(
            st.userId,
            balance,
            uid,
          );
          states.delete(uid);
          await settleOwnerBilling(st.userId);
          await mother.sendMessage(
            st.userId,
            `ℹ️ Admin balansingizni ${money(result.balance)} qilib belgiladi.`,
          ).catch((error) => console.error("Balans o'zgarishi xabari yuborilmadi:", error.message));
          await ctx.reply(
            `✅ ID ${st.userId} balansi ${money(result.oldBalance)} dan ${money(result.balance)} ga o'zgartirildi.`,
          );
          const view = await userProfileView(st.userId, true);
          if (view) await ctx.reply(...view);
          break;
        }
        case "adm_smm:url":
        case "adm_smm:key":
        case "adm_smm:rate":
        case "adm_smm:markup":
        case "adm_smm:card":
        case "adm_smm:cardowner": {
          if (!isAdmin(uid)) return;
          const field = st.type.split(":")[2];
          const text = ctx.text.trim();
          let update;
          try {
            if (field === "url") {
              if (!/^https?:\/\//i.test(text)) throw new Error("API havolasi http:// yoki https:// bilan boshlansin.");
              update = { smmApiUrl: text };
            } else if (field === "key") {
              if (text.length < 8) throw new Error("API kaliti juda qisqa.");
              update = { smmApiKey: text };
            } else if (field === "rate") {
              const rate = Number(text.replace(/[^\d.]/g, ""));
              if (!Number.isFinite(rate) || rate <= 0) throw new Error("USD kursi musbat son bo'lsin.");
              update = { smmUsdRate: rate };
            } else if (field === "markup") {
              const markup = Number(text.replace(/[^\d.-]/g, ""));
              if (!Number.isFinite(markup) || markup < 0 || markup > 500) throw new Error("Ustama 0–500% oralig'ida bo'lsin.");
              update = { smmMarkupPercent: markup };
            } else if (field === "card") {
              const card = text.replace(/\D/g, "");
              if (card.length < 12 || card.length > 23) throw new Error("Karta raqami noto'g'ri.");
              update = { smmCardNumber: text };
            } else {
              if (text.length < 2 || text.length > 80) throw new Error("Karta egasi nomi noto'g'ri.");
              update = { smmCardOwner: text };
            }
          } catch (error) {
            await ctx.reply(`❌ ${error.message}`);
            break;
          }
          await Bots.updateOne({ _id: st.botId, type: "smm" }, { $set: update });
          const child = children.get(st.botId);
          if (child) Object.assign(child.config, update);
          states.delete(uid);
          await ctx.reply("✅ SMM API sozlamasi saqlandi.");
          await ctx.reply(...botPanel(await Bots.findOne({ _id: st.botId })));
          break;
        }
        case "token": {
          ctx.loadingText = "API token tekshirilmoqda, bot tayyorlanmoqda";
          ctx.api("deleteMessage", {
            chat_id: ctx.chat.id,
            message_id: ctx.message.message_id,
          }).catch((error) => {
            console.error("Yuborilgan bot tokeni xabarini o'chirib bo'lmadi:", error.message);
          });
          try {
            const doc = await createBot(uid, st.botType, ctx.text.trim());
            states.delete(uid);
            await ctx.reply(
              doc.type === "smm"
                ? "✅ Nakrutka/SMM bot yaratildi. 3 kunlik bepul sinov boshlandi. Provayder va karta sozlamalari uchun .env fayliga SMM_* qiymatlarini kiriting."
                : doc.type === "footer"
                ? "✅ Kanal footer boti yaratildi. 3 kunlik bepul sinov boshlandi. Bot ichida /start yuborib tag matni va kanalingizni sozlang."
                : doc.type === "watermark"
                  ? "✅ Watermark bot yaratildi. 3 kunlik bepul sinov boshlandi. Bot ichida /start yuborib logo va rasm sozlamalarini tanlang."
                  : doc.type === "file-editor"
                    ? "✅ Fayl tahrirlovchi bot yaratildi. 3 kunlik bepul sinov boshlandi. /start yuborib faylni tahrirlashni boshlang."
                    : doc.type === "image-text"
                      ? "✅ Rasm sarlavhasi tahrirlovchi bot yaratildi. 3 kunlik bepul sinov boshlandi. /start yuborib sarlavhani o'zgartiring."
                      : doc.type === "guard"
                        ? "✅ Telegram Qorovul Bot yaratildi. 3 kunlik bepul sinov boshlandi. Botni guruhga qo'shib administrator qiling va guruh egasi /claim buyrug'ini yuborsin."
                        : doc.type === "user-scheduler"
                          ? "✅ User Bot yaratildi. 3 kunlik bepul sinov boshlandi. Har bir foydalanuvchi /start yuborib, Mini App orqali o'z Telegram akkauntini ulashi mumkin."
                        : "✅ Tayyor bot yaratildi. 3 kunlik bepul sinov boshlandi. Sozlash shart emas.",
            );
            await ctx.reply(
              `Trial tugagach ${money(doc.pricing.initial)} boshlang'ich va ` +
                `${money(doc.pricing.monthly)} oylik to'lov balansdan olinadi. ` +
                "Balans yetarli bo'lmasa bot vaqtincha to'xtaydi.",
            );
            await ctx.reply(...botPanel(doc));
          } catch (e) {
            await ctx.reply("❌ " + e.message + "\nQayta yuboring yoki /cancel.");
          }
          break;
        }
        case "topup_amount": {
          const amount = Number(ctx.text.trim());
          if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000000) {
            await ctx.reply("Summani so'mda musbat butun son qilib yuboring (maksimal 1 000 000 000).");
            break;
          }
          const settings = await getPlatformBilling();
          const inserted = await Topups.insertOne({
            ownerId: uid,
            method: "manual",
            status: "awaiting_receipt",
            amount,
            createdAt: new Date(),
          });
          states.set(uid, { type: "manual_receipt", topupId: inserted.insertedId.toString() });
          await ctx.reply(
            `To'lov summasi: ${money(amount)}\n\n` +
              `${settings.paymentInstructions}\n\n` +
              "To'lovdan so'ng chek rasmini yoki tranzaksiya raqamini yuboring. Bekor qilish: /cancel",
          );
          break;
        }
        case "manual_receipt":
          await submitManualReceipt(ctx, ctx.message);
          break;
        case "adm_price": {
          if (!isAdmin(uid)) return;
          const match = ctx.text.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
          if (!match) {
            await ctx.reply("Narxni boshlang'ich/oylik shaklida yuboring, masalan: 10000/1000.");
            break;
          }
          const initial = Number(match[1]);
          const monthly = Number(match[2]);
          if (
            !Number.isSafeInteger(initial) ||
            !Number.isSafeInteger(monthly) ||
            initial > 1000000000 ||
            monthly > 1000000000
          ) {
            await ctx.reply("Narxlar 0 dan 1 000 000 000 so'mgacha bo'lgan butun sonlar bo'lishi kerak.");
            break;
          }
          const settings = await getPlatformBilling();
          settings.prices[st.botType] = {
            ...settings.prices[st.botType],
            initial,
            monthly,
          };
          await savePlatformBilling(settings);
          states.delete(uid);
          await ctx.reply("✅ Tarif saqlandi.");
          await ctx.reply(...await tariffPanel());
          break;
        }
        case "adm_sample": {
          if (!isAdmin(uid)) return;
          const username = parseSampleBotUsername(ctx.text);
          if (username === null) {
            await ctx.reply(
              "Telegram bot username (@example_bot) yoki https://t.me/example_bot havolasini yuboring.",
            );
            break;
          }
          const settings = await getPlatformBilling();
          settings.sampleBots[st.botType] = username;
          await savePlatformBilling(settings);
          states.delete(uid);
          await ctx.reply(username ? `✅ Namuna bot @${username} saqlandi.` : "✅ Namuna bot o'chirildi.");
          await ctx.reply(...await tariffPanel());
          break;
        }
        case "adm_stars": {
          if (!isAdmin(uid)) return;
          const match = ctx.text.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
          if (!match) {
            await ctx.reply("Kursni Stars/so'm shaklida yuboring, masalan: 100/25000.");
            break;
          }
          const count = Number(match[1]);
          const amount = Number(match[2]);
          if (
            !Number.isSafeInteger(count) ||
            !Number.isSafeInteger(amount) ||
            count < 1 ||
            count > 1000000 ||
            amount < 1 ||
            amount > 1000000000
          ) {
            await ctx.reply("Stars 1–1 000 000, so'm miqdori 1–1 000 000 000 oralig'idagi butun son bo'lishi kerak.");
            break;
          }
          const settings = await getPlatformBilling();
          settings.stars = { count, amount };
          await savePlatformBilling(settings);
          states.delete(uid);
          await ctx.reply("✅ Stars kursi saqlandi.");
          await ctx.reply(...await tariffPanel());
          break;
        }
        case "adm_payinfo": {
          if (!isAdmin(uid)) return;
          const paymentInstructions = ctx.text.trim() === "/clear"
            ? ""
            : ctx.text.trim();
          if (paymentInstructions.length > 3000) {
            await ctx.reply("To'lov ko'rsatmasi 3000 belgidan oshmasin.");
            break;
          }
          const settings = await getPlatformBilling();
          settings.paymentInstructions = paymentInstructions;
          await savePlatformBilling(settings);
          states.delete(uid);
          await ctx.reply(
            paymentInstructions
              ? "✅ To'lov ko'rsatmasi saqlandi."
              : "✅ To'lov ko'rsatmasi o'chirildi.",
          );
          await ctx.reply(...await tariffPanel());
          break;
        }
        case "adm_bc": {
          if (!isAdmin(uid)) return;
          states.delete(uid);
          await ctx.reply("📢 Yuborish boshlandi...");
          broadcast(mother, Users, {}, "_id", ctx.text)
            .then((r) => ctx.reply(`✅ Yuborildi: ${r.ok}\n❌ Xato: ${r.fail}`))
            .catch(console.error);
          break;
        }
      }
    } catch (e) {
      console.error(e);
      states.delete(uid);
      await ctx.reply("❌ Xatolik: " + e.message);
    }
  });

  await billingService.processDueBots();

  await mother.deleteWebhook();
  const motherPolling = mother.launch();
  motherPolling.catch((error) => {
    console.error("Asosiy bot to'xtadi:", error);
    process.exitCode = 1;
  });

  /* --- Saqlangan botlarni cheklangan parallelizm bilan qayta ishga tushirish --- */
  const starting = new Set();
  for await (const savedDoc of Bots.find()) {
    const task = (async () => {
      const doc = await normalizeBotType({ ...savedDoc }, Bots);
      if (!BOT_TYPES[doc.type]) {
        console.error(`@${doc.username} uchun bot turi topilmadi: ${doc.type}`);
        return;
      }
      if (!doc.banned) await startChild(doc);
    })().catch((error) => {
      console.error(`@${savedDoc.username} ishga tushmadi:`, error.message);
    });
    starting.add(task);
    task.finally(() => starting.delete(task));
    if (starting.size >= 5) await Promise.race(starting);
  }
  await Promise.all(starting);
  console.log(`${children.size} ta mijoz boti ishga tushdi`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const activeChildren = [...children.values()];
    const pollingTasks = [motherPolling, ...childPolls];
    mother.stop();
    const childStops = activeChildren.map((child) =>
      stopChild(child.config._id),
    );
    await Promise.allSettled([...pollingTasks, ...childStops]);
    await new Promise((resolve, reject) => {
      healthServer.close((error) => (error ? reject(error) : resolve()));
    });
    await closeGuardDatabase();
    await mother.closeDatabase();
  };

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      shutdown().catch((error) => {
        console.error("Xizmatni yopib bo'lmadi:", error);
        process.exitCode = 1;
      });
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Xizmatni ishga tushirib bo'lmadi:", error);
    process.exit(1);
  });
}