const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const QRCode = require("qrcode");
const jsQR = require("jsqr");
const NodeID3 = require("node-id3");
const sharp = require("sharp");
const { BotConstructor } = require("../bot-constructor");
const {
  addCalendarMonth,
  BillingService,
  getBillingSettings,
  parseSampleBotUsername,
} = require("../billing");
const registerAdminPanel = require("../bots/admin-panel").registerAdminPanel;
const registerChannelFooter = require("../bots/channel-footer");
const registerQrGenerator = require("../bots/qr-generator");
const registerNicknameFont = require("../bots/nickname-font");
const registerWatermarkBot = require("../bots/watermark");
const { createWatermarkedImage } = require("../bots/watermark");
const registerMusicSearchBot = require("../bots/music-search");
const registerFileEditor = require("../bots/file-editor");
const registerImageTextEditor = require("../bots/image-text-editor");
const { replaceTemplateTitle } = require("../bots/image-text-editor");
const registerSmmPanel = require("../bots/smm-panel");
const {
  isMp3,
  mp3Filename,
  prepareThumbnail,
  safeFilename,
  updateMp3Buffer,
} = require("../bots/file-editor");
const normalizeBotType = require("../bots/normalize-bot-type");
const {
  generatedFilePath,
  removeGeneratedBotFile,
  writeGeneratedBotFile,
} = require("../bots/generated-file");

test("SMM panel start sends a visible reply keyboard", async () => {
  const collection = {
    createIndex: async () => "index",
  };
  const bot = new BotConstructor("test-token");
  bot.config = { _id: 123456, ownerId: 77, welcome: "Nakrutka/SMM xush kelibsiz" };
  registerSmmPanel(bot, {
    SmmUsers: collection,
    SmmOrders: collection,
    SmmTopups: collection,
    Bots: collection,
  });

  const replies = [];
  bot.sendMessage = async (chatId, text, options) =>
    replies.push({ chatId, text, options });

  await bot.processUpdate({
    message: {
      chat: { id: 77, type: "private" },
      from: { id: 77 },
      text: "/start",
    },
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "Nakrutka/SMM xush kelibsiz");
  assert.equal(replies[0].options.reply_markup.resize_keyboard, true);
  assert.equal(replies[0].options.reply_markup.keyboard[0][0].text, "🛒 Buyurtma berish");
});

test("SMM top-up receipt sends its Telegram file ID to admins", async () => {
  const collection = {
    createIndex: async () => "index",
    insertOne: async () => ({ insertedId: "topup-1" }),
  };
  const bot = new BotConstructor("test-token");
  bot.config = { _id: 123456, ownerId: 77 };
  registerSmmPanel(bot, {
    SmmUsers: collection,
    SmmOrders: collection,
    SmmTopups: collection,
    Bots: collection,
  });

  const replies = [];
  const apiCalls = [];
  bot.sendMessage = async (chatId, text, options) => {
    replies.push({ chatId, text, options });
  };
  bot.api = async (method, payload) => {
    apiCalls.push({ method, payload });
    return { message_id: 1 };
  };

  const chat = { id: 88, type: "private" };
  const from = { id: 88 };
  await bot.processUpdate({ message: { chat, from, text: "💳 Hisobni to‘ldirish" } });
  await bot.processUpdate({ message: { chat, from, text: "5000" } });
  await bot.processUpdate({
    message: { chat, from, photo: [{ file_id: "telegram-photo-id" }] },
  });

  assert.equal(apiCalls[0].method, "sendPhoto");
  assert.equal(apiCalls[0].payload.chat_id, 77);
  assert.equal(apiCalls[0].payload.photo, "telegram-photo-id");
  assert.match(replies.at(-1).text, /adminga yuborildi/);
});

test("SMM API keys map users to their separate bot balances", async () => {
  const userDocs = new Map();
  userDocs.set(88, { _id: 88, botId: 123456, balance: 100000 });
  userDocs.set(99, { _id: 99, botId: 123456, balance: 100000 });
  const orderDocs = [];
  const users = {
    createIndex: async () => "index",
    findOne: async (filter) => filter.smmApiKeyHash
      ? [...userDocs.values()].find((user) =>
          user.botId === filter.botId && user.smmApiKeyHash === filter.smmApiKeyHash) || null
      : userDocs.get(filter._id) || null,
    updateOne: async (filter, update) => {
      const exists = userDocs.has(filter._id);
      const current = userDocs.get(filter._id) || {};
      const next = {
        ...current,
        ...(exists ? {} : update.$setOnInsert),
        ...update.$set,
      };
      for (const field of Object.keys(update.$unset || {})) delete next[field];
      userDocs.set(filter._id, next);
      return { matchedCount: 1 };
    },
    findOneAndUpdate: async (filter, update) => {
      const current = userDocs.get(filter._id);
      if (!current || current.balance < filter.balance.$gte) return null;
      const updated = { ...current, balance: current.balance + update.$inc.balance };
      userDocs.set(filter._id, updated);
      return updated;
    },
  };
  const orders = {
    createIndex: async () => "index",
    insertOne: async (order) => {
      orderDocs.push(order);
      return { insertedId: orderDocs.length };
    },
    find: (filter) => ({
      toArray: async () => orderDocs.filter((order) =>
        order.botId === filter.botId &&
        order.userId === filter.userId &&
        filter.providerOrderId.$in.includes(order.providerOrderId)),
    }),
  };
  const topups = { createIndex: async () => "index" };
  const requests = [];
  const bot = new BotConstructor("test-token");
  bot.config = {
    _id: 123456,
    ownerId: 77,
    smmApiUrl: "https://prm4u.com/api/v2",
    smmApiKey: "OWNER_PROVIDER_KEY",
  };
  const controls = registerSmmPanel(bot, {
    SmmUsers: users,
    SmmOrders: orders,
    SmmTopups: topups,
    encryptSecret: (value) => `encrypted:${value}`,
    decryptSecret: (value) => value.replace(/^encrypted:/, ""),
    publicApiBaseUrl: "https://bots.example",
    fetch: async (url, options) => {
      const params = new URLSearchParams(options.body);
      const key = params.get("key");
      const action = params.get("action");
      requests.push({ url, key, action });
      const payload = action === "services"
        ? [{
            service: 101,
            name: "Provider service",
            category: "Category",
            rate: 0.0001,
            min: 100,
            max: 10000,
          }]
        : action === "status"
          ? { status: "Completed", start_count: 100, remains: 0 }
          : { order: `provider-order-${requests.filter((request) => request.action === "add").length}` };
      return { ok: true, json: async () => payload };
    },
  });
  const replies = [];
  bot.sendMessage = async (chatId, text, options) => {
    replies.push({ chatId, text, options });
    return { message_id: replies.length };
  };
  bot.api = async () => ({ message_id: 1 });

  const sendCallback = async (userId, data) => {
    const chat = { id: userId, type: "private" };
    await bot.processUpdate({
      callback_query: {
        id: `${userId}-${data}`,
        data,
        from: { id: userId },
        message: { chat, message_id: 1 },
      },
    });
  };
  const sendApiInfoRequest = async (userId) => {
    const chat = { id: userId, type: "private" };
    await bot.processUpdate({
      message: {
        chat,
        from: { id: userId },
        text: "🌐 API ma’lumotlari",
        message_id: 2,
      },
    });
  };
  const getApiKey = (userId) => {
    const message = replies.filter((reply) => reply.chatId === userId).at(-1).text;
    return message.match(/API key: (smm_[a-f\d]+)/)[1];
  };

  await sendApiInfoRequest(88);
  assert.match(replies.at(-1).text, /https:\/\/bots\.example\/api\/smm\/123456\/v2/);
  await sendCallback(88, "smmuserapi:generate");
  await sendApiInfoRequest(99);
  await sendCallback(99, "smmuserapi:generate");
  const keyA = getApiKey(88);
  const keyB = getApiKey(99);

  assert.notEqual(keyA, keyB);
  assert.notEqual(userDocs.get(88).smmApiKeyHash, keyA);
  assert.notEqual(userDocs.get(99).smmApiKeyHash, keyB);
  assert.deepEqual(await controls.handleApiRequest({ key: keyA, action: "balance" }), {
    balance: 100000,
    currency: "UZS",
  });
  assert.deepEqual(await controls.handleApiRequest({ key: keyB, action: "balance" }), {
    balance: 100000,
    currency: "UZS",
  });

  const catalog = await controls.handleApiRequest({ key: keyA, action: "services" });
  assert.equal(catalog[0].service, 101);
  const firstOrder = await controls.handleApiRequest({
    key: keyA,
    action: "add",
    service: "101",
    link: "https://example.com/a",
    quantity: "1000",
  });
  const secondOrder = await controls.handleApiRequest({
    key: keyB,
    action: "add",
    service: "101",
    link: "https://example.com/b",
    quantity: "1000",
  });

  assert.deepEqual(firstOrder, { order: "provider-order-1" });
  assert.deepEqual(secondOrder, { order: "provider-order-2" });
  assert.equal(userDocs.get(88).balance, 99998);
  assert.equal(userDocs.get(99).balance, 99998);
  assert.deepEqual(orderDocs.map((order) => order.userId), [88, 99]);
  assert.ok(requests.filter((request) => request.action === "add")
    .every((request) => request.url === "https://prm4u.com/api/v2" && request.key === "OWNER_PROVIDER_KEY"));
  assert.deepEqual(await controls.handleApiRequest({
    key: keyA,
    action: "status",
    order: "provider-order-1",
  }), {
    "provider-order-1": {
      charge: 2,
      start_count: 100,
      status: "Completed",
      remains: 0,
      currency: "UZS",
    },
  });
  assert.deepEqual(await controls.handleApiRequest({
    key: keyB,
    action: "status",
    order: "provider-order-1",
  }), { error: "Order not found." });
});

test("bot constructor dispatches messages, photos, callbacks and middleware", async () => {
  const bot = new BotConstructor("test-token");
  const seen = [];
  bot.use(async (ctx) => {
    if (ctx.from?.id === 99) ctx.handled = true;
  });
  bot.command("start", async () => seen.push("command"));
  bot.onText(/^hello$/, async () => seen.push("text"));
  bot.onPhoto(async () => seen.push("photo"));
  bot.onCallbackData(/^item:(\d+)$/, async (ctx, match) =>
    seen.push(`callback:${match[1]}`));
  bot.onUpdate("channel_post", async (ctx) =>
    seen.push(`channel:${ctx.message.text}`),
  );

  const message = {
    chat: { id: 1, type: "private" },
    from: { id: 1 },
    text: "/start",
  };
  await bot.processUpdate({ message });
  await bot.processUpdate({ message: { ...message, text: "hello" } });
  await bot.processUpdate({ message: { ...message, text: "", photo: [{ file_id: "p" }] } });
  await bot.processUpdate({
    callback_query: {
      id: "q",
      data: "item:42",
      from: message.from,
      message,
    },
  });
  await bot.processUpdate({ message: { ...message, from: { id: 99 }, text: "hello" } });
  await bot.processUpdate({
    channel_post: {
      chat: { id: -1001, type: "channel" },
      text: "new post",
    },
  });

  assert.deepEqual(seen, ["command", "text", "photo", "callback:42", "channel:new post"]);
});

test("polling subscribes to channel post updates", async () => {
  const bot = new BotConstructor("test-token");
  let pollingPayload;
  bot.api = async (_method, payload) => {
    pollingPayload = payload;
    bot.stop();
    return [];
  };

  await bot.launch();

  assert.ok(pollingPayload.allowed_updates.includes("channel_post"));
  assert.ok(pollingPayload.allowed_updates.includes("pre_checkout_query"));
});

test("Telegram Stars payment updates are dispatched and can be acknowledged", async () => {
  const bot = new BotConstructor("test-token");
  const calls = [];
  const payments = [];
  bot.api = async (method, payload) => {
    calls.push({ method, payload });
    return true;
  };
  bot.onUpdate("pre_checkout_query", async (ctx) => {
    await ctx.answerPreCheckout(true);
  });
  bot.onUpdate("successful_payment", async (ctx) => {
    payments.push(ctx.message.successful_payment.total_amount);
  });

  await bot.processUpdate({
    pre_checkout_query: {
      id: "checkout-1",
      from: { id: 8 },
      invoice_payload: "stars-payload",
      currency: "XTR",
      total_amount: 100,
    },
  });
  await bot.processUpdate({
    message: {
      chat: { id: 8, type: "private" },
      from: { id: 8 },
      successful_payment: { total_amount: 100 },
    },
  });

  assert.deepEqual(calls, [{
    method: "answerPreCheckoutQuery",
    payload: { pre_checkout_query_id: "checkout-1", ok: true },
  }]);
  assert.deepEqual(payments, [100]);
});

test("file uploads support a document thumbnail and MP3 metadata", async () => {
  const bot = new BotConstructor("test-token");
  const originalFetch = global.fetch;
  const uploads = [];
  global.fetch = async (url, options) => {
    uploads.push({ url, form: options.body });
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: uploads.length } }),
    };
  };
  try {
    await bot.sendDocument(7, Buffer.from("file"), "report.pdf", {
      caption: "Done",
      thumbnail: Buffer.from("jpeg"),
    });
    await bot.sendAudio(7, Buffer.from("audio"), "track.mp3", {
      title: "New title",
      performer: "New artist",
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.match(uploads[0].url, /\/sendDocument$/);
  assert.equal(uploads[0].form.get("document").name, "report.pdf");
  assert.equal(uploads[0].form.get("thumbnail").name, "thumbnail.jpg");
  assert.equal(
    uploads[0].form.get("caption"),
    '<tg-emoji emoji-id="5260726538302660868">✅</tg-emoji> Done',
  );
  assert.equal(uploads[0].form.get("parse_mode"), "HTML");
  assert.match(uploads[1].url, /\/sendAudio$/);
  assert.equal(uploads[1].form.get("audio").name, "track.mp3");
  assert.equal(uploads[1].form.get("title"), "New title");
  assert.equal(uploads[1].form.get("performer"), "New artist");
});

test("bot messages and inline buttons use mapped custom emoji IDs", async () => {
  const bot = new BotConstructor("test-token");
  const originalFetch = global.fetch;
  let payload;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    };
  };
  try {
    await bot.sendMessage(7, "👤 Profil", {
      reply_markup: {
        inline_keyboard: [[
          { text: "👤 Profil", callback_data: "profile" },
          { text: "Fayllar", callback_data: "files" },
          { text: "❌", callback_data: "cancel" },
        ]],
      },
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(
    payload.text,
    '<tg-emoji emoji-id="5258362837411045098">👤</tg-emoji> Profil',
  );
  assert.equal(payload.parse_mode, "HTML");
  assert.equal(payload.reply_markup.inline_keyboard[0][0].text, "Profil");
  assert.equal(
    payload.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id,
    "5258362837411045098",
  );
  assert.equal(
    payload.reply_markup.inline_keyboard[0][1].icon_custom_emoji_id,
    "5258514780469075716",
  );
  assert.equal(payload.reply_markup.inline_keyboard[0][2].text, "\u00a0");
  assert.equal(
    payload.reply_markup.inline_keyboard[0][2].icon_custom_emoji_id,
    "5258226313285607065",
  );
});

test("custom emoji entities preserve existing Telegram text entities", async () => {
  const bot = new BotConstructor("test-token");
  const originalFetch = global.fetch;
  let payload;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ ok: true, result: true }),
    };
  };
  try {
    await bot.api("editMessageText", {
      chat_id: 7,
      message_id: 2,
      text: "Read ✅",
      entities: [{ type: "bold", offset: 0, length: 4 }],
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(payload.text, "Read ✅");
  assert.deepEqual(payload.entities, [
    { type: "bold", offset: 0, length: 4 },
    {
      type: "custom_emoji",
      offset: 5,
      length: 1,
      custom_emoji_id: "5260726538302660868",
    },
  ]);
});

test("custom emoji API rejection retries with the original message", async () => {
  const bot = new BotConstructor("test-token");
  const originalFetch = global.fetch;
  const requests = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return {
        ok: false,
        json: async () => ({
          ok: false,
          error_code: 400,
          description: "Bad Request: custom emoji is not allowed",
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 3 } }),
    };
  };
  try {
    await bot.sendMessage(7, "✅ Tayyor");
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[0].parse_mode, "HTML");
  assert.equal(requests[1].text, "✅ Tayyor");
  assert.equal(requests[1].parse_mode, undefined);
});

test("custom emoji upload rejection retries without custom markup", async () => {
  const bot = new BotConstructor("test-token");
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const uploads = [];
  console.warn = () => {};
  global.fetch = async (_url, options) => {
    uploads.push(options.body);
    if (uploads.length === 1) {
      return {
        ok: false,
        json: async () => ({
          ok: false,
          error_code: 400,
          description: "Bad Request: custom emoji is not allowed",
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 4 } }),
    };
  };
  try {
    await bot.sendDocument(7, Buffer.from("file"), "file.pdf", {
      caption: "✅ Tayyor",
      reply_markup: {
        inline_keyboard: [[{ text: "📂 Fayllar", callback_data: "files" }]],
      },
    });
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
  }

  assert.equal(uploads.length, 2);
  assert.match(uploads[0].get("caption"), /<tg-emoji emoji-id=/);
  assert.ok(uploads[0].get("reply_markup").includes("icon_custom_emoji_id"));
  assert.equal(uploads[1].get("caption"), "✅ Tayyor");
  assert.equal(
    JSON.parse(uploads[1].get("reply_markup")).inline_keyboard[0][0].text,
    "📂 Fayllar",
  );
  assert.equal(
    JSON.parse(uploads[1].get("reply_markup")).inline_keyboard[0][0]
      .icon_custom_emoji_id,
    undefined,
  );
});

test("file editor sanitizes names, prepares thumbnails, and writes MP3 tags", async () => {
  assert.equal(isMp3({ mime_type: "application/octet-stream" }, "song.bin", Buffer.from("ID3tag")), true);
  assert.equal(isMp3({ mime_type: "application/octet-stream" }, "song.bin", Buffer.from([0xff, 0xfb, 0x90, 0x64])), true);
  assert.equal(isMp3({ mime_type: "audio/mp4" }, "song.m4a", Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])), false);
  assert.equal(isMp3({ mime_type: "audio/mpeg" }, "song.mp3", Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])), false);
  const mpegLikeBytes = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  assert.equal(
    isMp3(
      { mime_type: "application/pdf" },
      "document.pdf",
      Buffer.concat([Buffer.from("%PDF-1.7\n"), mpegLikeBytes]),
    ),
    false,
  );
  assert.equal(
    isMp3(
      { mime_type: "image/png" },
      "picture.png",
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        mpegLikeBytes,
      ]),
    ),
    false,
  );
  assert.equal(mp3Filename("track.m4a"), "track.mp3");
  assert.equal(mp3Filename("track"), "track.mp3");
  assert.equal(safeFilename("new-track", "old-track.mp3", true), "new-track.mp3");
  assert.throws(() => safeFilename("../track.mp3", "old.mp3", true), /Fayl nomi/);
  assert.throws(() => safeFilename("track.txt", "old.mp3", true), /\.mp3/);

  const cover = await sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: "#4f46e5",
    },
  }).jpeg().toBuffer();
  const thumbnail = await prepareThumbnail(cover);
  const thumbnailMetadata = await sharp(thumbnail).metadata();
  assert.equal(thumbnailMetadata.format, "jpeg");
  assert.ok(thumbnailMetadata.width <= 320 && thumbnailMetadata.height <= 320);
  assert.ok(thumbnail.length <= 200 * 1024);

  const edited = updateMp3Buffer(Buffer.from("mp3 audio bytes"), {
    title: "New song",
    artist: "New artist",
    cover: thumbnail,
  });
  const tags = NodeID3.read(edited);
  assert.equal(tags.title, "New song");
  assert.equal(tags.artist, "New artist");
  assert.deepEqual(tags.image.imageBuffer, thumbnail);
});

test("file editor renames a document, adds a thumbnail, and sends it back", async () => {
  const bot = new BotConstructor("test-token");
  const source = Buffer.concat([
    Buffer.from("sample document bytes"),
    Buffer.from([0xff, 0xfb, 0x90, 0x64]),
  ]);
  const cover = await sharp({
    create: {
      width: 48,
      height: 48,
      channels: 3,
      background: "#f43f5e",
    },
  }).png().toBuffer();
  const sent = [];
  bot.api = async (method, payload) => {
    if (method === "getFile") {
      return {
        file_path: payload.file_id,
        file_size: payload.file_id === "source" ? source.length : cover.length,
      };
    }
    return true;
  };
  bot.downloadFile = async (filePath) => filePath === "source" ? source : cover;
  bot.sendDocument = async (...args) => sent.push(args);
  registerFileEditor(bot);
  const user = { id: 21 };
  const privateChat = { id: 21, type: "private" };
  const click = async (data, messageId) =>
    bot.processUpdate({
      callback_query: {
        id: `callback-${messageId}`,
        from: user,
        data,
        message: { chat: privateChat, message_id: messageId },
      },
    });

  await bot.processUpdate({
    message: {
      chat: privateChat,
      from: user,
      document: {
        file_id: "source",
        file_name: "original.pdf",
        mime_type: "application/pdf",
        file_size: source.length,
      },
    },
  });
  await click("file:rename", 1);
  await bot.processUpdate({
    message: { chat: privateChat, from: user, text: "renamed.pdf" },
  });
  await click("file:thumbnail", 2);
  await bot.processUpdate({
    message: {
      chat: privateChat,
      from: user,
      photo: [{ file_id: "cover", file_size: cover.length }],
    },
  });
  await click("file:send", 3);

  assert.equal(sent.length, 1);
  assert.equal(sent[0][2], "renamed.pdf");
  assert.deepEqual(sent[0][1], source);
  assert.ok(Buffer.isBuffer(sent[0][3].thumbnail));
  assert.ok(sent[0][3].thumbnail.length <= 200 * 1024);
});

test("file editor sends PDF and PNG documents as documents, not MP3 audio", async () => {
  const mpegLikeBytes = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  const files = {
    pdf: Buffer.concat([Buffer.from("%PDF-1.7\n"), mpegLikeBytes]),
    png: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mpegLikeBytes,
    ]),
  };
  const bot = new BotConstructor("test-token");
  const sentDocuments = [];
  const sentAudio = [];
  bot.api = async (method, payload) => {
    if (method !== "getFile") return { message_id: 1 };
    return {
      file_path: payload.file_id,
      file_size: files[payload.file_id].length,
    };
  };
  bot.downloadFile = async (filePath) => files[filePath];
  bot.sendDocument = async (...args) => sentDocuments.push(args);
  bot.sendAudio = async (...args) => sentAudio.push(args);
  registerFileEditor(bot);

  for (const [fileId, fileName, mimeType, userId] of [
    ["pdf", "document.pdf", "application/pdf", 25],
    ["png", "picture.png", "image/png", 26],
  ]) {
    const user = { id: userId };
    const chat = { id: userId, type: "private" };
    await bot.processUpdate({
      message: {
        chat,
        from: user,
        document: {
          file_id: fileId,
          file_name: fileName,
          mime_type: mimeType,
          file_size: files[fileId].length,
        },
      },
    });
    await bot.processUpdate({
      callback_query: {
        id: `send-${fileId}`,
        from: user,
        data: "file:send",
        message: { chat, message_id: userId },
      },
    });
  }

  assert.equal(sentDocuments.length, 2);
  assert.deepEqual(sentDocuments.map((args) => args[2]), ["document.pdf", "picture.png"]);
  assert.equal(sentAudio.length, 0);
});

test("file editor detects MP3 content and sends it with an MP3 filename", async () => {
  const bot = new BotConstructor("test-token");
  const source = Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000audio");
  const sent = [];
  bot.api = async (_method, payload) => ({
    file_path: payload.file_id,
    file_size: source.length,
  });
  bot.downloadFile = async () => source;
  bot.sendAudio = async (...args) => sent.push(args);
  registerFileEditor(bot);
  const user = { id: 22 };
  const privateChat = { id: 22, type: "private" };

  await bot.processUpdate({
    message: {
      chat: privateChat,
      from: user,
      document: {
        file_id: "mp3-content",
        file_name: "track.m4a",
        mime_type: "application/octet-stream",
        file_size: source.length,
      },
    },
  });
  await bot.processUpdate({
    callback_query: {
      id: "send-mp3",
      from: user,
      data: "file:send",
      message: { chat: privateChat, message_id: 1 },
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0][2], "track.mp3");
  assert.deepEqual(sent[0][1], source);
});

test("file editor accepts image documents with generic MIME types as thumbnails", async () => {
  const bot = new BotConstructor("test-token");
  const source = Buffer.from("sample document bytes");
  const cover = await sharp({
    create: {
      width: 48,
      height: 48,
      channels: 3,
      background: "#f43f5e",
    },
  }).png().toBuffer();
  const files = { source, cover };
  const sent = [];
  bot.api = async (method, payload) => {
    if (method !== "getFile") return { message_id: 1 };
    return {
      file_path: payload.file_id,
      file_size: files[payload.file_id].length,
    };
  };
  bot.downloadFile = async (filePath) => files[filePath];
  bot.sendDocument = async (...args) => sent.push(args);
  registerFileEditor(bot);
  const user = { id: 23 };
  const privateChat = { id: 23, type: "private" };
  const click = async (data, messageId) =>
    bot.processUpdate({
      callback_query: {
        id: `generic-image-${messageId}`,
        from: user,
        data,
        message: { chat: privateChat, message_id: messageId },
      },
    });

  await bot.processUpdate({
    message: {
      chat: privateChat,
      from: user,
      document: {
        file_id: "source",
        file_name: "original.pdf",
        mime_type: "application/pdf",
        file_size: source.length,
      },
    },
  });
  await click("file:thumbnail", 1);
  await bot.processUpdate({
    message: {
      chat: privateChat,
      from: user,
      document: {
        file_id: "cover",
        file_name: "cover.bin",
        mime_type: "application/octet-stream",
        file_size: cover.length,
      },
    },
  });
  await click("file:send", 2);

  assert.equal(sent.length, 1);
  assert.equal(sent[0][2], "original.pdf");
  assert.ok(Buffer.isBuffer(sent[0][3].thumbnail));
  assert.ok(sent[0][3].thumbnail.length <= 200 * 1024);
});

test("file editor converts non-MP3 audio to a real MP3 before sending", async () => {
  const sampleRate = 8000;
  const sampleCount = sampleRate / 2;
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((index * 2 * Math.PI * 440) / sampleRate) * 8000), index * 2);
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);

  const bot = new BotConstructor("test-token");
  const sent = [];
  bot.api = async (_method, payload) => ({
    file_path: payload.file_id,
    file_size: wav.length,
  });
  bot.downloadFile = async () => wav;
  bot.sendAudio = async (...args) => sent.push(args);
  registerFileEditor(bot);
  const user = { id: 24 };
  const privateChat = { id: 24, type: "private" };

  await bot.processUpdate({
    message: {
      chat: privateChat,
      from: user,
      audio: {
        file_id: "wav-audio",
        file_name: "track.wav",
        mime_type: "audio/wav",
        file_size: wav.length,
      },
    },
  });
  await bot.processUpdate({
    callback_query: {
      id: "send-converted",
      from: user,
      data: "file:send",
      message: { chat: privateChat, message_id: 1 },
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0][2], "track.mp3");
  assert.equal(sent[0][1].subarray(0, 3).toString("ascii"), "ID3");
});

test("billing defaults and calendar monthly due dates are correct", () => {
  const settings = getBillingSettings({
    prices: { qr: { enabled: false } },
    paymentInstructions: "Karta: 0000",
    sampleBots: { qr: "sample_qr_bot" },
  });
  assert.deepEqual(settings.prices.qr, {
    initial: 10000,
    monthly: 1000,
    enabled: false,
  });
  assert.deepEqual(settings.prices.watermark, {
    initial: 10000,
    monthly: 1000,
    enabled: true,
  });
  assert.deepEqual(settings.prices["file-editor"], {
    initial: 10000,
    monthly: 1000,
    enabled: true,
  });
  assert.deepEqual(settings.stars, { count: 100, amount: 25000 });
  assert.deepEqual(settings.prices["image-text"], {
    initial: 10000,
    monthly: 1000,
    enabled: true,
  });
  assert.deepEqual(settings.prices.music, {
    initial: 10000,
    monthly: 1000,
    enabled: true,
  });
  assert.equal(settings.sampleBots.music, "");
  assert.equal(settings.sampleBots.qr, "sample_qr_bot");
  assert.equal(settings.sampleBots.watermark, "");
  assert.equal(parseSampleBotUsername("@sample_bot"), "sample_bot");
  assert.equal(parseSampleBotUsername("https://t.me/sample_bot"), "sample_bot");
  assert.equal(parseSampleBotUsername("t.me/sample_bot"), "sample_bot");
  assert.equal(parseSampleBotUsername("/clear"), "");
  assert.equal(parseSampleBotUsername("https://example.com/sample_bot"), null);
  assert.equal(parseSampleBotUsername("bad name"), null);
  assert.equal(
    addCalendarMonth(new Date("2026-01-31T00:00:00.000Z")).toISOString(),
    "2026-02-28T00:00:00.000Z",
  );
});

test("due bot billing debits the balance once or suspends on insufficient funds", async () => {
  const bot = {
    _id: 55,
    ownerId: 8,
    username: "trial_bot",
    trialEndsAt: new Date("2026-03-01T00:00:00.000Z"),
    initialFeePaid: false,
    billingStatus: "trial",
    pricing: { initial: 10000, monthly: 1000 },
  };
  const transactions = [];
  let balance = 12000;
  const service = new BillingService({
    client: {
      startSession: () => ({
        withTransaction: async (operation) => operation(),
        endSession: async () => {},
      }),
    },
    Bots: {
      findOne: async () => ({ ...bot }),
      updateOne: async (_filter, update) => {
        Object.assign(bot, update.$set);
        for (const key of Object.keys(update.$unset || {})) delete bot[key];
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
    Users: {
      updateOne: async (_filter, update) => {
        if (balance < -update.$inc.balance) return { matchedCount: 0 };
        balance += update.$inc.balance;
        return { matchedCount: 1 };
      },
    },
    Topups: {},
    BalanceTransactions: {
      findOne: async ({ reference }) =>
        transactions.find((entry) => entry.reference === reference) || null,
      insertOne: async (entry) => transactions.push(entry),
    },
    PlatformSettings: {},
    stopChild: () => {},
    startChild: async () => {},
    notifyOwner: async () => {},
  });

  const charged = await service.chargeBot(
    bot._id,
    new Date("2026-03-01T00:00:00.000Z"),
  );
  assert.equal(charged.status, "charged");
  assert.equal(balance, 1000);
  assert.equal(bot.initialFeePaid, true);
  assert.equal(bot.nextBillingAt.toISOString(), "2026-04-01T00:00:00.000Z");
  assert.equal(transactions[0].amount, -11000);

  bot.nextBillingAt = new Date("2026-04-01T00:00:00.000Z");
  balance = 500;
  const suspended = await service.chargeBot(
    bot._id,
    new Date("2026-04-01T00:00:00.000Z"),
  );
  assert.equal(suspended.status, "suspended");
  assert.equal(bot.billingStatus, "suspended");
  assert.equal(balance, 500);
  assert.equal(transactions.length, 1);
});

test("manual top-up approval credits the balance only once", async () => {
  const topup = {
    _id: "topup-1",
    ownerId: 8,
    method: "manual",
    status: "pending",
    amount: 25000,
  };
  let balance = 0;
  const entries = [];
  const service = new BillingService({
    client: {
      startSession: () => ({
        withTransaction: async (operation) => operation(),
        endSession: async () => {},
      }),
    },
    Bots: {},
    Users: {
      updateOne: async (_filter, update) => {
        balance += update.$inc.balance;
        return { matchedCount: 1 };
      },
    },
    Topups: {
      findOne: async () => topup.status === "pending" ? { ...topup } : null,
      updateOne: async (_filter, update) => {
        if (topup.status !== "pending") return { modifiedCount: 0 };
        Object.assign(topup, update.$set);
        return { modifiedCount: 1 };
      },
    },
    BalanceTransactions: {
      insertOne: async (entry) => entries.push(entry),
    },
    PlatformSettings: {},
  });

  const approved = await service.approveManualTopup(topup._id, 99);
  const duplicate = await service.approveManualTopup(topup._id, 99);

  assert.equal(approved.amount, 25000);
  assert.equal(duplicate, null);
  assert.equal(balance, 25000);
  assert.equal(entries.length, 1);
});

test("admin balance changes are recorded with the previous and new amount", async () => {
  const user = { _id: 8, balance: 1000 };
  const entries = [];
  const service = new BillingService({
    client: {
      startSession: () => ({
        withTransaction: async (operation) => operation(),
        endSession: async () => {},
      }),
    },
    Bots: {},
    Users: {
      findOne: async () => ({ ...user }),
      updateOne: async (_filter, update) => {
        Object.assign(user, update.$set);
        return { matchedCount: 1 };
      },
    },
    Topups: {},
    BalanceTransactions: {
      insertOne: async (entry) => entries.push(entry),
    },
    PlatformSettings: {},
  });

  const result = await service.setUserBalance(8, 5000, 99);

  assert.deepEqual(result, { oldBalance: 1000, balance: 5000 });
  assert.equal(entries[0].amount, 4000);
  assert.equal(entries[0].type, "admin_balance_adjustment");
  assert.equal(entries[0].adminId, 99);
  await assert.rejects(() => service.setUserBalance(8, -1, 99), /Balans/);
});

test("slow private-chat handlers show animated loading and remove it when done", async () => {
  const bot = new BotConstructor("test-token", {
    loadingDelay: 0,
    loadingInterval: 5,
  });
  const events = [];
  bot.sendMessage = async (_chatId, text) => {
    events.push({ type: "loading", text });
    return { message_id: 321 };
  };
  bot.editMessageText = async (_chatId, _messageId, text) => {
    events.push({ type: "frame", text });
  };
  bot.api = async (method) => {
    events.push({ type: method });
    return true;
  };
  bot.command("slow", async (ctx) => {
    ctx.loadingText = "Token tekshirilmoqda";
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

  await bot.processUpdate({
    message: {
      chat: { id: 7, type: "private" },
      from: { id: 7 },
      text: "/slow",
    },
  });

  assert.ok(events.some((event) => event.type === "loading" && /Token tekshirilmoqda/.test(event.text)));
  assert.ok(events.some((event) => event.type === "frame" && /Token tekshirilmoqda\./.test(event.text)));
  assert.ok(events.some((event) => event.type === "deleteMessage"));
});

test("slow channel-post handlers show loading privately to the bot owner", async () => {
  const bot = new BotConstructor("test-token", {
    loadingDelay: 0,
    loadingInterval: 5,
  });
  const loadingChats = [];
  bot.sendMessage = async (chatId) => {
    loadingChats.push(chatId);
    return { message_id: 654 };
  };
  bot.editMessageText = async () => {};
  bot.api = async () => true;
  bot.onUpdate("channel_post", async (ctx) => {
    ctx.loadingChatId = 42;
    ctx.loadingText = "Kanal posti yangilanmoqda";
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

  await bot.processUpdate({
    channel_post: {
      chat: { id: -1001, type: "channel" },
      text: "new post",
    },
  });

  assert.deepEqual(loadingChats, [42]);
});

test("QR template generates a QR image and decodes a QR photo", async () => {
  const bot = new BotConstructor("test-token");
  const sentPhotos = [];
  const sentMessages = [];
  bot.sendPhoto = async (...args) => sentPhotos.push(args);
  bot.sendMessage = async (...args) => sentMessages.push(args);
  registerQrGenerator(bot);

  const message = {
    chat: { id: 7, type: "private" },
    from: { id: 7 },
    text: "https://example.com",
  };
  await bot.processUpdate({ message });
  assert.equal(sentPhotos.length, 1);
  assert.equal(sentPhotos[0][0], 7);
  assert.ok(Buffer.isBuffer(sentPhotos[0][1]));

  const qrImage = await QRCode.toBuffer("decoded QR content", { type: "png" });
  bot.api = async () => ({ file_path: "photos/test.png", file_size: qrImage.length });
  bot.downloadFile = async () => qrImage;
  await bot.processUpdate({
    message: {
      ...message,
      text: undefined,
      photo: [{ file_id: "photo" }],
    },
  });
  assert.match(sentMessages.at(-1)[1], /decoded QR content/);
});

test("plain QR stays scannable", async () => {
  const text = "https://example.com/qr-style-test";
  const image = await registerQrGenerator.createStyledQr(text);
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  assert.equal(decoded?.data, text);
  assert.equal(await registerQrGenerator.decodeQrImage(image), text);
});

test("nickname template returns several Unicode styles", async () => {
  const bot = new BotConstructor("test-token");
  let response;
  bot.sendMessage = async (_chatId, text, options) => {
    response = { text, options };
  };
  registerNicknameFont(bot);

  await bot.processUpdate({
    message: {
      chat: { id: 7, type: "private" },
      from: { id: 7 },
      text: "Ali_123 💙",
    },
  });

  assert.match(response.text, /17 xil nickname/);
  const buttons = response.options.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, 17);
  assert.equal(new Set(buttons.map((button) => button.text)).size, 17);
  for (const button of buttons) {
    assert.deepEqual(button.copy_text, { text: button.text });
  }
  assert.ok(buttons.some((button) => button.text.includes("💙")));
});

test("nickname template rejects labels exceeding Telegram's button limit", async () => {
  const bot = new BotConstructor("test-token");
  let reply;
  bot.sendMessage = async (_chatId, text) => {
    reply = text;
  };
  registerNicknameFont(bot);

  await bot.processUpdate({
    message: {
      chat: { id: 7, type: "private" },
      from: { id: 7 },
      text: "x".repeat(33),
    },
  });

  assert.match(reply, /32 belgidan oshmasin/);
});

test("subscription gate blocks non-members and lets members continue", async () => {
  const bot = new BotConstructor("test-token");
  const doc = {
    _id: 456,
    ownerId: 123,
    username: "test_bot",
    requiredChannel: -1001,
    requiredChannelLink: "https://t.me/test_channel",
  };
  bot.config = doc;
  let status = "left";
  const replies = [];
  let handled = 0;
  let subscriberWrites = 0;
  let membershipChecks = 0;
  const Subs = { updateOne: async () => subscriberWrites++ };
  bot.api = async () => {
    membershipChecks++;
    return { status };
  };
  bot.sendMessage = async (_chatId, text, options) => replies.push({ text, options });
  require("../bots/admin-panel").registerSubscriptionGate(bot, { doc, Subs });
  bot.onText(/^hello$/, async () => handled++);

  const message = {
    chat: { id: 7, type: "private" },
    from: { id: 7 },
    text: "hello",
  };
  await bot.processUpdate({ message });
  assert.equal(handled, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].options.reply_markup.inline_keyboard[0][0].url, doc.requiredChannelLink);

  status = "member";
  await bot.processUpdate({ message });
  await bot.processUpdate({ message });
  assert.equal(handled, 2);
  assert.equal(subscriberWrites, 1);
  assert.equal(membershipChecks, 2);
});

test("each bot instance gets the correct token-free JavaScript file", async () => {
  for (const [type, moduleName] of [
    ["smm", "smm-panel"],
    ["qr", "qr-generator"],
    ["nickname", "nickname-font"],
    ["footer", "channel-footer"],
    ["watermark", "watermark"],
    ["music", "music-search"],
    ["file-editor", "file-editor"],
    ["image-text", "image-text-editor"],
  ]) {
    const botId = 8_000_000_000_000 + Math.floor(Math.random() * 1_000_000);
    const doc = { _id: botId, type, token: "must-not-be-written" };
    const filePath = generatedFilePath(botId);
    try {
      await writeGeneratedBotFile(doc);
      const source = await fs.readFile(filePath, "utf8");
      const generated = require(filePath);
      assert.equal(generated.botId, botId);
      assert.equal(generated.register, require(`../bots/${moduleName}`));
      assert.doesNotMatch(source, /must-not-be-written/);
    } finally {
      await removeGeneratedBotFile(botId);
    }
  }
});

test("music bot searches licensed Jamendo tracks and reuses Telegram file IDs", async () => {
  const bot = new BotConstructor("test-token");
  const replies = [];
  const audioRequests = [];
  const fetchRequests = [];
  const licensedUrl = "https://prod-1.storage.jamendo.com/?trackid=123&format=mp31";
  const tracks = [
    {
      id: 123,
      name: "Open Song",
      artist_name: "Open Artist",
      duration: 125,
      audio: licensedUrl,
      shareurl: "https://www.jamendo.com/track/123",
      license_ccurl: "https://creativecommons.org/licenses/by/4.0/",
    },
    {
      id: 456,
      name: "Noncommercial Song",
      artist_name: "Artist",
      duration: 90,
      audio: "https://prod-1.storage.jamendo.com/?trackid=456&format=mp31",
      license_ccurl: "https://creativecommons.org/licenses/by-nc/4.0/",
    },
    {
      id: 789,
      name: "External Audio",
      artist_name: "Artist",
      duration: 90,
      audio: "https://example.com/song.mp3",
      license_ccurl: "https://creativecommons.org/licenses/by/4.0/",
    },
  ];
  const fetchImpl = async (url) => {
    fetchRequests.push(new URL(url));
    return {
      ok: true,
      json: async () => ({
        headers: { status: "success" },
        results: tracks,
      }),
    };
  };
  bot.api = async (method, payload) => {
    if (method === "sendAudio") {
      audioRequests.push(payload);
      return {
        audio: {
          file_id: payload.audio === licensedUrl ? "telegram-cached-file-id" : payload.audio,
        },
      };
    }
    return true;
  };
  bot.sendMessage = async (_chatId, text, options) => replies.push({ text, options });
  registerMusicSearchBot(bot, {
    doc: { _id: 456001 },
    clientId: "jamendo-client-id",
    fetchImpl,
  });

  const user = { id: 72 };
  const chat = { id: 72, type: "private" };
  await bot.processUpdate({
    message: { chat, from: user, text: "Open Song" },
  });
  assert.equal(fetchRequests.length, 1);
  assert.equal(fetchRequests[0].searchParams.get("namesearch"), "Open Song");
  assert.equal(fetchRequests[0].searchParams.get("audioformat"), "mp31");
  assert.match(replies[0].text, /Open Song — Open Artist/);
  assert.doesNotMatch(replies[0].text, /Noncommercial Song|External Audio/);
  const playButton = replies[0].options.reply_markup.inline_keyboard[0][0];
  assert.equal(playButton.callback_data, "music:play:0");

  const play = async () => bot.processUpdate({
    callback_query: {
      id: `play-${audioRequests.length}`,
      data: "music:play:0",
      from: user,
      message: { chat, message_id: 1 },
    },
  });
  await play();
  await play();

  assert.equal(audioRequests.length, 2);
  assert.equal(audioRequests[0].audio, licensedUrl);
  assert.equal(audioRequests[0].title, "Open Song");
  assert.equal(audioRequests[0].performer, "Open Artist");
  assert.match(audioRequests[0].caption, /creativecommons\.org\/licenses\/by\/4\.0/);
  assert.equal(audioRequests[1].audio, "telegram-cached-file-id");
});

test("image text editor replaces only the sample title", async () => {
  const bot = new BotConstructor("test-token");
  const sent = [];
  bot.sendPhoto = async (...args) => sent.push(args);
  bot.sendMessage = async () => ({ message_id: 1 });
  registerImageTextEditor(bot);
  const user = { id: 33 };
  const chat = { id: 33, type: "private" };

  await bot.processUpdate({
    message: {
      chat,
      from: user,
      text: "/start",
    },
  });
  for (const text of ["My Quantity", "My Product", "9001", "9:30", "88"]) {
    await bot.processUpdate({
      message: {
        chat,
        from: user,
        text,
      },
    });
  }

  assert.equal(sent.length, 2);
  assert.equal(sent[1][2], "edited-uzum.png");
  const original = await fs.readFile(path.join(__dirname, "..", "images", "uzum.png"));
  const [originalMetadata, resultMetadata] = await Promise.all([
    sharp(original).metadata(),
    sharp(sent[1][1]).metadata(),
  ]);
  assert.equal(resultMetadata.width, originalMetadata.width);
  assert.equal(resultMetadata.height, originalMetadata.height);

  const originalPhoneArea = await sharp(original)
    .extract({ left: 0, top: 600, width: 768, height: 1106 })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const resultPhoneArea = await sharp(sent[1][1])
    .extract({ left: 0, top: 600, width: 768, height: 1106 })
    .ensureAlpha()
    .raw()
    .toBuffer();
  assert.equal(Buffer.compare(resultPhoneArea, originalPhoneArea), 0);
  await assert.rejects(replaceTemplateTitle("A".repeat(49)), /belgi/);
});

test("image text editor direct text is backward compatible", async () => {
  const bot = new BotConstructor("test-token");
  const sent = [];
  bot.sendPhoto = async (...args) => sent.push(args);
  registerImageTextEditor(bot);
  const user = { id: 34 };
  const chat = { id: 34, type: "private" };

  await bot.processUpdate({
    message: {
      chat,
      from: user,
      text: "My New Title",
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0][2], "edited-uzum.png");
  const original = await fs.readFile(path.join(__dirname, "..", "images", "uzum.png"));
  const [originalMetadata, resultMetadata] = await Promise.all([
    sharp(original).metadata(),
    sharp(sent[0][1]).metadata(),
  ]);
  assert.equal(resultMetadata.width, originalMetadata.width);
  assert.equal(resultMetadata.height, originalMetadata.height);

  const originalPhoneArea = await sharp(original)
    .extract({ left: 0, top: 600, width: 768, height: 1106 })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const resultPhoneArea = await sharp(sent[0][1])
    .extract({ left: 0, top: 600, width: 768, height: 1106 })
    .ensureAlpha()
    .raw()
    .toBuffer();
  assert.equal(Buffer.compare(resultPhoneArea, originalPhoneArea), 0);
  await assert.rejects(replaceTemplateTitle("A".repeat(49)), /belgi/);
});

test("channel footer template appends to channel posts and preserves entities", async () => {
  const bot = new BotConstructor("test-token");
  const doc = { _id: 456, ownerId: 123, username: "footer_bot" };
  const settings = {
    botId: doc._id,
    channelId: -1001,
    enabled: true,
    footer: {
      text: "Read more",
      entities: [{ type: "italic", offset: 0, length: 4 }],
    },
  };
  const edits = [];
  const Settings = {
    findOne: async (filter) => (filter.channelId === -1001 ? settings : null),
    updateOne: async () => {},
  };
  bot.api = async (method, payload) => {
    edits.push({ method, payload });
    return true;
  };
  registerChannelFooter(bot, { doc, Settings });

  await bot.processUpdate({
    channel_post: {
      chat: { id: -1001, type: "channel", title: "Test channel" },
      message_id: 7,
      text: "New post",
      entities: [{ type: "bold", offset: 0, length: 3 }],
      reply_markup: { inline_keyboard: [] },
    },
  });

  assert.equal(edits.length, 1);
  assert.equal(edits[0].method, "editMessageText");
  assert.equal(edits[0].payload.text, "New post\n\nRead more");
  assert.deepEqual(edits[0].payload.entities, [
    { type: "bold", offset: 0, length: 3 },
    { type: "italic", offset: 10, length: 4 },
  ]);
  assert.deepEqual(edits[0].payload.reply_markup, { inline_keyboard: [] });

  await bot.processUpdate({
    channel_post: {
      chat: { id: -1001, type: "channel", title: "Test channel" },
      message_id: 8,
      photo: [{ file_id: "photo" }],
      caption: "Photo caption",
      caption_entities: [{ type: "bold", offset: 0, length: 5 }],
    },
  });
  assert.equal(edits[1].method, "editMessageCaption");
  assert.equal(edits[1].payload.caption, "Photo caption\n\nRead more");
  assert.deepEqual(edits[1].payload.caption_entities, [
    { type: "bold", offset: 0, length: 5 },
    { type: "italic", offset: 15, length: 4 },
  ]);
});

test("channel footer owner can save formatted text and select an authorized channel", async () => {
  const bot = new BotConstructor("test-token");
  const doc = { _id: 456, ownerId: 123, username: "footer_bot" };
  let settings = null;
  const updates = [];
  const replies = [];
  const Settings = {
    findOne: async (filter) => {
      if (filter.channelId) return null;
      return settings;
    },
    updateOne: async (_filter, update) => {
      updates.push(update);
      settings = {
        ...settings,
        ...update.$set,
      };
      if (update.$unset) {
        for (const key of Object.keys(update.$unset)) delete settings[key];
      }
    },
  };
  bot.api = async (method) => {
    if (method === "getChat") {
      return { id: -1001, type: "channel", title: "Test channel" };
    }
    if (method === "getChatMember") {
      return {
        status: "administrator",
        can_edit_messages: true,
      };
    }
    throw new Error(`Unexpected API method: ${method}`);
  };
  bot.sendMessage = async (_chatId, text, options) => replies.push({ text, options });
  const controls = registerChannelFooter(bot, { doc, Settings });

  await bot.processUpdate({
    message: {
      chat: { id: doc.ownerId, type: "private" },
      from: { id: doc.ownerId },
      text: "/start",
    },
  });
  const channelButton =
    replies[0].options.reply_markup.keyboard[0][1].request_chat;
  assert.equal(channelButton.chat_is_channel, true);
  assert.equal(channelButton.user_administrator_rights.can_promote_members, true);
  assert.equal(channelButton.bot_administrator_rights.can_edit_messages, true);

  await bot.processUpdate({
    message: {
      chat: { id: doc.ownerId, type: "private" },
      from: { id: doc.ownerId },
      text: "✍️ Matn o'rnatish",
    },
  });
  await bot.processUpdate({
    message: {
      chat: { id: doc.ownerId, type: "private" },
      from: { id: doc.ownerId },
      text: "Read this",
      entities: [{ type: "bold", offset: 0, length: 4 }],
    },
  });
  assert.deepEqual(settings.footer, {
    text: "Read this",
    entities: [{ type: "bold", offset: 0, length: 4 }],
  });

  await bot.processUpdate({
    message: {
      chat: { id: doc.ownerId, type: "private" },
      from: { id: doc.ownerId },
      chat_shared: { request_id: 1, chat_id: -1001 },
    },
  });
  assert.equal(settings.channelId, -1001);
  assert.equal(settings.channelTitle, "Test channel");
  assert.equal(replies.at(-1).text, "✅ Kanal ulandi: Test channel");

  settings.awaiting = true;
  assert.equal(await controls.cancelPending({ from: { id: doc.ownerId } }), true);
  assert.equal(settings.awaiting, false);
  assert.ok(updates.length >= 4);
});

test("watermark processing supports requested ratios, logo shapes, and positions", async () => {
  const image = await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: "#ffffff",
    },
  }).png().toBuffer();
  const logo = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: "#e11d48",
    },
  }).png().toBuffer();

  const cases = [
    { size: "original", width: 320, height: 240, position: "topRight", shape: "original" },
    { size: "landscape", width: 1280, height: 720, position: "topLeft", shape: "square" },
    { size: "portrait", width: 720, height: 1280, position: "bottomCenter", shape: "round" },
    { size: "square", width: 1080, height: 1080, position: "topRight", shape: "round" },
    { size: "threeFour", width: 900, height: 1200, position: "bottomCenter", shape: "original" },
  ];

  for (const options of cases) {
    const output = await createWatermarkedImage({
      imageBuffer: image,
      logoBuffer: logo,
      ...options,
    });
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, options.width);
    assert.equal(metadata.height, options.height);
    assert.equal(metadata.format, "jpeg");
  }
});

test("watermark logo size can be reduced or enlarged", async () => {
  const image = await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: "#ffffff",
    },
  }).png().toBuffer();
  const logo = await sharp({
    create: {
      width: 80,
      height: 80,
      channels: 3,
      background: "#ef4444",
    },
  }).png().toBuffer();

  const countLogoPixels = async (logoScale) => {
    const result = await createWatermarkedImage({
      imageBuffer: image,
      logoBuffer: logo,
      shape: "square",
      position: "topLeft",
      logoScale,
    });
    const { data } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
    let count = 0;
    for (let index = 0; index < data.length; index += 3) {
      if (data[index] - data[index + 1] > 70) count++;
    }
    return count;
  };

  const smallLogoPixels = await countLogoPixels("small");
  const largeLogoPixels = await countLogoPixels("xlarge");
  assert.ok(smallLogoPixels > 0);
  assert.ok(largeLogoPixels > smallLogoPixels * 5);
});

test("watermark bot accepts PNG documents and processes uploaded files", async () => {
  const bot = new BotConstructor("test-token");
  const doc = { _id: 456, username: "watermark_bot" };
  const profiles = new Map();
  const logo = await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 3,
      background: "#ef4444",
    },
  }).png().toBuffer();
  const photo = await sharp({
    create: {
      width: 100,
      height: 80,
      channels: 3,
      background: "#ffffff",
    },
  }).png().toBuffer();
  const sentPhotos = [];
  const replies = [];
  const edits = [];
  const WatermarkProfiles = {
    findOne: async ({ botId, userId }) => profiles.get(`${botId}:${userId}`) || null,
    updateOne: async ({ botId, userId }, update) => {
      const key = `${botId}:${userId}`;
      const profile = profiles.get(key) || {};
      Object.assign(profile, update.$setOnInsert, update.$set);
      for (const field of Object.keys(update.$unset || {})) delete profile[field];
      profiles.set(key, profile);
    },
  };
  bot.api = async (method, payload) => {
    if (method === "getFile") {
      return { file_path: payload.file_id === "logo" ? "logo.png" : "photo.png" };
    }
    if (method === "editMessageText") edits.push(payload);
    return true;
  };
  bot.downloadFile = async (filePath) => filePath === "logo.png" ? logo : photo;
  bot.sendMessage = async (_chatId, text, options) => replies.push({ text, options });
  bot.sendPhoto = async (...args) => sentPhotos.push(args);
  registerWatermarkBot(bot, { doc, WatermarkProfiles });

  const user = { id: 22 };
  const chat = { id: 22, type: "private" };
  const callback = async (data) => bot.processUpdate({
    callback_query: {
      id: data,
      data,
      from: user,
      message: { chat, message_id: 1 },
    },
  });

  await bot.processUpdate({
    message: { chat, from: user, text: "/start" },
  });
  assert.match(replies[0].text, /Watermark bot/);
  assert.deepEqual(
    replies[0].options.reply_markup.keyboard.flat().map((button) => button.text),
    ["📚 Shablonlar", "🖨 Pechat bosish"],
  );
  await bot.processUpdate({
    message: { chat, from: user, text: "Shablonlar" },
  });
  assert.ok(
    replies.at(-1).options.reply_markup.inline_keyboard.flat()
      .some((button) => button.callback_data === "wm:new-template"),
  );
  await callback("wm:new-template");
  assert.equal(profiles.get("456:22").awaiting, "template-name");
  await bot.processUpdate({
    message: { chat, from: user, text: "Namuna1" },
  });
  assert.equal(profiles.get("456:22").pendingTemplateName, "Namuna1");
  await bot.processUpdate({
    message: {
      chat,
      from: user,
      document: {
        file_id: "logo",
        mime_type: "application/octet-stream",
        file_name: "my-logo.png",
      },
    },
  });
  assert.ok(Buffer.isBuffer(profiles.get("456:22").templates[0].logo));
  assert.equal(profiles.get("456:22").awaiting, null);
  const firstTemplate = profiles.get("456:22").templates[0];
  assert.equal(firstTemplate.name, "Namuna1");

  await callback(`wm:manage:${firstTemplate.id}`);
  assert.match(edits.at(-1).text, /Namuna1 sozlamalari/);
  assert.deepEqual(
    edits.at(-1).reply_markup.inline_keyboard.flat().map((button) => button.callback_data),
    [
      `wm:template-logo:${firstTemplate.id}`,
      `wm:template-shape:${firstTemplate.id}`,
      `wm:template-scale:${firstTemplate.id}`,
      `wm:template-position:${firstTemplate.id}`,
      `wm:template-name:${firstTemplate.id}`,
      `wm:template-delete:${firstTemplate.id}`,
      "wm:templates",
    ],
  );
  await callback(`wm:template-name:${firstTemplate.id}`);
  await bot.processUpdate({
    message: { chat, from: user, text: "Brend logosi" },
  });
  assert.equal(
    profiles.get("456:22").templates[0].name,
    "Brend logosi",
  );
  await callback(`wm:template-shape:${firstTemplate.id}`);
  await callback(`wm:set-shape:${firstTemplate.id}:round`);
  await callback(`wm:template-position:${firstTemplate.id}`);
  await callback(`wm:set-position:${firstTemplate.id}:bottomCenter`);
  await callback(`wm:template-scale:${firstTemplate.id}`);
  assert.deepEqual(
    edits.at(-1).reply_markup.inline_keyboard[0].map((button) => button.text),
    ["8%", "10%", "20%", "30%"],
  );
  await callback(`wm:set-scale:${firstTemplate.id}:8`);

  await bot.processUpdate({
    message: { chat, from: user, text: "Shablonlar" },
  });
  await callback("wm:new-template");
  await bot.processUpdate({
    message: { chat, from: user, text: "Namuna2" },
  });
  assert.equal(profiles.get("456:22").pendingTemplateName, "Namuna2");
  await bot.processUpdate({
    message: {
      chat,
      from: user,
      document: {
        file_id: "logo",
        mime_type: "image/png",
        file_name: "second-logo.png",
      },
    },
  });
  const secondTemplate = profiles.get("456:22").templates.find(
    (template) => template.name === "Namuna2",
  );
  assert.ok(secondTemplate);
  const savedFirstTemplate = profiles.get("456:22").templates.find(
    (template) => template.id === firstTemplate.id,
  );
  assert.equal(savedFirstTemplate.shape, "round");
  assert.equal(savedFirstTemplate.position, "bottomCenter");
  assert.equal(savedFirstTemplate.logoScale, "8");
  await callback(`wm:manage:${secondTemplate.id}`);
  await callback(`wm:template-scale:${secondTemplate.id}`);
  await callback(`wm:set-scale:${secondTemplate.id}:20`);
  const savedTemplates = profiles.get("456:22").templates;
  assert.equal(savedTemplates.find((item) => item.id === firstTemplate.id).logoScale, "8");
  assert.equal(savedTemplates.find((item) => item.id === secondTemplate.id).logoScale, "20");

  await bot.processUpdate({
    message: {
      chat,
      from: user,
      document: {
        file_id: "photo",
        mime_type: "image/png",
        file_name: "image.png",
      },
    },
  });
  assert.match(replies.at(-1).text, /qaysi watermark shablonini/i);
  const useTemplateButton = replies.at(-1).options.reply_markup.inline_keyboard
    .flat()
    .find((button) => button.callback_data === `wm:use-template:${secondTemplate.id}`);
  assert.ok(useTemplateButton);
  await callback(useTemplateButton.callback_data);
  assert.equal(sentPhotos.length, 1);
  assert.match(sentPhotos[0][3].caption, /Namuna2/);

  await callback(`wm:template-delete:${secondTemplate.id}`);
  const confirmationButtons = edits.at(-1).reply_markup.inline_keyboard.flat();
  assert.ok(confirmationButtons.some(
    (button) => button.callback_data === `wm:confirm-delete:${secondTemplate.id}`,
  ));
  await callback(`wm:manage:${secondTemplate.id}`);
  assert.ok(profiles.get("456:22").templates.some(
    (template) => template.id === secondTemplate.id,
  ));
  await callback(`wm:template-delete:${secondTemplate.id}`);
  await callback(`wm:confirm-delete:${secondTemplate.id}`);
  assert.ok(!profiles.get("456:22").templates.some(
    (template) => template.id === secondTemplate.id,
  ));
  assert.ok(profiles.get("456:22").templates.some(
    (template) => template.id === firstTemplate.id,
  ));

  await bot.processUpdate({
    message: { chat, from: user, text: "Pechat bosish" },
  });
  const printTemplateButton = replies.at(-1).options.reply_markup.inline_keyboard
    .flat()
    .find((button) => button.callback_data === `wm:print-template:${firstTemplate.id}`);
  assert.ok(printTemplateButton);
  await callback(printTemplateButton.callback_data);
  await bot.processUpdate({
    message: {
      chat,
      from: user,
      document: {
        file_id: "photo",
        mime_type: "image/png",
        file_name: "image.png",
      },
    },
  });
  assert.equal(sentPhotos.length, 2);
  assert.match(sentPhotos[1][3].caption, /Brend logosi/);
  const outputMetadata = await sharp(sentPhotos[1][1]).metadata();
  assert.equal(outputMetadata.width, 100);
  assert.equal(outputMetadata.height, 80);
  assert.equal(profiles.get("456:22").awaiting, null);
});

test("legacy bot documents are migrated to QR, existing template choices stay unchanged", async () => {
  const updates = [];
  const Bots = {
    updateOne: async (filter, update) => updates.push({ filter, update }),
  };
  const legacyDoc = { _id: 11, type: "nickname", commands: [] };
  const currentNicknameDoc = { _id: 12, type: "nickname" };

  await normalizeBotType(legacyDoc, Bots);
  await normalizeBotType(currentNicknameDoc, Bots);

  assert.equal(legacyDoc.type, "qr");
  assert.equal("commands" in legacyDoc, false);
  assert.equal(currentNicknameDoc.type, "nickname");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].update, {
    $set: { type: "qr" },
    $unset: { commands: "" },
  });
});

test("bot admin panel rejects non-owners and lets owner set channel", async () => {
  const bot = new BotConstructor("test-token");
  const doc = { _id: 789, ownerId: 55, username: "admin_bot" };
  bot.config = doc;
  const updates = [];
  const replies = [];
  const edits = [];
  const sentMessages = [];
  const Bots = {
    updateOne: async (_filter, update) => updates.push(update),
  };
  const Subs = {
    countDocuments: async () => 0,
    find: () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { userId: 101 };
        yield { userId: 102 };
      },
    }),
  };
  bot.api = async (method) => {
    if (method === "getChat") {
      return { id: -100123, title: "Test channel", username: "test_channel" };
    }
    if (method === "getChatMember") return { status: "administrator" };
    return true;
  };
  bot.sendMessage = async (chatId, text) => {
    replies.push(text);
    sentMessages.push({ chatId, text });
  };
  bot.editMessageText = async (_chatId, _messageId, text) => edits.push(text);
  registerAdminPanel(bot, { doc, Bots, Subs });

  await bot.processUpdate({
    message: {
      chat: { id: 90, type: "private" },
      from: { id: 90 },
      text: "/admin",
    },
  });
  assert.match(replies[0], /faqat bot egasi/);

  await bot.processUpdate({
    message: {
      chat: { id: 55, type: "private" },
      from: { id: 55 },
      text: "/admin",
    },
  });
  assert.match(replies[1], /admin paneli/);

  const ownerMessage = {
    chat: { id: 55, type: "private" },
    from: { id: 55 },
    message_id: 1,
  };
  await bot.processUpdate({
    callback_query: {
      id: "stats",
      data: "admin:stats",
      from: ownerMessage.from,
      message: ownerMessage,
    },
  });
  assert.match(edits.at(-1), /Jami foydalanuvchi/);

  await bot.processUpdate({
    callback_query: {
      id: "welcome",
      data: "admin:welcome",
      from: ownerMessage.from,
      message: ownerMessage,
    },
  });
  await bot.processUpdate({
    message: { ...ownerMessage, text: "Yangi salomlashuv" },
  });
  assert.equal(bot.config.welcome, "Yangi salomlashuv");

  await bot.processUpdate({
    callback_query: {
      id: "broadcast",
      data: "admin:broadcast",
      from: ownerMessage.from,
      message: ownerMessage,
    },
  });
  await bot.processUpdate({
    message: { ...ownerMessage, text: "Sinov xabari" },
  });
  assert.equal(sentMessages.filter((message) => message.chatId === 101 || message.chatId === 102).length, 2);

  await bot.processUpdate({
    callback_query: {
      id: "channel",
      data: "admin:channel",
      from: ownerMessage.from,
      message: ownerMessage,
    },
  });
  await bot.processUpdate({
    message: { ...ownerMessage, text: "@test_channel" },
  });

  assert.equal(bot.config.requiredChannel, -100123);
  assert.equal(bot.config.requiredChannelLink, "https://t.me/test_channel");
  assert.equal(updates.length, 2);
  assert.match(replies.at(-1), /Majburiy kanal sozlandi/);
  assert.ok(edits.length > 0);
});
