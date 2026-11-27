"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { BotConstructor } = require("../bot-constructor");
const { BOT_TYPES } = require("../bots/generated-file");
const {
  buildMiniAppUrl,
  formatInterval,
  getDialogKind,
  parseInterval,
  registerUserScheduler,
  validateWebAppInitData,
} = require("../bots/user-scheduler");

function signedInitData(botToken, userId, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "query-1",
    user: JSON.stringify({ id: userId }),
    signature: "third-party-signature",
  });
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

test("user scheduler is registered as a generated bot type", () => {
  assert.equal(BOT_TYPES["user-scheduler"].module, "user-scheduler");
  assert.equal(BOT_TYPES["user-scheduler"].runtime, undefined);
  assert.equal(typeof require("../bots/user-scheduler"), "function");
});

test("user scheduler interval supports ten seconds to thirty days", () => {
  assert.equal(parseInterval("00:00:10"), 10);
  assert.equal(parseInterval("00:01:30"), 90);
  assert.equal(parseInterval("01:30"), 5_400);
  assert.equal(parseInterval("720:00:00"), 2_592_000);
  assert.equal(formatInterval(90), "00:01:30");
  assert.equal(formatInterval(5_400), "01:30:00");
  assert.throws(() => parseInterval("00:00:09"), /10 soniya/);
  assert.throws(() => parseInterval("720:00:01"), /30 kundan/);
  assert.throws(() => parseInterval("1h"), /soat:daqiqa/);
});

test("Mini App URL requires HTTPS and preserves the configured path prefix", () => {
  assert.equal(
    buildMiniAppUrl("https://maker.example/base/", 123456),
    "https://maker.example/base/user-scheduler/app/123456",
  );
  assert.equal(buildMiniAppUrl("http://maker.example", 123456), null);
  assert.equal(buildMiniAppUrl("https://maker.example?key=value", 123456), null);
});

test("Mini App initData verifies Telegram signatures, owner data, and freshness", () => {
  const token = "123456:bot-token";
  const now = Date.now();
  const valid = signedInitData(token, 77, Math.floor(now / 1000));
  assert.deepEqual(validateWebAppInitData(valid, token, now), { id: 77 });
  assert.throws(() => validateWebAppInitData(valid, "wrong-token", now), /noto'g'ri/);
  const changedSignature = new URLSearchParams(valid);
  changedSignature.set("signature", "changed");
  assert.throws(
    () => validateWebAppInitData(changedSignature.toString(), token, now),
    /noto'g'ri/,
  );

  const stale = signedInitData(token, 77, Math.floor(now / 1000) - 11 * 60);
  assert.throws(() => validateWebAppInitData(stale, token, now), /eskirgan/);
});

test("Mini App API only returns login status to the signed bot owner", async () => {
  const bot = new BotConstructor("test-token");
  const runtime = registerUserScheduler(bot, {
    doc: { _id: 123456, ownerId: 77 },
    Bots: { updateOne: async () => ({ matchedCount: 1 }) },
    encryptSecret: (value) => value,
    decryptSecret: (value) => value,
  });

  assert.deepEqual(
    await runtime.handleApiRequest("status", {
      initData: signedInitData(bot.token, 77),
    }),
    { phase: "idle", message: "Ulashga tayyor." },
  );
  await assert.rejects(
    runtime.handleApiRequest("status", {
      initData: signedInitData(bot.token, 88),
    }),
    { statusCode: 403 },
  );
  await runtime.stop();
});

test("groups and channels are selectable without admin rights, but not after leaving", () => {
  assert.equal(
    getDialogKind({
      isGroup: true,
      entity: { className: "Chat" },
    }),
    "groups",
  );
  assert.equal(
    getDialogKind({
      isChannel: true,
      entity: { className: "Channel", broadcast: true },
    }),
    "channels",
  );
  assert.equal(
    getDialogKind({
      isChannel: true,
      entity: { className: "Channel", broadcast: false, megagroup: true },
    }),
    "groups",
  );
  assert.equal(
    getDialogKind({
      isGroup: true,
      entity: { className: "Chat", left: true },
    }),
    null,
  );
  assert.equal(
    getDialogKind({ entity: { className: "User" } }),
    null,
  );
});

test("user scheduler panel only responds to its owner in a private chat", async () => {
  const bot = new BotConstructor("test-token");
  const replies = [];
  const callbackAnswers = [];
  bot.sendMessage = async (chatId, text, options) => {
    replies.push({ chatId, text, options });
  };
  bot.answerCallbackQuery = async (id, options) => callbackAnswers.push({ id, options });
  const runtime = registerUserScheduler(bot, {
    doc: {
      _id: 123456,
      ownerId: 77,
      userSchedule: { intervalMinutes: 60 },
    },
    Bots: { updateOne: async () => ({ matchedCount: 1 }) },
    encryptSecret: (value) => value,
    decryptSecret: (value) => value,
  });

  await bot.processUpdate({
    message: {
      chat: { id: 77, type: "private" },
      from: { id: 77 },
      text: "/start",
    },
  });
  await bot.processUpdate({
    message: {
      chat: { id: 88, type: "private" },
      from: { id: 88 },
      text: "/start",
    },
  });
  await bot.processUpdate({
    callback_query: {
      id: "unauthorized",
      from: { id: 88 },
      message: { chat: { id: 88, type: "private" }, message_id: 1 },
      data: "userbot:panel",
    },
  });

  assert.equal(replies.length, 1);
  assert.equal(callbackAnswers.length, 1);
  assert.match(callbackAnswers[0].options.text, /bot egasi/);
  assert.match(replies[0].text, /USER BOT — BOSHQARUV PANELI/);
  assert.match(replies[0].text, /Interval: 01:00:00/);
  assert.equal(replies[0].options.reply_markup.inline_keyboard[0][0].style, "primary");
  await runtime.stop();
});

test("user scheduler cancel hook clears a pending message input", async () => {
  const bot = new BotConstructor("test-token");
  const replies = [];
  let updates = 0;
  bot.sendMessage = async (chatId, text, options) => {
    replies.push({ chatId, text, options });
  };
  bot.answerCallbackQuery = async () => ({});
  const runtime = registerUserScheduler(bot, {
    doc: { _id: 123456, ownerId: 77 },
    Bots: {
      updateOne: async () => {
        updates++;
        return { matchedCount: 1 };
      },
    },
    encryptSecret: (value) => value,
    decryptSecret: (value) => value,
  });
  const owner = { id: 77 };
  const privateChat = { id: 77, type: "private" };

  await bot.processUpdate({
    callback_query: {
      id: "callback-1",
      from: owner,
      message: { chat: privateChat, message_id: 1 },
      data: "userbot:message",
    },
  });
  assert.equal(await runtime.cancelPending(), true);
  await bot.processUpdate({
    message: { chat: privateChat, from: owner, text: "should not be stored" },
  });

  assert.equal(updates, 0);
  assert.match(replies[0].text, /Takror yuboriladigan xabar/);
  await runtime.stop();
});

test("user scheduler stores media and forwarding details from the submitted Telegram message", async () => {
  const bot = new BotConstructor("test-token");
  const replies = [];
  const doc = { _id: 123456, ownerId: 77 };
  bot.sendMessage = async (chatId, text, options) => {
    replies.push({ chatId, text, options });
  };
  bot.answerCallbackQuery = async () => ({});
  const runtime = registerUserScheduler(bot, {
    doc,
    Bots: { updateOne: async () => ({ matchedCount: 1 }) },
    encryptSecret: (value) => value,
    decryptSecret: (value) => value,
  });
  const owner = { id: 77 };
  const privateChat = { id: 77, type: "private" };

  await bot.processUpdate({
    callback_query: {
      id: "message-mode",
      from: owner,
      message: { chat: privateChat, message_id: 1 },
      data: "userbot:message",
    },
  });
  await bot.processUpdate({
    message: {
      message_id: 23,
      chat: privateChat,
      from: owner,
      photo: [{ file_id: "photo" }],
      caption: "caption",
      forward_origin: { type: "user", sender_user: { id: 99 } },
    },
  });

  assert.deepEqual(doc.userSchedule.messageRef, {
    messageIds: [23],
    forwarded: true,
    description: "rasm",
  });
  assert.equal(doc.userSchedule.message, "");
  assert.match(replies[1].text, /Xabar jadval uchun saqlandi/);
  await runtime.stop();
});

test("user scheduler collects media album messages before saving the reference", async () => {
  const bot = new BotConstructor("test-token");
  const doc = { _id: 123456, ownerId: 77 };
  bot.sendMessage = async () => ({});
  bot.answerCallbackQuery = async () => ({});
  const runtime = registerUserScheduler(bot, {
    doc,
    Bots: { updateOne: async () => ({ matchedCount: 1 }) },
    encryptSecret: (value) => value,
    decryptSecret: (value) => value,
  });
  const owner = { id: 77 };
  const privateChat = { id: 77, type: "private" };

  await bot.processUpdate({
    callback_query: {
      id: "album-mode",
      from: owner,
      message: { chat: privateChat, message_id: 1 },
      data: "userbot:message",
    },
  });
  for (const messageId of [30, 31]) {
    await bot.processUpdate({
      message: {
        message_id: messageId,
        media_group_id: "album-1",
        chat: privateChat,
        from: owner,
        photo: [{ file_id: `photo-${messageId}` }],
      },
    });
  }
  await runtime.stop();

  assert.deepEqual(doc.userSchedule.messageRef.messageIds, [30, 31]);
  assert.equal(doc.userSchedule.messageRef.description, "rasm");
});

test("native chat picker accepts a shared group outside the recent dialog list", async () => {
  const bot = new BotConstructor("test-token");
  const replies = [];
  const doc = {
    _id: 123456,
    ownerId: 77,
    username: "test_user_bot",
    userSessionEncrypted: "encrypted-session",
    userAccount: { id: "77" },
  };
  const group = { className: "Chat", title: "Shared group" };
  const client = {
    connect: async () => {},
    checkAuthorization: async () => true,
    getMe: async () => ({ id: 77, username: "owner" }),
    getDialogs: async () => [],
    getEntity: async (id) => {
      assert.equal(String(id), "-100777");
      return group;
    },
    getPeerId: async () => "peer-777",
    disconnect: async () => {},
  };
  bot.sendMessage = async (chatId, text, options) => {
    replies.push({ chatId, text, options });
  };
  bot.answerCallbackQuery = async () => ({});
  const oldApiId = process.env.TELEGRAM_API_ID;
  const oldApiHash = process.env.TELEGRAM_API_HASH;
  process.env.TELEGRAM_API_ID = "12345";
  process.env.TELEGRAM_API_HASH = "test-api-hash";
  const runtime = registerUserScheduler(bot, {
    doc,
    Bots: { updateOne: async () => ({ matchedCount: 1 }) },
    encryptSecret: (value) => value,
    decryptSecret: (value) => value,
    createTelegramClient: () => client,
  });

  try {
    await runtime.start();
    await bot.processUpdate({
      callback_query: {
        id: "select-chat",
        from: { id: 77 },
        message: { chat: { id: 77, type: "private" }, message_id: 1 },
        data: "userbot:chats",
      },
    });
    const keyboard = replies[0].options.reply_markup.keyboard;
    assert.ok(keyboard[0][0].request_chat);
    assert.ok(keyboard[0][1].request_chat);
    assert.equal(keyboard[0][0].request_chat.chat_is_channel, false);
    assert.equal(keyboard[0][1].request_chat.chat_is_channel, true);

    await bot.processUpdate({
      message: {
        message_id: 2,
        chat: { id: 77, type: "private" },
        from: { id: 77 },
        chat_shared: {
          request_id: keyboard[0][0].request_chat.request_id,
          chat_id: -100777,
          title: "Shared group",
        },
      },
    });
    assert.deepEqual(doc.userSchedule.chatIds, ["peer-777"]);
    assert.match(replies[1].text, /Chat jadvalga qo'shildi/);
  } finally {
    await runtime.stop();
    if (oldApiId === undefined) delete process.env.TELEGRAM_API_ID;
    else process.env.TELEGRAM_API_ID = oldApiId;
    if (oldApiHash === undefined) delete process.env.TELEGRAM_API_HASH;
    else process.env.TELEGRAM_API_HASH = oldApiHash;
  }
});

test("scheduled messages copy owner forwards and preserve third-party forwards", async (t) => {
  const oldApiId = process.env.TELEGRAM_API_ID;
  const oldApiHash = process.env.TELEGRAM_API_HASH;
  process.env.TELEGRAM_API_ID = "12345";
  process.env.TELEGRAM_API_HASH = "test-api-hash";

  try {
    for (const forwarded of [false, true]) {
      await t.test(forwarded ? "third-party forward" : "owner-authored forward", async () => {
        const bot = new BotConstructor("test-token");
        const doc = {
          _id: 123456,
          ownerId: 77,
          username: "test_user_bot",
          userSessionEncrypted: "encrypted-session",
          userAccount: { id: "77" },
          userSchedule: {
            message: "",
            messageRef: { messageIds: [42], forwarded, description: "video" },
            intervalSeconds: 10,
            chatIds: ["peer-1"],
            enabled: true,
            nextRunAt: new Date(Date.now() - 1_000),
          },
        };
        let sendResolve;
        let sendTimer;
        const sendCalled = new Promise((resolve, reject) => {
          sendResolve = resolve;
          sendTimer = setTimeout(() => reject(new Error("Scheduled send timed out")), 2_000);
        });
        const calls = [];
        const groupEntity = { className: "Chat", title: "Group" };
        const client = {
          connect: async () => {},
          checkAuthorization: async () => true,
          getMe: async () => ({ id: 77, username: "owner" }),
          getDialogs: async () => [{ isGroup: true, title: "Group", entity: groupEntity }],
          getEntity: async () => ({ className: "User", username: "test_user_bot" }),
          getPeerId: async () => "peer-1",
          copyMessages: async (...args) => {
            calls.push({ method: "copy", args });
            clearTimeout(sendTimer);
            sendResolve();
            return [{ id: 1 }];
          },
          forwardMessages: async (...args) => {
            calls.push({ method: "forward", args });
            clearTimeout(sendTimer);
            sendResolve();
            return [{ id: 1 }];
          },
          disconnect: async () => {},
        };
        bot.sendMessage = async () => ({});
        const runtime = registerUserScheduler(bot, {
          doc,
          Bots: { updateOne: async () => ({ matchedCount: 1 }) },
          encryptSecret: (value) => value,
          decryptSecret: (value) => value,
          createTelegramClient: () => client,
        });

        try {
          await runtime.start();
          await sendCalled;
          assert.equal(calls.length, 1);
          assert.equal(calls[0].method, forwarded ? "forward" : "copy");
          assert.deepEqual(calls[0].args[1], {
            messages: [42],
            fromPeer: { className: "User", username: "test_user_bot" },
          });
        } finally {
          clearTimeout(sendTimer);
          await runtime.stop();
        }
      });
    }
  } finally {
    if (oldApiId === undefined) delete process.env.TELEGRAM_API_ID;
    else process.env.TELEGRAM_API_ID = oldApiId;
    if (oldApiHash === undefined) delete process.env.TELEGRAM_API_HASH;
    else process.env.TELEGRAM_API_HASH = oldApiHash;
  }
});
