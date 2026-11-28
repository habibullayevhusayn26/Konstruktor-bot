const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fullAdminRights() {
  return {
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
  };
}

const isMember = (member) =>
  member.status === "creator" ||
  member.status === "administrator" ||
  member.status === "member" ||
  (member.status === "restricted" && member.is_member);

function getRequiredChannels(config = {}) {
  const channels = Array.isArray(config.requiredChannels)
    ? config.requiredChannels
    : [];
  if (!channels.length && config.requiredChannel) {
    channels.push({
      chatId: config.requiredChannel,
      title: config.requiredChannelTitle || String(config.requiredChannel),
      link: config.requiredChannelLink || "",
    });
  }
  return channels.filter((channel) => channel?.chatId);
}

function panelMarkup(doc) {
  const channels = getRequiredChannels(doc);
  const count = channels.length;
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Statistika", callback_data: "admin:stats" }],
        [{ text: "✏️ Salomlashuv matni", callback_data: "admin:welcome" }],
        [{ text: "📢 Obunachilarga xabar", callback_data: "admin:broadcast" }],
        ...(doc.type === "user-scheduler"
          ? [
              [{ text: "⭐ Premium sozlamalari", callback_data: "admin:premium" }],
              [{ text: "👥 Foydalanuvchini boshqarish", callback_data: "admin:user:search" }],
            ]
          : []),
        [{ text: `🔒 Majburiy obunalar: ${count}`, callback_data: "admin:channel" }],
        ...channels.map((channel, index) => [
          {
            text: `${index + 1}. ${String(channel.title).slice(0, 38)}`,
            callback_data: `admin:channel:open:${index}`,
          },
          {
            text: "❌",
            callback_data: `admin:channel:remove:${index}`,
          },
        ]),
        ...(count
          ? [[
              { text: "➕ Yana qo'shish", callback_data: "admin:channel" },
              { text: "🗑️ Hammasini o'chirish", callback_data: "admin:channel:off" },
            ]]
          : [[{ text: "➕ Kanal yoki guruh qo'shish", callback_data: "admin:channel" }]]),
      ],
    },
  };
}

function registerSubscriptionGate(bot, { doc, Subs }) {
  const persistedSubscribers = new Map();
  const memberCache = new Map();
  const persistSubscriber = async (ctx) => {
    const userId = ctx.from.id;
    const now = Date.now();
    if (now - (persistedSubscribers.get(userId) || 0) < 60_000) return;
    const result = await Subs.updateOne(
      { botId: doc._id, userId },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    persistedSubscribers.set(userId, now);
    if (result.upsertedCount > 0 && userId !== doc.ownerId) {
      const label = ctx?.from?.username
        ? `@${ctx.from.username}`
        : ctx?.from?.first_name || `ID ${userId}`;
      await bot.sendMessage(
        doc.ownerId,
        `👤 Yangi obunachi qo'shildi\n${label}\nTelegram ID: ${userId}`,
      ).catch((error) =>
        console.error(`Yangi obunachi haqida bot egasiga xabar yuborib bo'lmadi:`, error.message),
      );
    }
    if (persistedSubscribers.size > 2000) {
      persistedSubscribers.delete(persistedSubscribers.keys().next().value);
    }
  };

  bot.use(async (ctx) => {
    if (!ctx.from || !ctx.chat) return;
    if (ctx.chat.type !== "private") {
      ctx.handled = true;
      await ctx.reply("Botdan shaxsiy chatda foydalaning.");
      return;
    }

    if (ctx.from.id === doc.ownerId) {
      if (ctx.message) {
        try {
          await persistSubscriber(ctx);
        } catch (error) {
          console.error("Bot egasini obunachi sifatida saqlab bo'lmadi:", error.message);
        }
      }
      return;
    }

    const requiredChannels = getRequiredChannels(bot.config);
    if (!requiredChannels.length) {
      try {
        await persistSubscriber(ctx);
      } catch (error) {
        console.error(`@${doc.username} obunachisini saqlab bo'lmadi:`, error.message);
      }
      return;
    }

    ctx.handled = true;
    const cacheKey = requiredChannels.map((channel) => String(channel.chatId)).sort().join(",");
    const cachedMember = memberCache.get(ctx.from.id);
    if (
      cachedMember &&
      cachedMember.cacheKey === cacheKey &&
      cachedMember.expiresAt > Date.now()
    ) {
      try {
        await persistSubscriber(ctx);
      } catch (error) {
        console.error(`@${doc.username} obunachisini saqlab bo'lmadi:`, error.message);
      }
      ctx.handled = false;
      return;
    }
    const missingChannels = [];
    for (const channel of requiredChannels) {
      try {
        const member = await bot.api("getChatMember", {
          chat_id: channel.chatId,
          user_id: ctx.from.id,
        });
        if (!isMember(member)) missingChannels.push(channel);
      } catch (error) {
        console.error(`@${doc.username} ${channel.title} obunasini tekshirib bo'lmadi:`, error.message);
        missingChannels.push(channel);
      }
    }

    if (!missingChannels.length) {
      try {
        await persistSubscriber(ctx);
      } catch (error) {
        console.error(`@${doc.username} obunachisini saqlab bo'lmadi:`, error.message);
      }
      memberCache.set(ctx.from.id, {
        cacheKey,
        expiresAt: Date.now() + 5000,
      });
      if (memberCache.size > 2000) {
        memberCache.delete(memberCache.keys().next().value);
      }
      ctx.handled = false;
      return;
    }

    if (ctx.callbackQuery) {
      await ctx.answer({ text: "Avval kanalga obuna bo'ling." }).catch(() => {});
    }
    await ctx.reply(
      "Botdan foydalanish uchun barcha majburiy kanallar/guruhlarga obuna bo'ling:",
      {
        reply_markup: {
          inline_keyboard: [
            ...missingChannels.map((channel, index) => [{
              text: `📢 ${index + 1}. ${String(channel.title).slice(0, 45)}`,
              url: channel.link,
            }]),
            [{ text: "✅ Obunani tekshirish", callback_data: "join:check" }],
          ],
        },
      },
    );
  });
}

function registerAdminPanel(bot, {
  doc,
  Bots,
  Subs,
  UserSchedulerUsers,
  onCancel,
  encryptSecret,
  onUserUpdated,
}) {
  let pendingAction = null;
  let broadcastDraft = null;
  let selectedUserId = null;
  const isOwner = (ctx) => ctx.from?.id === doc.ownerId;
  const panelText = () => {
    const channels = getRequiredChannels(doc);
    const lines = channels.length
      ? channels.map((channel, index) => `${index + 1}. ${channel.title}`).join("\n")
      : "Sozlanmagan";
    return `🛠 @${doc.username} botining admin paneli\n\n🔒 Majburiy obunalar:\n${lines}`;
  };
  const getManagedUser = (userId) =>
    UserSchedulerUsers.findOne({ botId: doc._id, userId });
  const managedUserText = (user) => {
    const premiumUntil = user.premiumUntil ? new Date(user.premiumUntil) : null;
    const premiumActive = Boolean(premiumUntil && premiumUntil > new Date());
    return `👤 Foydalanuvchi\n🆔 Telegram ID: ${user.userId}\n` +
      `💰 Balans: ${(Number(user.balance) || 0).toLocaleString("uz-UZ")} so'm\n` +
      `⭐ Premium: ${premiumActive
        ? `Faol — ${premiumUntil.toLocaleDateString("uz-UZ")} gacha`
        : "Faol emas"}`;
  };
  const managedUserMarkup = (userId) => ({
    reply_markup: {
      inline_keyboard: [
        [{ text: "💰 Balansni o'zgartirish", callback_data: `admin:user:balance:${userId}` }],
        [
          { text: "⭐ +1 oy", callback_data: `admin:user:premium:1:${userId}` },
          { text: "⭐ +3 oy", callback_data: `admin:user:premium:3:${userId}` },
          { text: "⭐ +12 oy", callback_data: `admin:user:premium:12:${userId}` },
        ],
        [{ text: "🚫 Premiumni o'chirish", callback_data: `admin:user:premium:off:${userId}`, style: "danger" }],
        [{ text: "🔎 Boshqa foydalanuvchini qidirish", callback_data: "admin:user:search" }],
      ],
    },
  });
  const attachSelectedChat = async (ctx, chatRef) => {
    try {
      await setRequiredChannel(bot, Bots, doc, chatRef);
      pendingAction = null;
      await ctx.reply(
        `✅ Majburiy obuna ulandi: ${doc.requiredChannelTitle}\nBotni tanlangan chatga to'liq admin huquqi bilan qo'shing.`,
        panelMarkup(doc),
      );
    } catch (error) {
      console.error(`@${doc.username} majburiy obuna ulamadi:`, error.message);
      await ctx.reply(
        `❌ ${error.message}\nChatni qayta tanlang va botga barcha kerakli admin huquqlarini bering.`,
      );
    }
  };

  bot.command("admin", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Admin panel faqat bot egasi uchun.");
      return;
    }
    pendingAction = null;
    await ctx.reply(panelText(), panelMarkup(doc));
  });

  bot.command("cancel", async (ctx) => {
    if (!isOwner(ctx)) {
      if (doc.type === "user-scheduler" && await onCancel?.(ctx)) {
        await ctx.reply("Amal bekor qilindi.");
      }
      return;
    }
    const footerCancelled = await onCancel?.(ctx);
    if (pendingAction) {
      pendingAction = null;
      await ctx.reply("Amal bekor qilindi.");
    } else if (footerCancelled) {
      await ctx.reply("Amal bekor qilindi.");
    }
  });

  bot.use(async (ctx) => {
    if (ctx.message?.chat_shared && ["channel_select", "channel"].includes(pendingAction)) {
      ctx.handled = true;
      await attachSelectedChat(ctx, ctx.message.chat_shared.chat_id);
      return;
    }
    if (
      ctx.message &&
      !ctx.update.callback_query &&
      isOwner(ctx) &&
      ["channel_select", "channel"].includes(pendingAction) &&
      ctx.text?.trim()
    ) {
      ctx.handled = true;
      const chatInput = ctx.text.trim();
      if (!/^@[\w]{4,}$/.test(chatInput) && !/^-\d+$/.test(chatInput)) {
        await ctx.reply("Iltimos, 📢 Kanal yoki 👥 Guruh tanlash tugmasidan foydalaning.");
        return;
      }
      try {
        await setRequiredChannel(bot, Bots, doc, ctx.text.trim());
        pendingAction = null;
        await ctx.reply("Majburiy kanal sozlandi.", panelMarkup(doc));
      } catch (error) {
        await ctx.reply(`Kanalni sozlab bo'lmadi: ${error.message}\nQayta urinib ko'ring yoki /cancel bosing.`);
      }
      return;
    }
    if (!ctx.message || ctx.update.callback_query || !isOwner(ctx) || !pendingAction) {
      return;
    }
    if (ctx.text?.startsWith("/admin")) {
      pendingAction = null;
      return;
    }
    if (ctx.text?.startsWith("/start")) {
      ctx.handled = true;
      pendingAction = null;
      await ctx.reply("Majburiy obuna tanlash bekor qilindi.");
      return;
    }
    if (ctx.text?.startsWith("/cancel")) {
      pendingAction = null;
      ctx.handled = true;
      await onCancel?.(ctx);
      await ctx.reply("Amal bekor qilindi.");
      return;
    }

    ctx.handled = true;
    if (pendingAction === "premium-tolov-shop-id") {
      const shopId = ctx.text?.trim() || "";
      if (!/^\d{1,32}$/.test(shopId)) {
        await ctx.reply("Shop ID faqat raqamlardan iborat bo'lishi kerak. Qayta yuboring yoki /cancel bosing.");
        return;
      }
      const premiumSettings = { ...(doc.premiumSettings || {}) };
      premiumSettings.tolovApi = { ...(premiumSettings.tolovApi || {}), shopId };
      await Bots.updateOne(
        { _id: doc._id, ownerId: doc.ownerId },
        { $set: { premiumSettings } },
      );
      doc.premiumSettings = premiumSettings;
      bot.config.premiumSettings = premiumSettings;
      pendingAction = null;
      await ctx.reply("TolovAPI Shop ID saqlandi.", panelMarkup(doc));
      return;
    }

    if (pendingAction === "premium-tolov-shop-key") {
      const shopKey = ctx.text?.trim() || "";
      if (!shopKey || shopKey.length > 1024 || /[\r\n]/.test(shopKey)) {
        await ctx.reply("Shop Key bitta matn qatori bo'lishi va 1024 belgidan oshmasligi kerak. Qayta yuboring yoki /cancel bosing.");
        return;
      }
      if (typeof encryptSecret !== "function") {
        pendingAction = null;
        await ctx.reply("Kalitni xavfsiz saqlash uchun shifrlash sozlamasi mavjud emas. Administratorga murojaat qiling.");
        return;
      }

      let encryptedShopKey;
      try {
        encryptedShopKey = await encryptSecret(shopKey);
      } catch (error) {
        console.error(`@${doc.username} TolovAPI kalitini shifrlab bo'lmadi:`, error.message);
        pendingAction = null;
        await ctx.reply("Shop Key shifrlanmadi va saqlanmadi. Qayta urinib ko'ring.");
        return;
      }
      if (typeof encryptedShopKey !== "string" || !encryptedShopKey) {
        pendingAction = null;
        await ctx.reply("Shop Key shifrlanmadi va saqlanmadi. Qayta urinib ko'ring.");
        return;
      }

      const premiumSettings = { ...(doc.premiumSettings || {}) };
      premiumSettings.tolovApi = {
        ...(premiumSettings.tolovApi || {}),
        shopKeyEncrypted: encryptedShopKey,
      };
      await Bots.updateOne(
        { _id: doc._id, ownerId: doc.ownerId },
        { $set: { premiumSettings } },
      );
      doc.premiumSettings = premiumSettings;
      bot.config.premiumSettings = premiumSettings;
      pendingAction = null;

      try {
        await ctx.api("deleteMessage", {
          chat_id: ctx.chat.id,
          message_id: ctx.message.message_id,
        });
      } catch (error) {
        console.error(`@${doc.username} TolovAPI kalit kiritilgan xabarni o'chira olmadi:`, error.message);
        await ctx.reply(
          "Shop Key shifrlanib saqlandi, ammo yuborgan xabaringizni o'chira olmadim. Xavfsizlik uchun uni chatdan qo'lda o'chiring.",
          panelMarkup(doc),
        );
        return;
      }
      await ctx.reply("TolovAPI Shop Key shifrlanib saqlandi. Kalit qayta ko'rsatilmaydi.", panelMarkup(doc));
      return;
    }

    if (pendingAction === "tolov-payment-search") {
      const transactionId = ctx.text?.trim().toUpperCase() || "";
      if (!/^TXN-[A-Z0-9]+-[A-F0-9]{12}$/.test(transactionId)) {
        await ctx.reply("Tranzaksiya ID formati noto'g'ri. `TXN-...` ko'rinishidagi ID yuboring yoki /cancel bosing.");
        return;
      }
      if (typeof UserSchedulerUsers?.findOne !== "function") {
        pendingAction = null;
        await ctx.reply("To'lovlar bazasi mavjud emas; tranzaksiyani qidirib bo'lmadi.");
        return;
      }

      const user = await UserSchedulerUsers.findOne({
        botId: doc._id,
        "tolovPaymentHistory.transactionId": transactionId,
      });
      const payment = user?.tolovPaymentHistory?.find(
        (entry) => entry.transactionId === transactionId,
      );
      pendingAction = null;
      if (!payment) {
        await ctx.reply(`Tranzaksiya topilmadi: ${transactionId}`);
        return;
      }

      const formatDate = (value) => {
        const date = value ? new Date(value) : null;
        return date && Number.isFinite(date.getTime())
          ? date.toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" })
          : "—";
      };
      const statuses = {
        pending: "Kutilmoqda",
        paid: "To'langan",
        cancelled: "Bekor qilingan",
        expired: "Muddati tugagan",
        test: "Test to'lovi",
      };
      const purpose = payment.purpose === "balance"
        ? "Balansni to'ldirish"
        : payment.purpose === "premium"
          ? `Premium (${payment.months || "?"} oy)`
          : payment.purpose || "—";
      await ctx.reply(
        `🔎 TolovAPI tranzaksiyasi\n\n` +
          `Tranzaksiya ID: ${payment.transactionId}\n` +
          `Holati: ${statuses[payment.status] || payment.status || "—"}\n` +
          `Foydalanuvchi Telegram ID: ${payment.userId || user.userId}\n` +
          `Maqsad: ${purpose}\n` +
          `So'ralgan summa: ${Number(payment.requestedAmount || payment.amount).toLocaleString("uz-UZ")} so'm\n` +
          `Yuborilishi kerak bo'lgan summa: ${Number(payment.amount).toLocaleString("uz-UZ")} so'm\n` +
          `TolovAPI Payment ID: ${payment.paymentId || "—"}\n` +
          `Order ID: ${payment.orderId || "—"}\n` +
          `Karta: ${payment.cardLast4 ? `**** ${payment.cardLast4}` : "—"}\n` +
          `Yaratilgan: ${formatDate(payment.createdAt)}\n` +
          `Muddati: ${formatDate(payment.expiresAt)}\n` +
          `To'langan: ${formatDate(payment.paidAt)}\n` +
          `Yakunlangan: ${formatDate(payment.completedAt)}`,
      );
      return;
    }

    if (pendingAction === "user-search") {
      const userIdText = ctx.text?.trim() || "";
      const userId = /^\d{1,20}$/.test(userIdText) ? Number(userIdText) : NaN;
      if (!Number.isSafeInteger(userId) || userId < 1) {
        await ctx.reply("Telegram ID musbat butun son bo'lishi kerak. Qayta yuboring yoki /cancel bosing.");
        return;
      }
      if (doc.type !== "user-scheduler" || typeof UserSchedulerUsers?.findOne !== "function") {
        pendingAction = null;
        await ctx.reply("User Bot foydalanuvchilar bazasi mavjud emas.");
        return;
      }
      const user = await getManagedUser(userId);
      pendingAction = null;
      if (!user) {
        selectedUserId = null;
        await ctx.reply(`Telegram ID ${userId} bo'yicha ushbu User Bot foydalanuvchisi topilmadi.`);
        return;
      }
      selectedUserId = userId;
      await ctx.reply(managedUserText(user), managedUserMarkup(userId));
      return;
    }

    if (pendingAction === "user-balance-edit") {
      const balanceText = (ctx.text || "").trim().replace(/\s/g, "");
      const balance = /^\d+$/.test(balanceText) ? Number(balanceText) : NaN;
      if (!Number.isSafeInteger(balance) || balance < 0) {
        await ctx.reply("Balans 0 yoki undan katta butun so'm bo'lishi kerak. Qayta yuboring yoki /cancel bosing.");
        return;
      }
      if (
        !Number.isSafeInteger(selectedUserId) ||
        typeof UserSchedulerUsers?.findOne !== "function" ||
        typeof UserSchedulerUsers?.updateOne !== "function"
      ) {
        pendingAction = null;
        await ctx.reply("Avval foydalanuvchini qidiring.");
        return;
      }
      const user = await getManagedUser(selectedUserId);
      if (!user) {
        pendingAction = null;
        selectedUserId = null;
        await ctx.reply("Foydalanuvchi topilmadi. Qaytadan qidiring.");
        return;
      }
      const oldBalance = Number(user.balance) || 0;
      const filter = { botId: doc._id, userId: selectedUserId };
      filter.balance = Object.prototype.hasOwnProperty.call(user, "balance")
        ? user.balance
        : { $exists: false };
      const changedAt = new Date();
      const saved = await UserSchedulerUsers.updateOne(
        filter,
        {
          $set: { balance },
          $push: {
            balanceAdminHistory: {
              adminId: ctx.from.id,
              oldBalance,
              newBalance: balance,
              changedAt,
            },
          },
        },
      );
      if (saved.matchedCount !== 1) {
        await ctx.reply("Foydalanuvchi balansi bir vaqtda o'zgardi. Qaytadan qidirib, yangilangan qiymatni tekshiring.");
        return;
      }
      pendingAction = null;
      const updatedUser = await getManagedUser(selectedUserId);
      await onUserUpdated?.(selectedUserId, updatedUser);
      await ctx.reply(managedUserText(updatedUser), managedUserMarkup(selectedUserId));
      return;
    }

    if (pendingAction === "broadcast-media") {
      const hasMedia =
        ctx.message.photo?.length ||
        ctx.message.video ||
        ctx.message.animation ||
        ctx.message.document;
      if (hasMedia) {
        broadcastDraft = {
          mediaMessageId: ctx.message.message_id,
          textMessageId: null,
          buttons: [],
          style: "default",
        };
        pendingAction = "broadcast-text";
        await ctx.reply("2/3 — Premium emoji qo'llab-quvvatlaydigan matnni yuboring.");
        return;
      }
      if (ctx.text?.trim()) {
        const text = ctx.text.trim();
        if (text.length > 4000) {
          await ctx.reply("Xabar 4000 belgidan oshmasin.");
          return;
        }
        pendingAction = null;
        await ctx.reply("Xabar yuborish boshlandi.");
        const result = await broadcast(bot, Subs, doc._id, text, doc.ownerId);
        broadcastDraft = null;
        await ctx.reply(`Yuborildi: ${result.sent}\nXatolar: ${result.failed}`);
        return;
      }
      await ctx.reply("GIF, video, rasm yoki fayl yuboring. Media yubormasangiz \"Mediasiz davom etish\" tugmasini bosing.");
      return;
    }

    if (pendingAction === "broadcast-text") {
      const text = ctx.message.text || ctx.message.caption;
      if (!text) {
        await ctx.reply("Iltimos, xabar matnini yuboring.");
        return;
      }
      broadcastDraft.textMessageId = ctx.message.message_id;
      pendingAction = "broadcast-buttons";
      await ctx.reply(
        "3/3 — Inline tugma rangini tanlang:",
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Ko'k", callback_data: "admin:broadcast:style:primary", style: "primary" },
                { text: "Yashil", callback_data: "admin:broadcast:style:success", style: "success" },
              ],
              [
                { text: "Qizil", callback_data: "admin:broadcast:style:danger", style: "danger" },
                { text: "Standart", callback_data: "admin:broadcast:style:default", style: "default" },
              ],
            ],
          },
        },
      );
      return;
    }

    if (pendingAction === "broadcast-buttons") {
      const match = ctx.text.trim().match(/^(.+?)\s*\|\s*(https?:\/\/\S+)$/i);
      if (!match) {
        await ctx.reply("Format: Tugma matni | https://havola.uz");
        return;
      }
      broadcastDraft.buttons.push({ text: match[1].trim().slice(0, 64), url: match[2] });
      await ctx.reply(
        "Tugma qo'shildi. Yana tugma qo'shing yoki yuborishni boshlang.",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Xabarni yuborish", callback_data: "admin:broadcast:send" }],
            ],
          },
        },
      );
      return;
    }

    if (!ctx.text.trim()) {
      await ctx.reply("Iltimos, matn yuboring yoki /cancel bosing.");
      return;
    }

    const action = pendingAction;
    if (action === "premium-stars") {
      const match = ctx.text.trim().match(/^(\d{1,7})\s*\/\s*(\d{1,7})\s*\/\s*(\d{1,7})$/);
      if (!match) {
        await ctx.reply("Format: `100/250/800` — 1 oy / 3 oy / 12 oy.");
        return;
      }
      const stars = { 1: Number(match[1]), 3: Number(match[2]), 12: Number(match[3]) };
      if (!Object.values(stars).every((value) => value >= 1 && value <= 1000000)) {
        await ctx.reply("Stars narxlari 1 dan 1 000 000 gacha bo'lishi kerak.");
        return;
      }
      const premiumSettings = { ...(doc.premiumSettings || {}) };
      premiumSettings.stars = stars;
      await Bots.updateOne(
        { _id: doc._id, ownerId: doc.ownerId },
        { $set: { premiumSettings } },
      );
      doc.premiumSettings = premiumSettings;
      bot.config.premiumSettings = premiumSettings;
      pendingAction = null;
      await ctx.reply("Premium Stars narxlari saqlandi.", panelMarkup(doc));
      return;
    }

    if (action === "premium-tolov-prices") {
      const match = ctx.text.trim().match(/^(\d{1,9})\s*\/\s*(\d{1,9})\s*\/\s*(\d{1,9})$/);
      if (!match) {
        await ctx.reply("Format: `50000/120000/400000` — 1 oy / 3 oy / 12 oy (so'm).");
        return;
      }
      const tolovApiPrices = { 1: Number(match[1]), 3: Number(match[2]), 12: Number(match[3]) };
      if (!Object.values(tolovApiPrices).every((value) => Number.isSafeInteger(value) && value > 0)) {
        await ctx.reply("Narxlar musbat butun so'm bo'lishi kerak.");
        return;
      }
      const premiumSettings = { ...(doc.premiumSettings || {}) };
      premiumSettings.tolovApiPrices = tolovApiPrices;
      await Bots.updateOne(
        { _id: doc._id, ownerId: doc.ownerId },
        { $set: { premiumSettings } },
      );
      doc.premiumSettings = premiumSettings;
      bot.config.premiumSettings = premiumSettings;
      pendingAction = null;
      await ctx.reply("TolovAPI va balans uchun Premium narxlari saqlandi.", panelMarkup(doc));
      return;
    }

    if (action === "welcome") {
      const welcome = ctx.text.trim().slice(0, 4000);
      await Bots.updateOne(
        { _id: doc._id, ownerId: doc.ownerId },
        { $set: { welcome } },
      );
      bot.config.welcome = welcome;
      pendingAction = null;
      await ctx.reply("Salomlashuv matni saqlandi.");
      return;
    }

    if (action === "broadcast") {
      const text = ctx.text.trim();
      if (text.length > 4000) {
        await ctx.reply("Xabar 4000 belgidan oshmasin.");
        return;
      }
      pendingAction = null;
      await ctx.reply("Xabar yuborish boshlandi.");
      const result = await broadcast(bot, Subs, doc._id, text, doc.ownerId);
      await ctx.reply(`Yuborildi: ${result.sent}\nXatolar: ${result.failed}`);
      return;
    }

    if (action === "channel") {
      if (!/^@[\w]{4,}$/.test(ctx.text.trim()) && !/^-\d+$/.test(ctx.text.trim())) {
        await ctx.reply("Iltimos, 📢 Kanal yoki 👥 Guruh tanlash tugmasidan foydalaning.");
        return;
      }
      try {
        await setRequiredChannel(bot, Bots, doc, ctx.text.trim());
        pendingAction = null;
        await ctx.reply("Majburiy kanal sozlandi.", panelMarkup(doc));
      } catch (error) {
        console.error(`@${doc.username} majburiy kanalini sozlab bo'lmadi:`, error.message);
        await ctx.reply(`Kanalni sozlab bo'lmadi: ${error.message}\nQayta urinib ko'ring yoki /cancel bosing.`);
      }
    }
  });

  bot.onCallbackData(/^admin:(stats|welcome|broadcast|channel|premium|premium:stars|premium:tolov|premium:tolov:shop-id|premium:tolov:shop-key|premium:tolov-search|user:search|user:balance:\d+|user:premium:(1|3|12|off):\d+|channel:off|channel:remove:\d+)$/, async (ctx) => {
    await ctx.answer();
    if (!isOwner(ctx)) return;

    const removeMatch = ctx.text.match(/^admin:channel:remove:(\d+)$/);
    if (removeMatch) {
      const index = Number(removeMatch[1]);
      const channels = getRequiredChannels(doc);
      if (index >= 0 && index < channels.length) {
        channels.splice(index, 1);
        await Bots.updateOne(
          { _id: doc._id, ownerId: doc.ownerId },
          { $set: { requiredChannels: channels } },
        );
        doc.requiredChannels = channels;
        bot.config.requiredChannels = channels;
      }
      await ctx.edit(panelText(), panelMarkup(doc));
      return;
    }

    const userPremiumMatch = ctx.text.match(/^admin:user:premium:(1|3|12|off):(\d+)$/);
    if (userPremiumMatch) {
      if (
        doc.type !== "user-scheduler" ||
        typeof UserSchedulerUsers?.findOne !== "function" ||
        typeof UserSchedulerUsers?.updateOne !== "function"
      ) {
        await ctx.reply("User Bot foydalanuvchilar bazasi mavjud emas.");
        return;
      }
      const targetUserId = Number(userPremiumMatch[2]);
      if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) {
        await ctx.reply("Foydalanuvchi Telegram ID'si noto'g'ri.");
        return;
      }
      selectedUserId = targetUserId;
      const user = await getManagedUser(targetUserId);
      if (!user) {
        selectedUserId = null;
        await ctx.reply("Foydalanuvchi topilmadi. Qaytadan qidiring.");
        return;
      }

      pendingAction = null;
      const changedAt = new Date();
      const storedUntil = user.premiumUntil ? new Date(user.premiumUntil) : null;
      const currentUntil = storedUntil && Number.isFinite(storedUntil.getTime())
        ? storedUntil
        : null;
      const action = userPremiumMatch[1];
      let premiumUntil;
      let premiumPlan;
      let months;
      if (action === "off") {
        premiumUntil = changedAt;
        premiumPlan = null;
      } else {
        months = Number(action);
        const start = currentUntil && currentUntil > changedAt ? currentUntil : changedAt;
        premiumUntil = new Date(start);
        premiumUntil.setUTCMonth(premiumUntil.getUTCMonth() + months);
        premiumPlan = `${months} oy`;
      }
      const saved = await UserSchedulerUsers.updateOne(
        { botId: doc._id, userId: targetUserId },
        {
          $set: {
            premium: action !== "off",
            premiumUntil,
            premiumPlan,
          },
          $push: {
            premiumAdminHistory: {
              adminId: ctx.from.id,
              action: action === "off" ? "deactivate" : "activate",
              ...(months ? { months } : {}),
              previousPremiumUntil: currentUntil,
              premiumUntil,
              changedAt,
            },
          },
        },
      );
      if (saved.matchedCount !== 1) {
        await ctx.reply("Foydalanuvchi holatini saqlab bo'lmadi. Qaytadan qidiring.");
        return;
      }
      const updatedUser = await getManagedUser(targetUserId);
      await onUserUpdated?.(targetUserId, updatedUser);
      await ctx.reply(managedUserText(updatedUser), managedUserMarkup(targetUserId));
      return;
    }

    const userBalanceMatch = ctx.text.match(/^admin:user:balance:(\d+)$/);
    if (userBalanceMatch) {
      if (doc.type !== "user-scheduler" || typeof UserSchedulerUsers?.findOne !== "function") {
        await ctx.reply("User Bot foydalanuvchilar bazasi mavjud emas.");
        return;
      }
      const targetUserId = Number(userBalanceMatch[1]);
      if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) {
        await ctx.reply("Foydalanuvchi Telegram ID'si noto'g'ri.");
        return;
      }
      if (!await getManagedUser(targetUserId)) {
        await ctx.reply("Foydalanuvchi topilmadi. Qaytadan qidiring.");
        return;
      }
      selectedUserId = targetUserId;
      pendingAction = "user-balance-edit";
      await ctx.reply(`🆔 ${targetUserId} uchun yangi balansni so'mda yuboring (0 yoki undan katta butun son). Bu joriy balansni o'rnatadi; /cancel — bekor qilish.`);
      return;
    }

    switch (ctx.text) {
      case "admin:user:search":
        if (doc.type !== "user-scheduler") {
          await ctx.reply("Foydalanuvchilarni boshqarish faqat User Bot uchun mavjud.");
          return;
        }
        selectedUserId = null;
        pendingAction = "user-search";
        await ctx.reply("Qidirmoqchi bo'lgan foydalanuvchining Telegram ID raqamini yuboring (/cancel — bekor qilish).");
        return;
      case "admin:premium:stars":
        pendingAction = "premium-stars";
        await ctx.reply("Stars narxlarini `100/250/800` formatida yuboring:\n1 oy / 3 oy / 12 oy.");
        return;
      case "admin:premium:tolov":
        if (doc.type !== "user-scheduler") {
          await ctx.reply("TolovAPI sozlamalari faqat User Bot uchun mavjud.");
          return;
        }
        pendingAction = "premium-tolov-prices";
        await ctx.reply("TolovAPI va balans narxlarini `50000/120000/400000` formatida yuboring:\n1 oy / 3 oy / 12 oy (so'm).");
        return;
      case "admin:premium:tolov:shop-id":
        if (doc.type !== "user-scheduler") {
          await ctx.reply("TolovAPI sozlamalari faqat User Bot uchun mavjud.");
          return;
        }
        pendingAction = "premium-tolov-shop-id";
        await ctx.reply("TolovAPI Shop ID raqamini yuboring (/cancel — bekor qilish).");
        return;
      case "admin:premium:tolov:shop-key":
        if (doc.type !== "user-scheduler") {
          await ctx.reply("TolovAPI sozlamalari faqat User Bot uchun mavjud.");
          return;
        }
        pendingAction = "premium-tolov-shop-key";
        await ctx.reply("TolovAPI Shop Key'ni bitta matn xabarida yuboring. U shifrlanib saqlanadi va chatdan o'chiriladi (/cancel — bekor qilish).");
        return;
      case "admin:premium:tolov-search":
        if (doc.type !== "user-scheduler") {
          await ctx.reply("TolovAPI tranzaksiyalarini qidirish faqat User Bot uchun mavjud.");
          return;
        }
        pendingAction = "tolov-payment-search";
        await ctx.reply("Tranzaksiya ID'ni yuboring (masalan, `TXN-...`) yoki /cancel bosing.");
        return;
      case "admin:premium": {
        if (doc.type !== "user-scheduler") {
          await ctx.reply("Premium sozlamalari faqat User Bot uchun mavjud.");
          return;
        }
        const premiumSettings = doc.premiumSettings || {};
        const stars = premiumSettings.stars || { 1: 100, 3: 250, 12: 800 };
        const tolovApiPrices = premiumSettings.tolovApiPrices ||
          premiumSettings.card ||
          { 1: 50000, 3: 120000, 12: 400000 };
        const tolovApi = premiumSettings.tolovApi || {};
        await ctx.edit(
          `⭐ User Bot — Premium sozlamalari\n\n` +
            `Stars narxlari:\n1 oy — ${stars[1]} Stars\n3 oy — ${stars[3]} Stars\n12 oy — ${stars[12]} Stars\n\n` +
            `TolovAPI va balans narxlari:\n` +
            `1 oy — ${Number(tolovApiPrices[1]).toLocaleString("uz-UZ")} so'm\n` +
            `3 oy — ${Number(tolovApiPrices[3]).toLocaleString("uz-UZ")} so'm\n` +
            `12 oy — ${Number(tolovApiPrices[12]).toLocaleString("uz-UZ")} so'm\n\n` +
            `TolovAPI Shop ID: ${tolovApi.shopId || "Sozlanmagan"}\n` +
            `TolovAPI Shop Key: ${tolovApi.shopKeyEncrypted ? "Ulangan (shifrlangan)" : "Sozlanmagan"}\n` +
            `To'lov usullari: Telegram Stars, TolovAPI va User Bot balansi`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "⭐ Stars narxlarini sozlash", callback_data: "admin:premium:stars" }],
                [{ text: "💳 TolovAPI/balans narxlarini sozlash", callback_data: "admin:premium:tolov" }],
                [{ text: "🆔 TolovAPI Shop ID", callback_data: "admin:premium:tolov:shop-id" }],
                [{ text: "🔑 TolovAPI Shop Key", callback_data: "admin:premium:tolov:shop-key" }],
                [{ text: "🔎 Tranzaksiya ID bo'yicha qidirish", callback_data: "admin:premium:tolov-search" }],
                [{ text: "⬅️ Orqaga", callback_data: "admin:stats" }],
              ],
            },
          },
        );
        return;
      }
      case "admin:stats": {
        const [total, today, linkedAccounts] = await Promise.all([
          Subs.countDocuments({ botId: doc._id }),
          Subs.countDocuments({
            botId: doc._id,
            createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          }),
          doc.type === "user-scheduler" && UserSchedulerUsers
            ? UserSchedulerUsers.countDocuments({
                botId: doc._id,
                userSessionEncrypted: { $exists: true, $ne: "" },
              })
            : Promise.resolve(0),
        ]);
        await ctx.edit(
          doc.type === "user-scheduler"
            ? `📊 @${doc.username}\nJami foydalanuvchi: ${total}\nBugun qo'shilgan: ${today}\n🔗 Akkaunti ulangan: ${linkedAccounts}`
            : `📊 @${doc.username}\nJami foydalanuvchi: ${total}\nBugun qo'shilgan: ${today}`,
          panelMarkup(doc),
        );
        break;
      }
      case "admin:welcome":
        pendingAction = "welcome";
        await ctx.edit("Yangi salomlashuv matnini yuboring (/cancel — bekor qilish).");
        break;
      case "admin:broadcast":
        pendingAction = "broadcast-media";
        broadcastDraft = null;
        await ctx.edit(
          "1/3 — GIF, video, rasm yoki fayl yuboring:",
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "➡️ Mediasiz davom etish", callback_data: "admin:broadcast:skip_media" }],
              ],
            },
          },
        );
        break;
      case "admin:channel":
        pendingAction = "channel";
        await ctx.reply(
          "Kanal yoki guruhni qulay tugma orqali tanlang:",
          {
            reply_markup: {
              resize_keyboard: true,
              one_time_keyboard: true,
              keyboard: [
                [{
                  text: "📢 Kanal tanlash",
                  request_chat: {
                    request_id: 9101,
                    chat_is_channel: true,
                    bot_is_member: true,
                    user_administrator_rights: fullAdminRights(),
                    bot_administrator_rights: fullAdminRights(),
                  },
                }],
                [{
                  text: "👥 Guruh tanlash",
                  request_chat: {
                    request_id: 9102,
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
        break;
      case "admin:channel:off":
        await Bots.updateOne(
          { _id: doc._id, ownerId: doc.ownerId },
          {
            $set: { requiredChannels: [] },
            $unset: {
              requiredChannel: "",
              requiredChannelTitle: "",
              requiredChannelLink: "",
            },
          },
        );
        doc.requiredChannels = [];
        delete bot.config.requiredChannel;
        delete bot.config.requiredChannelTitle;
        delete bot.config.requiredChannelLink;
        bot.config.requiredChannels = [];
        pendingAction = null;
        await ctx.reply("Barcha majburiy obunalar o'chirildi.", panelMarkup(doc));
        break;
    }
  });

  bot.onCallbackData(/^admin:broadcast:(skip_media|style:(?:default|primary|success|danger)|preview|send|cancel)$/, async (ctx) => {
    await ctx.answer();
    if (!isOwner(ctx)) return;

    if (ctx.text.endsWith("skip_media")) {
      if (pendingAction !== "broadcast-media") return;
      broadcastDraft = {
        mediaMessageId: null,
        textMessageId: null,
        buttons: [],
        style: "default",
      };
      pendingAction = "broadcast-text";
      await ctx.edit("2/3 — Premium emoji qo'llab-quvvatlaydigan matnni yuboring.");
      return;
    }

    const styleMatch = ctx.text.match(/^admin:broadcast:style:(default|primary|success|danger)$/);
    if (styleMatch) {
      if (pendingAction !== "broadcast-buttons" || !broadcastDraft) return;
      broadcastDraft.style = styleMatch[1];
      const selected = {
        primary: "🔵 Ko'k",
        success: "🟢 Yashil",
        danger: "🔴 Qizil",
        default: "⚪ Standart",
      }[styleMatch[1]];
      await ctx.edit(
        `Tanlangan rang: ${selected}\nTugmani formatda yuboring:\nTugma matni | https://havola.uz`,
        {
          reply_markup: {
            inline_keyboard: [
              [{
                text: "Ko'k",
                callback_data: "admin:broadcast:style:primary",
                style: "primary",
              }, {
                text: "Yashil",
                callback_data: "admin:broadcast:style:success",
                style: "success",
              }],
              [{
                text: "Qizil",
                callback_data: "admin:broadcast:style:danger",
                style: "danger",
              }, {
                text: "Standart",
                callback_data: "admin:broadcast:style:default",
                style: "default",
              }],
              [{ text: "✅ Xabarni ko'rish", callback_data: "admin:broadcast:preview" }],
            ],
          },
        },
      );
      return;
    }

    if (ctx.text === "admin:broadcast:preview") {
      if (pendingAction !== "broadcast-buttons" || !broadcastDraft) return;
      const inlineKeyboard = broadcastDraft.buttons.map((button) => [{
        text: button.text,
        url: button.url,
        ...(broadcastDraft.style === "default" ? {} : { style: broadcastDraft.style }),
      }]);
      try {
        if (broadcastDraft.mediaMessageId) {
          await bot.api("copyMessage", {
            chat_id: doc.ownerId,
            from_chat_id: doc.ownerId,
            message_id: broadcastDraft.mediaMessageId,
          });
        }
        if (broadcastDraft.textMessageId) {
          const copied = await bot.api("copyMessage", {
            chat_id: doc.ownerId,
            from_chat_id: doc.ownerId,
            message_id: broadcastDraft.textMessageId,
          });
          if (inlineKeyboard.length) {
            await bot.api("editMessageReplyMarkup", {
              chat_id: doc.ownerId,
              message_id: copied.message_id,
              disablePremiumEmoji: true,
              reply_markup: { inline_keyboard: inlineKeyboard },
            });
          }
        }
        pendingAction = "broadcast-preview";
        await ctx.reply(
          "Yuqoridagi ko'rinish preview. Xabarni yuborishni tasdiqlaysizmi?",
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ Ha, barchaga yuborish", callback_data: "admin:broadcast:send" }],
                [{ text: "❌ Bekor qilish", callback_data: "admin:broadcast:cancel" }],
              ],
            },
          },
        );
      } catch (error) {
        await ctx.reply(`Preview yaratib bo'lmadi: ${error.message}`);
      }
      return;
    }

    if (ctx.text === "admin:broadcast:cancel") {
      pendingAction = null;
      broadcastDraft = null;
      await ctx.reply("Xabar yuborish bekor qilindi.");
      return;
    }

    if (ctx.text === "admin:broadcast:send") {
      if (pendingAction !== "broadcast-preview" || !broadcastDraft) return;
      pendingAction = null;
      await ctx.reply("Xabar yuborish boshlandi.");
      const result = await broadcast(bot, Subs, doc._id, broadcastDraft, doc.ownerId);
      broadcastDraft = null;
      await ctx.reply(`Yuborildi: ${result.sent}\nXatolar: ${result.failed}`);
    }
  });

  bot.onCallbackData(/^join:check$/, async (ctx) => {
    await ctx.answer();
    const channels = getRequiredChannels(bot.config);
    if (!channels.length) {
      await ctx.edit("Majburiy obuna sozlanmagan. /start ni bosing.");
      return;
    }
    try {
      const missing = [];
      for (const channel of channels) {
        const member = await bot.api("getChatMember", {
          chat_id: channel.chatId,
          user_id: ctx.from.id,
        });
        if (!isMember(member)) missing.push(channel);
      }
      if (!missing.length) {
        await Subs.updateOne(
          { botId: doc._id, userId: ctx.from.id },
          { $setOnInsert: { createdAt: new Date() } },
          { upsert: true },
        );
        await ctx.edit("Obuna tasdiqlandi. Botdan foydalanish uchun /start bosing.");
      } else {
        await ctx.edit("Barcha majburiy obunalarga qo'shiling, so'ng yana tekshiring.", {
          reply_markup: {
            inline_keyboard: [
              ...missing.map((channel) => [{
                text: `📢 ${String(channel.title).slice(0, 45)}`,
                url: channel.link,
              }]),
              [{ text: "✅ Qayta tekshirish", callback_data: "join:check" }],
            ],
          },
        });
      }
    } catch (error) {
      console.error(`@${doc.username} obunani qayta tekshirib bo'lmadi:`, error.message);
      await ctx.edit("Tekshirishda xato yuz berdi. Keyinroq qayta urinib ko'ring.");
    }
  });
}

async function setRequiredChannel(bot, Bots, doc, channelInput) {
  const chat = await bot.api("getChat", { chat_id: channelInput });
  if (chat.type && !["channel", "group", "supergroup"].includes(chat.type)) {
    throw new Error("Faqat kanal yoki guruh tanlanishi kerak.");
  }
  const botMember = await bot.api("getChatMember", {
    chat_id: chat.id,
    user_id: doc._id,
  });
  if (botMember.status !== "administrator" && botMember.status !== "creator") {
    throw new Error("Bot tanlangan kanal yoki guruhga to'liq admin huquqi bilan qo'shilishi kerak.");
  }

  let link = chat.username ? `https://t.me/${chat.username}` : chat.invite_link;
  if (!link) {
    link = await bot.api("exportChatInviteLink", { chat_id: chat.id });
  }

  const channel = {
    chatId: chat.id,
    title: chat.title || chat.username || String(chat.id),
    link,
  };
  const channels = getRequiredChannels(doc).filter(
    (item) => String(item.chatId) !== String(chat.id),
  );
  channels.push(channel);
  const update = {
    requiredChannels: channels,
    requiredChannel: chat.id,
    requiredChannelTitle: channel.title,
    requiredChannelLink: link,
  };
  await Bots.updateOne(
    { _id: doc._id, ownerId: doc.ownerId },
    { $set: update },
  );
  doc.requiredChannels = channels;
  Object.assign(bot.config, update);
}

async function broadcast(bot, Subs, botId, draftOrText, ownerId) {
  let sent = 0;
  let failed = 0;
  for await (const subscriber of Subs.find({ botId })) {
    let shouldSend = true;
    const channels = getRequiredChannels(bot.config);
    for (const channel of channels) {
      try {
        const member = await bot.api("getChatMember", {
          chat_id: channel.chatId,
          user_id: subscriber.userId,
        });
        if (!isMember(member)) {
          await Subs.deleteOne({ botId, userId: subscriber.userId });
          shouldSend = false;
          break;
        }
      } catch (error) {
        failed++;
        console.error("Obunachining majburiy chat a'zoligini tekshirib bo'lmadi:", error.message);
        shouldSend = false;
        break;
      }
    }

    if (shouldSend) {
      try {
        if (typeof draftOrText === "string") {
          await bot.sendMessage(subscriber.userId, draftOrText);
        } else {
          if (draftOrText.mediaMessageId) {
            await bot.api("copyMessage", {
              chat_id: subscriber.userId,
              from_chat_id: ownerId,
              message_id: draftOrText.mediaMessageId,
            });
          }
          if (draftOrText.textMessageId) {
            const copied = await bot.api("copyMessage", {
              chat_id: subscriber.userId,
              from_chat_id: ownerId,
              message_id: draftOrText.textMessageId,
            });
            if (draftOrText.buttons?.length) {
              await bot.api("editMessageReplyMarkup", {
                chat_id: subscriber.userId,
                message_id: copied.message_id,
                disablePremiumEmoji: true,
                reply_markup: {
                  inline_keyboard: draftOrText.buttons.map((button) => [{
                    text: button.text,
                    url: button.url,
                    ...(draftOrText.style === "default" ? {} : { style: draftOrText.style }),
                  }]),
                },
              });
            }
          }
        }
        sent++;
      } catch {
        failed++;
      }
    }
    await sleep(50);
  }
  return { sent, failed };
}

module.exports = { registerAdminPanel, registerSubscriptionGate };
