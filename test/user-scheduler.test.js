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
  assert.match(replies[0].text, /Takror yuboriladigan matn/);
  await runtime.stop();
});
