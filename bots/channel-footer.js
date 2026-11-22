const REQUEST_ID = 1;
const SEPARATOR = "\n\n";
const MAX_FOOTER_LENGTH = 500;
const CAPTION_TYPES = [
  "photo",
  "video",
  "animation",
  "audio",
  "document",
  "voice",
];
const BUTTONS = {
  set: "✍️ Matn o'rnatish",
  channel: "📢 Kanal tanlash",
  view: "👁 Ko'rish",
  toggle: "⏯ Yoqish / o'chirish",
  clear: "🗑 Matnni o'chirish",
};

const menu = {
  reply_markup: {
    resize_keyboard: true,
    keyboard: [
      [
        { text: BUTTONS.set },
        {
          text: BUTTONS.channel,
          request_chat: {
            request_id: REQUEST_ID,
            chat_is_channel: true,
            user_administrator_rights: {
              can_manage_chat: true,
              can_edit_messages: true,
              can_promote_members: true,
            },
            bot_administrator_rights: {
              can_manage_chat: true,
              can_edit_messages: true,
            },
          },
        },
      ],
      [{ text: BUTTONS.view }, { text: BUTTONS.toggle }],
      [{ text: BUTTONS.clear }],
    ],
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(operation) {
  try {
    return await operation();
  } catch (error) {
    const retryAfter = error.parameters?.retry_after;
    if (!retryAfter) throw error;
    await sleep((retryAfter + 1) * 1000);
    return operation();
  }
}

function registerChannelFooter(bot, { doc, Settings }) {
  const seenGroups = new Map();
  let lastOwnerNotification = 0;
  const getSettings = () => Settings.findOne({ botId: doc._id });
  const updateSettings = (update) =>
    Settings.updateOne(
      { botId: doc._id },
      {
        ...update,
        $setOnInsert: { ownerId: doc.ownerId, createdAt: new Date() },
      },
      { upsert: true },
    );

  const notifyOwner = async (text) => {
    if (Date.now() - lastOwnerNotification < 10 * 60 * 1000) return;
    lastOwnerNotification = Date.now();
    try {
      await bot.sendMessage(doc.ownerId, text);
    } catch (error) {
      console.error(`@${doc.username} egasiga xabar yuborilmadi:`, error.message);
    }
  };

  const sendFooter = (ctx, footer) =>
    ctx.reply(footer.text, {
      entities: footer.entities,
      link_preview_options: { is_disabled: true },
    });

  const attachChannel = async (ctx, chatRef) => {
    try {
      const chat = await ctx.api("getChat", { chat_id: chatRef });
      if (chat.type !== "channel") {
        throw new Error("Tanlangan chat kanal emas.");
      }

      const botMember = await ctx.api("getChatMember", {
        chat_id: chat.id,
        user_id: doc._id,
      });
      if (botMember.status !== "administrator" || !botMember.can_edit_messages) {
        throw new Error(
          `@${doc.username} kanal administratori bo'lishi va xabarlarni tahrirlash huquqiga ega bo'lishi kerak.`,
        );
      }

      const ownerMember = await ctx.api("getChatMember", {
        chat_id: chat.id,
        user_id: doc.ownerId,
      });
      if (!["creator", "administrator"].includes(ownerMember.status)) {
        throw new Error("Siz bu kanalning administratori emassiz.");
      }

      const attachedElsewhere = await Settings.findOne({
        channelId: chat.id,
        botId: { $ne: doc._id },
      });
      if (attachedElsewhere) {
        throw new Error("Bu kanal boshqa footer botga ulangan.");
      }

      await updateSettings({
        $set: {
          channelId: chat.id,
          channelTitle: chat.title || chat.username || String(chat.id),
          awaiting: false,
        },
      });
      await ctx.reply(`✅ Kanal ulandi: ${chat.title || chat.username}`, menu);
    } catch (error) {
      await ctx.reply(
        `❌ ${error.message}\n\n"Kanal tanlash" tugmasi orqali qayta tanlang va Telegram so'raganda botga "Xabarlarni tahrirlash" huquqini berishni tasdiqlang.`,
        menu,
      );
    }
  };

  bot.command("start", async (ctx) => {
    if (ctx.from.id !== doc.ownerId) {
      await ctx.reply("Bu bot sozlamalarini faqat bot egasi boshqara oladi.");
      return;
    }
    await updateSettings({ $set: { awaiting: false } });
    await ctx.reply(
      "👋 Salom! Men kanal postlariga tayyorlagan matningizni avtomatik qo'shaman.\n\n" +
        `1) ${BUTTONS.set} — tag matnini yuboring\n` +
      `2) ${BUTTONS.channel} — admin bo'lgan kanalingizni tanlang\n` +
      "3) Telegram so'raganda botni xabarlarni tahrirlash huquqi bilan administrator qilishni tasdiqlang\n\n" +
        "Har yangi postga matn avtomatik qo'shiladi.",
      menu,
    );
  });

  bot.onUpdate("message", async (ctx) => {
    if (ctx.from?.id !== doc.ownerId) return;
    const message = ctx.message;
    const settings = await getSettings();

    if (message.chat_shared?.request_id === REQUEST_ID) {
      await attachChannel(ctx, message.chat_shared.chat_id);
      return;
    }

    if (settings?.awaiting) {
      const text = message.text ?? message.caption;
      const entities = message.entities ?? message.caption_entities ?? [];
      if (!text) {
        await ctx.reply("Matnli xabar yuboring yoki /cancel bosing.");
        return;
      }
      if (text.length > MAX_FOOTER_LENGTH) {
        await ctx.reply(`Matn ${MAX_FOOTER_LENGTH} belgidan oshmasin.`);
        return;
      }

      await updateSettings({ $set: { footer: { text, entities }, awaiting: false } });
      await ctx.reply("✅ Matn saqlandi. Ko'rinishi:", menu);
      await sendFooter(ctx, { text, entities });
      return;
    }

    const forwardedChannel = message.forward_origin?.type === "channel"
      ? message.forward_origin.chat.id
      : null;
    if (forwardedChannel) {
      await attachChannel(ctx, forwardedChannel);
      return;
    }

    const text = (message.text || "").trim();
    if (text === BUTTONS.set) {
      await updateSettings({ $set: { awaiting: true } });
      await ctx.reply(
        `Kanal postlari tagiga qo'shiladigan xabarni yuboring. Havola, matn formatlari va emoji saqlanadi.\n\nBekor qilish: /cancel`,
      );
      return;
    }

    if (text === BUTTONS.view) {
      await ctx.reply(
        `📢 Kanal: ${settings?.channelTitle || "tanlanmagan"}\n` +
          `⚙️ Holat: ${settings?.enabled === false ? "o'chirilgan ⏸" : "yoqilgan ✅"}\n` +
          `✍️ Matn: ${settings?.footer ? "bor" : "yo'q"}`,
        menu,
      );
      if (settings?.footer) await sendFooter(ctx, settings.footer);
      return;
    }

    if (text === BUTTONS.toggle) {
      const enabled = settings?.enabled === false;
      await updateSettings({ $set: { enabled } });
      await ctx.reply(enabled ? "✅ Yoqildi." : "⏸ O'chirildi, postlar o'zgarmaydi.", menu);
      return;
    }

    if (text === BUTTONS.clear) {
      await updateSettings({ $unset: { footer: "" } });
      await ctx.reply("🗑 Matn o'chirildi.", menu);
      return;
    }

    const channelMatch = text.match(/^(@[\w]{4,}|-100\d+)$/);
    if (channelMatch) {
      await attachChannel(ctx, channelMatch[1].startsWith("@")
        ? channelMatch[1]
        : Number(channelMatch[1]));
      return;
    }

    if (text) {
      await ctx.reply("Menyudan tugmani tanlang yoki /start bosing.", menu);
    }
  });

  bot.onUpdate("channel_post", async (ctx) => {
    ctx.loadingChatId = doc.ownerId;
    ctx.loadingText = "Kanal posti yangilanmoqda";
    const post = ctx.message;
    const settings = await Settings.findOne({
      botId: doc._id,
      channelId: post.chat.id,
      enabled: { $ne: false },
      footer: { $exists: true },
    });
    if (!settings) return;

    if (post.media_group_id) {
      if (seenGroups.has(post.media_group_id)) return;
      seenGroups.set(post.media_group_id, Date.now());
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const [groupId, timestamp] of seenGroups) {
        if (timestamp < cutoff) seenGroups.delete(groupId);
      }
    }

    const isText = typeof post.text === "string";
    if (!isText && !CAPTION_TYPES.some((type) => post[type])) return;

    const base = (isText ? post.text : post.caption) || "";
    const baseEntities = (isText ? post.entities : post.caption_entities) || [];
    const prefix = base ? base + SEPARATOR : "";
    const text = prefix + settings.footer.text;
    const limit = isText ? 4096 : 1024;
    if (text.length > limit) {
      await notifyOwner(
        `⚠️ "${post.chat.title}" kanalidagi post ${limit} belgidan oshgani uchun matn qo'shilmadi.`,
      );
      return;
    }

    const shiftEntities = (entities) =>
      entities.map((entity) => ({ ...entity, offset: entity.offset + prefix.length }));
    const editPost = (footerEntities) => {
      const entities = [...baseEntities, ...shiftEntities(footerEntities)];
      if (isText) {
        return ctx.api("editMessageText", {
          chat_id: post.chat.id,
          message_id: post.message_id,
          text,
          entities,
          link_preview_options: { is_disabled: true },
          reply_markup: post.reply_markup,
        });
      }
      return ctx.api("editMessageCaption", {
        chat_id: post.chat.id,
        message_id: post.message_id,
        caption: text,
        caption_entities: entities,
        show_caption_above_media: post.show_caption_above_media,
        reply_markup: post.reply_markup,
      });
    };

    try {
      await withRetry(() => editPost(settings.footer.entities || []));
    } catch (error) {
      if (/not modified/i.test(error.message)) return;
      const plainEntities = (settings.footer.entities || []).filter(
        (entity) => entity.type !== "custom_emoji",
      );
      if (plainEntities.length !== (settings.footer.entities || []).length) {
        try {
          await withRetry(() => editPost(plainEntities));
          await notifyOwner(
            "ℹ️ Kanalingizda premium emoji ishlamadi; postga emojisiz matn qo'shildi.",
          );
          return;
        } catch (retryError) {
          error = retryError;
        }
      }
      console.error(`@${doc.username} kanal postini tahrirlashda xato:`, error.message);
      await notifyOwner(`⚠️ Postni tahrirlab bo'lmadi: ${error.message}`);
    }
  });

  return {
    cancelPending: async (ctx) => {
      if (ctx.from?.id !== doc.ownerId) return false;
      const settings = await getSettings();
      if (!settings?.awaiting) return false;
      await updateSettings({ $set: { awaiting: false } });
      return true;
    },
  };
}

module.exports = registerChannelFooter;
