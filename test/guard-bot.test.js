"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { GuardDatabase } = require("../bots/guard/database");
const { BOT_TYPES } = require("../bots/generated-file");
const { getBillingSettings } = require("../billing");
const {
  formatWelcome,
  hasBlockedWord,
  hasLink,
  isForwardedAdvertisement,
  parseBannedWords,
  validateFloodSettings,
} = require("../bots/guard-bot");
const { emojiButton, messageWithEmoji } = require("../bots/guard/emojis");

test("guard bot is available in the maker market and billing settings", () => {
  const settings = getBillingSettings();
  assert.equal(BOT_TYPES.guard.label, "Telegram Qorovul Bot");
  assert.deepEqual(settings.prices.guard, {
    initial: 10000,
    monthly: 1000,
    enabled: true,
  });
});

test("guard SQLite storage isolates groups, admins, warnings, and daily stats", () => {
  const database = new GuardDatabase(new (require("better-sqlite3"))(":memory:"));
  try {
    const group = database.claimGroup(100, -1001, "Test group", 11);
    assert.equal(group.ownerId, 11);
    assert.equal(group.captchaEnabled, true);

    assert.throws(
      () => database.claimGroup(100, -1001, "Hijack", 22),
      /boshqa bot adminiga/,
    );
    database.addAdmin(100, -1001, 33, 11);
    assert.equal(database.canManageGroup(100, -1001, 33), true);
    assert.equal(database.canManageGroup(101, -1001, 33), false);
    assert.deepEqual(
      database.listGroups(100, 33).map((item) => item.chatId),
      ["-1001"],
    );

    database.incrementWarn(100, -1001, 44);
    database.incrementWarn(100, -1001, 44);
    assert.equal(database.getWarnCount(100, -1001, 44), 2);
    database.setCaptcha(100, -1001, 55, Date.now() + 60_000);
    assert.ok(database.getCaptcha(100, -1001, 55));
    assert.equal(database.listCaptchas(100).length, 1);
    database.clearCaptcha(100, -1001, 55);
    assert.equal(database.getCaptcha(100, -1001, 55), null);
    database.logEvent(100, -1001, 44, "ban");
    database.logEvent(100, -1001, 44, "mute");
    database.recordActivity(100, -1001, 44);
    database.recordActivity(100, -1001, 44);
    assert.deepEqual(database.getStats(100, -1001), {
      bans: 1,
      mutes: 1,
      kicks: 0,
      warnings: 0,
      dailyActivity: 2,
    });

    database.updateGroup(100, -1001, { bannedWords: ["reklama"], captchaEnabled: false });
    assert.deepEqual(database.getGroup(100, -1001).bannedWords, ["reklama"]);
    assert.equal(database.getGroup(100, -1001).captchaEnabled, false);
    database.deleteBot(100);
    assert.equal(database.getGroup(100, -1001), null);
  } finally {
    database.close();
  }
});

test("guard moderation parsers validate flood limits and banned words", () => {
  assert.deepEqual(parseBannedWords("spam, Reklama\nspam"), ["spam", "reklama"]);
  assert.throws(() => parseBannedWords("x".repeat(65)), /64/);
  assert.throws(() => parseBannedWords(Array(101).fill("spam").join(",")), /100/);
  assert.deepEqual(validateFloodSettings("8 / 12"), {
    floodLimit: 8,
    floodWindowSeconds: 12,
  });
  assert.throws(() => validateFloodSettings("2/10"), /3–30/);
  assert.equal(hasBlockedWord("Bu REKLAMA matni", ["reklama"]), true);
  assert.equal(hasBlockedWord("oddiy xabar", ["reklama"]), false);
});

test("guard detects links and forwarded advertisements and formats welcome text", () => {
  assert.equal(hasLink({ text: "Reklama https://example.com" }), true);
  assert.equal(hasLink({ text: "link", entities: [{ type: "text_link" }] }), true);
  assert.equal(isForwardedAdvertisement({
    forward_origin: { type: "user" },
    text: "Kanalga obuna bo'ling https://t.me/example",
  }), true);
  assert.equal(isForwardedAdvertisement({
    forward_origin: { type: "user" },
    text: "Oddiy yangilik",
  }), false);
  assert.equal(
    formatWelcome("Salom, {name}! {group}", { first_name: "Ali" }, "Guruh"),
    "Salom, Ali! Guruh",
  );
});

test("premium emoji placeholders fall back until numeric custom IDs are configured", () => {
  assert.deepEqual(messageWithEmoji("captcha", "Tasdiqlang"), {
    text: "✅ Tasdiqlang",
  });
  assert.deepEqual(emojiButton("captcha", "Tasdiqlash", "captcha:1:2", "success"), {
    text: "✅ Tasdiqlash",
    callback_data: "captcha:1:2",
    style: "success",
  });
});
