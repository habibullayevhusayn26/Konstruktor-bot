"use strict";

const { Bot, InlineKeyboard, session } = require("grammy");
const { emojiButton, messageWithEmoji } = require("./guard/emojis");

const AD_TERMS = /\b(reklama|aksiya|chegirma|promo|bonus|obuna bo'ling|obuna boling|nakrutka|sotiladi|daromad toping)\b/i;
const LINK_PATTERN = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)\S+/i;
const MAX_WARNINGS = 3;
const MAX_BANNED_WORDS = 100;
const MAX_WORD_LENGTH = 64;
const SERVICE_MESSAGE_FIELDS = [
  "new_chat_members",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
  "managed_bot_created",
  "poll_option_added",
  "poll_option_deleted",
  "message_auto_delete_timer_changed",
  "migrate_to_chat_id",
  "migrate_from_chat_id",
  "pinned_message",
  "proximity_alert_triggered",
  "boost_added",
  "chat_background_set",
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
  "giveaway_created",
  "giveaway",
  "giveaway_winners",
  "giveaway_completed",
  "gift",
  "gift_upgrade_sent",
  "unique_gift",
  "paid_message_price_changed",
  "paid_messages_waived",
  "direct_message_price_changed",
  "video_chat_scheduled",
  "video_chat_started",
  "video_chat_ended",
  "video_chat_participants_invited",
  "checklist_tasks_done",
  "checklist_tasks_added",
  "community_chat_joined",
  "chat_owner_left",
  "chat_owner_changed",
  "suggested_post_info",
  "suggested_post_approved",
  "suggested_post_approval_failed",
  "suggested_post_declined",
  "suggested_post_paid",
  "suggested_post_refunded",
  "ton_wallet_transfer",
];

function messageText(message) {
  return message.text || message.caption || "";
}

function isServiceMessage(message) {
  return SERVICE_MESSAGE_FIELDS.some((field) => message[field] !== undefined);
}

function hasLink(message) {
  const entities = [...(message.entities || []), ...(message.caption_entities || [])];
  return entities.some((entity) => entity.type === "url" || entity.type === "text_link") ||
    LINK_PATTERN.test(messageText(message));
}

function isForwardedAdvertisement(message) {
  const forwarded = Boolean(
    message.forward_origin ||
    message.forward_from ||
    message.forward_from_chat ||
    message.forward_sender_name ||
    message.forward_date,
  );
  return forwarded && (hasLink(message) || AD_TERMS.test(messageText(message)));
}

function hasBlockedWord(text, words) {
  const normalized = text.toLocaleLowerCase();
  return words.some((word) => normalized.includes(word.toLocaleLowerCase()));
}

function formatWelcome(template, user, groupTitle) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return template
    .replace(/\{name\}/gi, name || user.username || "do'stimiz")
    .replace(/\{group\}/gi, groupTitle);
}

function parseBannedWords(value) {
  const words = value
    .split(/[\n,]/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length > MAX_BANNED_WORDS) {
    throw new Error(`Ko'pi bilan ${MAX_BANNED_WORDS} ta so'z kiritish mumkin.`);
  }
  if (words.some((word) => word.length > MAX_WORD_LENGTH)) {
    throw new Error(`Har bir so'z ${MAX_WORD_LENGTH} belgidan oshmasin.`);
  }
  return [...new Set(words.map((word) => word.toLocaleLowerCase()))];
}

function panelKeyboard(groups, username) {
  const keyboard = new InlineKeyboard();
  if (groups.length) {
    groups.forEach((group) => {
      keyboard.add({
        text: `${group.owner ? "Egasi · " : "Admin · "}${group.title}`.slice(0, 64),
        callback_data: `guard:group:${group.chatId}`,
        style: "primary",
      }).row();
    });
  }
  keyboard
    .url("Guruhga qo'shish", `https://t.me/${username}?startgroup=true`)
    .row()
    .add(emojiButton("group", "Guruhlarni yangilash", "guard:groups", "success"));
  return keyboard;
}

function groupKeyboard(group) {
  return new InlineKeyboard()
    .add(emojiButton(
      "settings",
      `Captcha: ${group.captchaEnabled ? "yoqilgan" : "o'chirilgan"}`,
      `guard:captcha:${group.chatId}`,
      group.captchaEnabled ? "success" : "danger",
    ))
    .row()
    .add(emojiButton("flood", "Flood sozlamasi", `guard:flood:${group.chatId}`, "primary"))
    .row()
    .add(emojiButton("words", "Taqiqlangan so'zlar", `guard:words:${group.chatId}`, "primary"))
    .row()
    .add(emojiButton("welcome", "Xush kelibsiz matni", `guard:welcome:${group.chatId}`, "primary"))
    .row()
    .add(emojiButton("stats", "Statistika", `guard:stats:${group.chatId}`, "primary"))
    .row()
    .add(emojiButton("admin", "Adminlar", `guard:admins:${group.chatId}`, "primary"))
    .row()
    .add({ text: "Guruhlar ro'yxati", callback_data: "guard:groups", style: "primary" });
}

function addAdminKeyboard(group, admins) {
  const keyboard = new InlineKeyboard();
  admins.forEach((admin) => {
    keyboard.add(emojiButton(
      "cancel",
      String(admin.userId),
      `guard:remove-admin:${group.chatId}:${admin.userId}`,
      "danger",
    )).row();
  });
  return keyboard
    .add({ text: "Admin qo'shish", callback_data: `guard:add-admin:${group.chatId}`, style: "success" })
    .row()
    .add({
      text: "Sozlamalar",
      callback_data: `guard:group:${group.chatId}`,
      style: "primary",
    });
}

function validateFloodSettings(value) {
  const match = value.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) throw new Error("Format: xabarlar soni / vaqt soniya, masalan 5/10.");
  const limit = Number(match[1]);
  const windowSeconds = Number(match[2]);
  if (!Number.isInteger(limit) || limit < 3 || limit > 30) {
    throw new Error("Flood chegarasi 3–30 oralig'ida bo'lishi kerak.");
  }
  if (!Number.isInteger(windowSeconds) || windowSeconds < 3 || windowSeconds > 120) {
    throw new Error("Vaqt oralig'i 3–120 soniya bo'lishi kerak.");
  }
  return { floodLimit: limit, floodWindowSeconds: windowSeconds };
}

function createGuardBot(token, { botId, database }) {
  if (!database) throw new Error("Guard Bot uchun ma'lumotlar bazasi berilishi kerak.");
  const bot = new Bot(token);
  const floodMessages = new Map();
  const adminCache = new Map();
  const groupCache = new Map();
  const panelAdminCache = new Map();
  const captchaTimers = new Map();

  bot.use(session({
    getSessionKey: (ctx) =>
      ctx.chat?.type === "private" ? String(ctx.chat.id) : undefined,
    initial: () => ({ selectedChatId: null, inputMode: null }),
  }));
  bot.catch((error) => {
    console.error(`Guard bot ${botId} update xatosi:`, error.message);
  });

  const sendEmoji = (ctx, emoji, text, options = {}) => {
    const formatted = messageWithEmoji(emoji, text);
    return ctx.reply(formatted.text, {
      ...options,
      ...(formatted.entities ? { entities: formatted.entities } : {}),
    });
  };

  async function getGroup(chatId) {
    const key = String(chatId);
    const cached = groupCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.group;
    const group = await database.getGroup(botId, key);
    groupCache.set(key, { group, expiresAt: Date.now() + 10_000 });
    return group;
  }

  async function updateGroup(chatId, updates) {
    const group = await database.updateGroup(botId, chatId, updates);
    groupCache.set(String(chatId), { group, expiresAt: Date.now() + 10_000 });
    return group;
  }

  async function getPanelAdmins(chatId) {
    const key = String(chatId);
    const cached = panelAdminCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.userIds;
    const admins = await database.listAdmins(botId, key);
    const userIds = new Set(admins.map((admin) => admin.userId));
    panelAdminCache.set(key, { userIds, expiresAt: Date.now() + 30_000 });
    return userIds;
  }

  async function canManageGroup(chatId, userId) {
    const group = await getGroup(chatId);
    return Boolean(
      group &&
      (group.ownerId === userId || (await getPanelAdmins(chatId)).has(userId)),
    );
  }

  const getPanelGroup = async (ctx, chatId) => {
    if (ctx.chat?.type !== "private" || !(await canManageGroup(chatId, ctx.from.id))) {
      return null;
    }
    return getGroup(chatId);
  };

  const renderGroups = async (ctx, edit = false) => {
    const groups = await database.listGroups(botId, ctx.from.id);
    const username = bot.botInfo.username;
    if (!groups.length) {
      const formatted = messageWithEmoji(
        "panel",
        `Xush kelibsiz, ${ctx.from.first_name || "admin"}!\n\n` +
          "Guruhlaringizni shu shaxsiy paneldan boshqaring.\n\n" +
          "Boshlash tartibi:\n" +
          "1. Botni guruhga qo'shib, administrator qiling.\n" +
          "2. Guruh egasi guruhda /claim yuborsin.\n" +
          "3. Shu panelga qaytib, guruhni tanlang.\n\n" +
          "Kerakli huquqlar: xabarlarni o'chirish va a'zolarni cheklash.",
      );
      const options = {
        reply_markup: panelKeyboard([], username),
        ...(formatted.entities ? { entities: formatted.entities } : {}),
      };
      return edit
        ? ctx.editMessageText(formatted.text, options)
        : ctx.reply(formatted.text, options);
    }
    const marked = groups.map((group) => ({
      ...group,
      owner: group.ownerId === ctx.from.id,
    }));
    const formatted = messageWithEmoji(
      "panel",
      `BOSHQARUV PANELI\n\n` +
        `${ctx.from.first_name || "Admin"}, xush kelibsiz.\n` +
        `Siz ${marked.length} ta guruhni boshqara olasiz.\n\n` +
        "Davom etish uchun guruhni tanlang.",
    );
    const options = {
      reply_markup: panelKeyboard(marked, username),
      ...(formatted.entities ? { entities: formatted.entities } : {}),
    };
    return edit
      ? ctx.editMessageText(formatted.text, options)
      : ctx.reply(formatted.text, options);
  };

  const renderGroup = (ctx, group, edit = true) => {
    ctx.session.selectedChatId = group.chatId;
    const role = group.ownerId === ctx.from.id ? "Guruh egasi" : "Panel administratori";
    const text = `GURUH SOZLAMALARI\n\n${group.title}\n${role}\n\n` +
      `Captcha: ${group.captchaEnabled ? "Faol" : "O'chirilgan"}\n` +
      `Flood himoyasi: ${group.floodLimit} xabar / ${group.floodWindowSeconds} soniya\n` +
      `Taqiqlangan so'zlar: ${group.bannedWords.length}\n\n` +
      "Bo'limni tanlab, sozlamani yangilang.";
    return edit
      ? ctx.editMessageText(text, { reply_markup: groupKeyboard(group) })
      : ctx.reply(text, { reply_markup: groupKeyboard(group) });
  };

  const isRegisteredAdmin = (chatId, userId) =>
    canManageGroup(chatId, userId);

  async function isChatAdmin(chatId, userId) {
    const key = `${chatId}:${userId}`;
    const cached = adminCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.isAdmin;
    const member = await bot.api.getChatMember(chatId, userId);
    const isAdmin = member.status === "creator" || member.status === "administrator";
    adminCache.set(key, { isAdmin, expiresAt: Date.now() + 30_000 });
    return isAdmin;
  }

  async function isModerator(chatId, userId) {
    if (await isRegisteredAdmin(chatId, userId)) return true;
    return isChatAdmin(chatId, userId);
  }

  async function expireCaptcha(chatId, userId) {
    const key = `${chatId}:${userId}`;
    captchaTimers.delete(key);
    try {
      const member = await bot.api.getChatMember(chatId, userId);
      if (member.status === "left" || member.status === "kicked") {
        await database.clearCaptcha(botId, chatId, userId);
        return;
      }
      await bot.api.banChatMember(chatId, userId);
      await bot.api.unbanChatMember(chatId, userId);
      await database.logEvent(botId, chatId, userId, "kick");
      await database.clearCaptcha(botId, chatId, userId);
      await bot.api.sendMessage(chatId, "A'zo captcha vaqtida tasdiqlamadi va guruhdan chiqarildi.");
    } catch (error) {
      console.error(`Captcha muddati tugagach ${userId} guruhdan chiqarilmadi:`, error.message);
      scheduleCaptchaExpiry(chatId, userId, Date.now() + 30_000);
    }
  }

  async function deleteServiceMessage(ctx) {
    try {
      await ctx.deleteMessage();
    } catch (error) {
      console.error(
        `Guard bot ${botId} guruh ${ctx.chat.id} xizmat xabarini o'chira olmadi:`,
        error.message,
      );
    }
  }

  function scheduleCaptchaExpiry(chatId, userId, expiresAt) {
    const key = `${chatId}:${userId}`;
    clearTimeout(captchaTimers.get(key));
    const timer = setTimeout(
      () => expireCaptcha(chatId, userId),
      Math.max(0, expiresAt - Date.now()),
    );
    timer.unref?.();
    captchaTimers.set(key, timer);
  }

  async function enforceCaptcha(chatId, userId, timeoutSeconds) {
    await bot.api.restrictChatMember(chatId, userId, {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
    }, { use_independent_chat_permissions: true });
    const expiresAt = Date.now() + timeoutSeconds * 1000;
    try {
      await database.setCaptcha(botId, chatId, userId, expiresAt);
    } catch (error) {
      await restorePermissions(chatId, userId).catch((restoreError) => {
        console.error(`Captcha sozlamasi yozilmagach ${userId} cheklovi olinmadi:`, restoreError.message);
      });
      throw error;
    }
    scheduleCaptchaExpiry(chatId, userId, expiresAt);
  }

  async function restorePermissions(chatId, userId) {
    const defaults = (await bot.api.getChat(chatId)).permissions || {};
    await bot.api.restrictChatMember(chatId, userId, {
      can_send_messages: defaults.can_send_messages !== false,
      can_send_audios: defaults.can_send_audios !== false,
      can_send_documents: defaults.can_send_documents !== false,
      can_send_photos: defaults.can_send_photos !== false,
      can_send_videos: defaults.can_send_videos !== false,
      can_send_video_notes: defaults.can_send_video_notes !== false,
      can_send_voice_notes: defaults.can_send_voice_notes !== false,
      can_send_polls: defaults.can_send_polls !== false,
      can_send_other_messages: defaults.can_send_other_messages !== false,
      can_add_web_page_previews: defaults.can_add_web_page_previews !== false,
    }, { use_independent_chat_permissions: true });
  }

  async function requireModerator(ctx) {
    const group = await getGroup(ctx.chat.id);
    if (!group) {
      await ctx.reply("Avval guruh egasi /claim buyrug'i bilan guruhni ro'yxatdan o'tkazsin.");
      return null;
    }
    if (!(await isModerator(ctx.chat.id, ctx.from.id))) {
      await ctx.reply("Bu buyruq faqat guruh adminlari uchun.");
      return null;
    }
    return group;
  }

  function commandTarget(ctx) {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const user = ctx.message.reply_to_message?.from;
    const userId = user?.id || (/^\d+$/.test(args[0] || "") ? Number(args.shift()) : null);
    if (!userId || user?.is_bot) return null;
    return {
      userId,
      name: user ? [user.first_name, user.last_name].filter(Boolean).join(" ") : String(userId),
      args,
    };
  }

  bot.command("claim", async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("/claim buyrug'ini ro'yxatdan o'tkaziladigan guruhda yuboring.");
      return;
    }
    const member = await bot.api.getChatMember(ctx.chat.id, ctx.from.id);
    if (member.status !== "creator") {
      await ctx.reply("Guruhni faqat uning egasi (/creator) ro'yxatdan o'tkaza oladi.");
      return;
    }
    const botMember = await bot.api.getChatMember(ctx.chat.id, bot.botInfo.id);
    if (
      botMember.status !== "administrator" ||
      !botMember.can_delete_messages ||
      !botMember.can_restrict_members
    ) {
      await ctx.reply("Botga administrator huquqini, jumladan xabar o'chirish va a'zolarni cheklash huquqlarini bering.");
      return;
    }
    const claimed = await database.claimGroup(
      botId,
      ctx.chat.id,
      ctx.chat.title || String(ctx.chat.id),
      ctx.from.id,
    );
    groupCache.set(String(ctx.chat.id), { group: claimed, expiresAt: Date.now() + 10_000 });
    await sendEmoji(
      ctx,
      "panel",
      "Guruh ro'yxatdan o'tdi. Shaxsiy admin panelini ochib, sozlamalarni boshqaring.",
      {
        reply_markup: new InlineKeyboard().url(
          "Shaxsiy admin panelini ochish",
          `https://t.me/${bot.botInfo.username}?start=admin`,
        ),
      },
    );
  });

  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    ctx.session.inputMode = null;
    await renderGroups(ctx);
  });

  bot.command("admin", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Admin panelni bot bilan shaxsiy chatda oching.");
      return;
    }
    await renderGroups(ctx);
  });

  bot.command("cancel", async (ctx) => {
    if (ctx.chat.type === "private") {
      const inputMode = ctx.session.inputMode;
      ctx.session.inputMode = null;
      if (inputMode) {
        const group = await getPanelGroup(ctx, inputMode.chatId);
        if (group) {
          await ctx.reply("Kiritish bekor qilindi. Guruh sozlamalari:", {
            reply_markup: groupKeyboard(group),
          });
          return;
        }
      }
    }
    await ctx.reply("Amal bekor qilindi.");
  });

  bot.command("warn", async (ctx) => {
    const group = await requireModerator(ctx);
    if (!group) return;
    const target = commandTarget(ctx);
    if (!target) {
      await ctx.reply("Foydalanuvchining xabariga reply qilib /warn [sabab] yuboring.");
      return;
    }
    const count = await database.incrementWarn(botId, ctx.chat.id, target.userId);
    await database.logEvent(botId, ctx.chat.id, target.userId, "warn");
    const reason = target.args.join(" ").trim();
    const reasonText = reason ? ` Sabab: ${reason.slice(0, 500)}` : "";
    if (count >= MAX_WARNINGS) {
      await bot.api.banChatMember(ctx.chat.id, target.userId);
      await database.logEvent(botId, ctx.chat.id, target.userId, "ban");
      await sendEmoji(ctx, "ban", `${target.name} 3 ta ogohlantirish oldi va guruhdan ban qilindi.${reasonText}`);
      return;
    }
    await sendEmoji(ctx, "warn", `${target.name}: ogohlantirish ${count}/${MAX_WARNINGS}.${reasonText}`);
  });

  bot.command("unwarn", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const target = commandTarget(ctx);
    if (!target) {
      await ctx.reply("Foydalanuvchining xabariga reply qilib /unwarn yuboring.");
      return;
    }
    const count = await database.decrementWarn(botId, ctx.chat.id, target.userId);
    await ctx.reply(`${target.name} ogohlantirishlari: ${count}/${MAX_WARNINGS}.`);
  });

  bot.command("ban", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const target = commandTarget(ctx);
    if (!target) {
      await ctx.reply("Foydalanuvchining xabariga reply qilib /ban yuboring.");
      return;
    }
    await bot.api.banChatMember(ctx.chat.id, target.userId);
    await database.logEvent(botId, ctx.chat.id, target.userId, "ban");
    await sendEmoji(ctx, "ban", `${target.name} ban qilindi.`);
  });

  bot.command("kick", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const target = commandTarget(ctx);
    if (!target) {
      await ctx.reply("Foydalanuvchining xabariga reply qilib /kick yuboring.");
      return;
    }
    await bot.api.banChatMember(ctx.chat.id, target.userId);
    await bot.api.unbanChatMember(ctx.chat.id, target.userId);
    await database.logEvent(botId, ctx.chat.id, target.userId, "kick");
    await ctx.reply(`${target.name} guruhdan chiqarildi.`);
  });

  bot.command("mute", async (ctx) => {
    const group = await requireModerator(ctx);
    if (!group) return;
    const target = commandTarget(ctx);
    if (!target) {
      await ctx.reply("Foydalanuvchining xabariga reply qilib /mute [soniya] yuboring.");
      return;
    }
    const seconds = target.args[0] ? Number(target.args[0]) : group.muteSeconds;
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 30 * 24 * 60 * 60) {
      await ctx.reply("Mute muddati 30 soniyadan 30 kungacha bo'lishi kerak.");
      return;
    }
    await bot.api.restrictChatMember(
      ctx.chat.id,
      target.userId,
      { can_send_messages: false },
      {
        until_date: Math.floor(Date.now() / 1000) + seconds,
        use_independent_chat_permissions: true,
      },
    );
    await database.logEvent(botId, ctx.chat.id, target.userId, "mute");
    await ctx.reply(`${target.name} ${seconds} soniyaga mute qilindi.`);
  });

  bot.command("unmute", async (ctx) => {
    if (!(await requireModerator(ctx))) return;
    const target = commandTarget(ctx);
    if (!target) {
      await ctx.reply("Foydalanuvchining xabariga reply qilib /unmute yuboring.");
      return;
    }
    await restorePermissions(ctx.chat.id, target.userId);
    await ctx.reply(`${target.name} mute'dan chiqarildi.`);
  });

  bot.callbackQuery(/^captcha:(-?\d+):(\d+)$/, async (ctx) => {
    const [, chatId, userIdText] = ctx.match;
    const userId = Number(userIdText);
    if (ctx.from.id !== userId) {
      await ctx.answerCallbackQuery({
        text: "Bu captcha boshqa foydalanuvchi uchun.",
        show_alert: true,
      });
      return;
    }
    const pending = await database.getCaptcha(botId, chatId, userId);
    if (!pending || pending.expiresAt <= Date.now()) {
      await ctx.answerCallbackQuery({
        text: "Captcha muddati tugagan yoki allaqachon tasdiqlangan.",
        show_alert: true,
      });
      return;
    }
    const key = `${chatId}:${userId}`;
    await restorePermissions(chatId, userId);
    await database.clearCaptcha(botId, chatId, userId);
    clearTimeout(captchaTimers.get(key));
    captchaTimers.delete(key);
    await ctx.answerCallbackQuery({ text: "Tasdiqlandi!" });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  });

  bot.on("message:new_chat_members", async (ctx) => {
    const group = await getGroup(ctx.chat.id);
    if (!group) return;
    try {
      for (const member of ctx.message.new_chat_members) {
        if (member.id === bot.botInfo.id || await isRegisteredAdmin(ctx.chat.id, member.id)) continue;
        const welcome = formatWelcome(group.welcomeText, member, group.title);
        if (group.captchaEnabled) {
          const key = `${ctx.chat.id}:${member.id}`;
          const keyboard = new InlineKeyboard().add(
            emojiButton("captcha", "Tasdiqlash", `captcha:${ctx.chat.id}:${member.id}`, "success"),
          );
          await enforceCaptcha(ctx.chat.id, member.id, group.captchaTimeoutSeconds);
          const formatted = messageWithEmoji("welcome", `${welcome}\n\nDavom etish uchun captcha tugmasini bosing.`);
          await bot.api.sendMessage(ctx.chat.id, formatted.text, {
            reply_markup: keyboard,
            ...(formatted.entities ? { entities: formatted.entities } : {}),
          });
          if (!captchaTimers.has(key)) {
            throw new Error(`Captcha timer yaratilmadi: ${key}`);
          }
        } else {
          const formatted = messageWithEmoji("welcome", welcome);
          await bot.api.sendMessage(ctx.chat.id, formatted.text, {
            ...(formatted.entities ? { entities: formatted.entities } : {}),
          });
        }
      }
    } finally {
      await deleteServiceMessage(ctx);
    }
  });

  bot.on("message", async (ctx) => {
    const text = messageText(ctx.message);
    if (ctx.chat.type === "private" && ctx.session.inputMode && ctx.message.text) {
      const { type, chatId } = ctx.session.inputMode;
      const group = await getPanelGroup(ctx, chatId);
      if (!group) {
        ctx.session.inputMode = null;
        await ctx.reply("Bu guruhni boshqarish huquqingiz yo'q.");
        return;
      }
      try {
        if (type === "welcome") {
          if (text.length > 1000) throw new Error("Xabar 1000 belgidan oshmasin.");
          await updateGroup(chatId, { welcomeText: text });
        } else if (type === "words") {
          await updateGroup(chatId, {
            bannedWords: text.trim() === "/clear" ? [] : parseBannedWords(text),
          });
        } else if (type === "flood") {
          await updateGroup(chatId, validateFloodSettings(text));
        } else if (type === "add-admin") {
          if (group.ownerId !== ctx.from.id) throw new Error("Adminlarni faqat guruh egasi boshqara oladi.");
          if (!/^\d{1,20}$/.test(text.trim())) throw new Error("Telegram ID raqamini yuboring.");
          const userId = Number(text.trim());
          if (!Number.isSafeInteger(userId) || userId < 1 || userId === group.ownerId) {
            throw new Error("Telegram ID noto'g'ri.");
          }
          await database.addAdmin(botId, chatId, userId, ctx.from.id);
          panelAdminCache.delete(String(chatId));
        }
        ctx.session.inputMode = null;
        const updated = await getGroup(chatId);
        await ctx.reply("Sozlama saqlandi va guruhda darhol qo'llanadi.", {
          reply_markup: groupKeyboard(updated),
        });
      } catch (error) {
        await sendEmoji(ctx, "warn", error.message, {
          reply_markup: new InlineKeyboard().add({
            text: "Guruh sozlamalariga qaytish",
            callback_data: `guard:group:${chatId}`,
            style: "danger",
          }),
        });
      }
      return;
    }

    if (ctx.chat.type === "private") return;
    const group = await getGroup(ctx.chat.id);
    if (!group) return;
    if (isServiceMessage(ctx.message)) {
      await deleteServiceMessage(ctx);
      return;
    }
    if (!ctx.from || ctx.from.is_bot) return;
    await database.recordActivity(botId, ctx.chat.id, ctx.from.id);

    const forwardedAd = isForwardedAdvertisement(ctx.message);
    const blockedWord = hasBlockedWord(text, group.bannedWords);
    const linkAd = hasLink(ctx.message);
    if (forwardedAd || blockedWord || linkAd) {
      if (await isModerator(ctx.chat.id, ctx.from.id)) return;
      await ctx.deleteMessage();
      return;
    }

    if (await isModerator(ctx.chat.id, ctx.from.id)) return;
    const key = `${ctx.chat.id}:${ctx.from.id}`;
    const now = Date.now();
    const recent = (floodMessages.get(key) || [])
      .filter((timestamp) => now - timestamp < group.floodWindowSeconds * 1000);
    recent.push(now);
    floodMessages.set(key, recent);
    if (recent.length < group.floodLimit) return;

    await bot.api.restrictChatMember(
      ctx.chat.id,
      ctx.from.id,
      { can_send_messages: false },
      {
        until_date: Math.floor(now / 1000) + group.muteSeconds,
        use_independent_chat_permissions: true,
      },
    );
    await database.logEvent(botId, ctx.chat.id, ctx.from.id, "mute");
    floodMessages.delete(key);
    await sendEmoji(ctx, "flood", `${ctx.from.first_name || "Foydalanuvchi"} flood sababli ${group.muteSeconds} soniyaga mute qilindi.`);
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(":");
    if (parts[0] !== "guard") return;
    await ctx.answerCallbackQuery();

    if (parts[1] === "groups") {
      ctx.session.inputMode = null;
      await renderGroups(ctx, true);
      return;
    }

    const chatId = parts[2];
    const group = await getPanelGroup(ctx, chatId);
    if (!group) {
      await ctx.editMessageText("Bu guruhni boshqarish huquqingiz yo'q.");
      return;
    }

    if (parts[1] === "group") {
      ctx.session.inputMode = null;
      await renderGroup(ctx, group);
    } else if (parts[1] === "captcha") {
      const updated = await updateGroup(chatId, {
        captchaEnabled: !group.captchaEnabled,
      });
      await renderGroup(ctx, updated);
    } else if (parts[1] === "welcome" || parts[1] === "words" || parts[1] === "flood") {
      const prompts = {
        welcome:
          `XUSH KELIBSIZ XABARI\n\n` +
          `Yangi matn yuboring (1000 belgigacha).\n` +
          `O'zgaruvchilar: {name}, {group}\n` +
          `Hozirgi matn: ${group.welcomeText.slice(0, 900)}\n\n` +
          "Bekor qilish uchun /cancel yuboring.",
        words:
          `TA'QIQLANGAN SO'ZLAR\n\n` +
          "So'zlarni vergul yoki yangi qatordan ajrating.\n" +
          `Hozir: ${group.bannedWords.join(", ").slice(0, 1000) || "kiritilmagan"}\n\n` +
          "Ro'yxatni tozalash: /clear\nBekor qilish: /cancel",
        flood:
          `FLOOD HIMOYASI\n\n` +
          `Format: xabarlar/soniya (masalan, 5/10).\n` +
          `Ruxsat etilgan: 3–30 xabar, 3–120 soniya.\n` +
          `Hozirgi qiymat: ${group.floodLimit}/${group.floodWindowSeconds}\n\n` +
          "Bekor qilish uchun /cancel yuboring.",
      };
      ctx.session.inputMode = {
        type: parts[1],
        chatId: group.chatId,
      };
      await ctx.editMessageText(prompts[parts[1]], {
        reply_markup: new InlineKeyboard().add({
          text: "Orqaga",
          callback_data: `guard:group:${group.chatId}`,
          style: "danger",
        }),
      });
    } else if (parts[1] === "stats") {
      const stats = await database.getStats(botId, chatId);
      const formatted = messageWithEmoji(
        "stats",
        `STATISTIKA\n${group.title}\n\n` +
          `So'nggi 24 soat:\n` +
          `• Ban: ${stats.bans}\n` +
          `• Mute: ${stats.mutes}\n` +
          `• Kick: ${stats.kicks}\n` +
          `• Ogohlantirish: ${stats.warnings}\n\n` +
          `Bugungi xabarlar: ${stats.dailyActivity}`,
      );
      await ctx.editMessageText(
        formatted.text,
        {
          reply_markup: new InlineKeyboard().add({
            text: "Sozlamalar",
            callback_data: `guard:group:${chatId}`,
            style: "primary",
          }),
          ...(formatted.entities ? { entities: formatted.entities } : {}),
        },
      );
    } else if (parts[1] === "admins") {
      const admins = await database.listAdmins(botId, chatId);
      const text = group.ownerId === ctx.from.id
        ? `QO'SHIMCHA ADMINLAR\n${group.title}\n\n` +
          `${admins.map((admin) => `• ${admin.userId}`).join("\n") || "Hozircha qo'shimcha admin yo'q."}\n\n` +
          "Panel adminlari bot sozlamalarini boshqara oladi."
        : "Qo'shimcha adminlarni faqat guruh egasi boshqara oladi.";
      const keyboard = group.ownerId === ctx.from.id
        ? addAdminKeyboard(group, admins)
        : new InlineKeyboard().add({
            text: "Sozlamalar",
            callback_data: `guard:group:${chatId}`,
            style: "primary",
          });
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } else if (parts[1] === "add-admin") {
      if (group.ownerId !== ctx.from.id) {
        await ctx.editMessageText("Adminlarni faqat guruh egasi boshqara oladi.");
        return;
      }
      ctx.session.inputMode = { type: "add-admin", chatId: group.chatId };
      await ctx.editMessageText("Qo'shimcha adminning Telegram ID raqamini yuboring.", {
        reply_markup: new InlineKeyboard().add({
          text: "Orqaga",
          callback_data: `guard:admins:${chatId}`,
          style: "danger",
        }),
      });
    } else if (parts[1] === "remove-admin") {
      if (group.ownerId !== ctx.from.id) {
        await ctx.editMessageText("Adminlarni faqat guruh egasi boshqara oladi.");
        return;
      }
      const userId = Number(parts[3]);
      await database.removeAdmin(botId, chatId, userId);
      panelAdminCache.delete(String(chatId));
      const admins = await database.listAdmins(botId, chatId);
      await ctx.editMessageText(
        `QO'SHIMCHA ADMINLAR\n${group.title}\n\n` +
          `${admins.map((admin) => `• ${admin.userId}`).join("\n") || "Hozircha qo'shimcha admin yo'q."}\n\n` +
          "Panel adminlari bot sozlamalarini boshqara oladi.",
        { reply_markup: addAdminKeyboard(group, admins) },
      );
    }
  });

  bot.on("my_chat_member", async (ctx) => {
    if (ctx.myChatMember.new_chat_member.status !== "administrator") return;
    if (ctx.chat.type === "private") return;
    const group = await getGroup(ctx.chat.id);
    if (group && group.title !== ctx.chat.title) {
      await updateGroup(ctx.chat.id, { title: ctx.chat.title || group.title });
    }
  });

  return {
    bot,
    database,
    async initialize() {
      await bot.init();
      await bot.api.setMyCommands([
        { command: "start", description: "Admin panelni ochish" },
        { command: "admin", description: "Guruh admin paneli" },
        { command: "cancel", description: "Joriy kiritishni bekor qilish" },
      ], {
        scope: { type: "all_private_chats" },
      });
      await bot.api.setMyCommands([
        { command: "claim", description: "Guruh egasi uchun ro'yxatdan o'tish" },
        { command: "ban", description: "Javob berilgan foydalanuvchini ban qilish" },
        { command: "mute", description: "Foydalanuvchini mute qilish" },
        { command: "unmute", description: "Mute'dan chiqarish" },
        { command: "kick", description: "Guruhdan chiqarish" },
        { command: "warn", description: "Ogohlantirish berish" },
        { command: "unwarn", description: "Ogohlantirishni olib tashlash" },
      ], {
        scope: { type: "all_group_chats" },
      });
      const pendingCaptchas = await database.listCaptchas(botId);
      for (const captcha of pendingCaptchas) {
        scheduleCaptchaExpiry(captcha.chatId, captcha.userId, captcha.expiresAt);
      }
    },
    cleanup() {
      for (const timer of captchaTimers.values()) clearTimeout(timer);
      captchaTimers.clear();
      floodMessages.clear();
      adminCache.clear();
      groupCache.clear();
      panelAdminCache.clear();
    },
  };
}

module.exports = {
  AD_TERMS,
  createGuardBot,
  formatWelcome,
  groupKeyboard,
  hasBlockedWord,
  hasLink,
  isForwardedAdvertisement,
  isServiceMessage,
  panelKeyboard,
  parseBannedWords,
  validateFloodSettings,
};
