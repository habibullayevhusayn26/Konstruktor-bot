"use strict";

const EMOJIS = Object.freeze({
  captcha: { fallback: "✅", customEmojiId: "PLACEHOLDER_ID_1" },
  cancel: { fallback: "❌", customEmojiId: "PLACEHOLDER_ID_2" },
  warn: { fallback: "⚠️", customEmojiId: "PLACEHOLDER_ID_3" },
  ban: { fallback: "🔒", customEmojiId: "PLACEHOLDER_ID_4" },
  panel: { fallback: "👑", customEmojiId: "PLACEHOLDER_ID_5" },
  stats: { fallback: "📊", customEmojiId: "PLACEHOLDER_ID_6" },
  welcome: { fallback: "👋", customEmojiId: "PLACEHOLDER_ID_7" },
  settings: { fallback: "⚙️", customEmojiId: "PLACEHOLDER_ID_8" },
  flood: { fallback: "🌊", customEmojiId: "PLACEHOLDER_ID_9" },
  words: { fallback: "🚫", customEmojiId: "PLACEHOLDER_ID_10" },
  group: { fallback: "👥", customEmojiId: "PLACEHOLDER_ID_11" },
  admin: { fallback: "🛡️", customEmojiId: "PLACEHOLDER_ID_12" },
});

function isConfigured(id) {
  return typeof id === "string" && /^\d+$/.test(id);
}

function messageWithEmoji(name, text) {
  const emoji = EMOJIS[name];
  if (!emoji) throw new Error(`Emoji sozlamasi topilmadi: ${name}`);

  const result = { text: `${emoji.fallback} ${text}` };
  if (isConfigured(emoji.customEmojiId)) {
    result.entities = [{
      type: "custom_emoji",
      offset: 0,
      length: emoji.fallback.length,
      custom_emoji_id: emoji.customEmojiId,
    }];
  }
  return result;
}

function emojiButton(name, text, callbackData, style) {
  const emoji = EMOJIS[name];
  if (!emoji) throw new Error(`Emoji sozlamasi topilmadi: ${name}`);

  return {
    text: isConfigured(emoji.customEmojiId)
      ? text
      : `${emoji.fallback} ${text}`,
    callback_data: callbackData,
    ...(style ? { style } : {}),
    ...(isConfigured(emoji.customEmojiId)
      ? { icon_custom_emoji_id: emoji.customEmojiId }
      : {}),
  };
}

module.exports = { EMOJIS, emojiButton, isConfigured, messageWithEmoji };
