"use strict";

const { ObjectId } = require("mongodb");

const som = (n) => `${Math.round(Number(n) || 0).toLocaleString("uz-UZ")} so'm`;
const short = (value, length) => {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

function registerSmmPanel(bot, options = {}) {
  const botId = Number(bot.config._id);
  const Users = options.SmmUsers;
  const Orders = options.SmmOrders;
  const Topups = options.SmmTopups;
  const Bots = options.Bots;
  if (!Users || !Orders || !Topups) {
    throw new Error("SMM bot uchun MongoDB kolleksiyalari sozlanmagan.");
  }

  const env = process.env;
  let apiUrl = bot.config.smmApiUrl || env.SMM_API_URL || "";
  let apiKey = bot.config.smmApiKey || env.SMM_API_KEY || "";
  let usdRate = Number(bot.config.smmUsdRate || env.SMM_USD_RATE || 12700);
  let markup = Number(bot.config.smmMarkupPercent || env.SMM_MARKUP_PERCENT || 30);
  let card = bot.config.smmCardNumber || env.SMM_CARD_NUMBER || "0000 0000 0000 0000";
  let cardOwner = bot.config.smmCardOwner || env.SMM_CARD_OWNER || "";
  const states = new Map();
  const admins = new Set((env.ADMIN_IDS || "").split(",").map((id) => Number(id)).filter(Boolean));
  if (bot.config.ownerId) admins.add(Number(bot.config.ownerId));

  let services = new Map();
  let categories = [];

  Users.createIndex({ botId: 1, _id: 1 }).catch(() => {});
  Orders.createIndex({ botId: 1, final: 1 }).catch(() => {});
  Orders.createIndex({ botId: 1, userId: 1, createdAt: -1 }).catch(() => {});
  Topups.createIndex({ botId: 1, status: 1 }).catch(() => {});

  async function smm(params) {
    if (!apiUrl || !apiKey) throw new Error("Provayder API hali sozlanmagan.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await fetch(apiUrl, {
        method: "POST",
        body: new URLSearchParams({ key: apiKey, ...params }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Provayder javobi 20 soniyada kelmadi.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("Provayder javobi noto'g'ri formatda.");
    }
    if (!response.ok || data?.error) throw new Error(data?.error || "Provayder xatosi.");
    return data;
  }

  async function loadServices(force = false) {
    if (!force && services.size) return;
    const list = await smm({ action: "services" });
    const map = new Map();
    const cats = new Map();
    for (const item of list) {
      const service = {
        id: Number(item.service),
        name: String(item.name),
        category: String(item.category),
        rate: Number(item.rate),
        min: Number(item.min),
        max: Number(item.max),
      };
      map.set(service.id, service);
      if (!cats.has(service.category)) cats.set(service.category, []);
      cats.get(service.category).push(service.id);
    }
    services = map;
    categories = [...cats].map(([name, ids]) => ({ name, ids }));
  }

  const per1000 = (service) => service.rate * (1 + markup / 100) * usdRate;
  const priceOf = (service, quantity) =>
    Math.ceil((per1000(service) * quantity) / 1000);
  const replyKeyboard = (userId) => ({
    resize_keyboard: true,
    keyboard: [
      [{ text: "🛒 Buyurtma berish" }, { text: "📦 Buyurtmalarim" }],
      [{ text: "💰 Balans" }, { text: "💳 Hisobni to‘ldirish" }],
      [
        { text: "☎️ Aloqa" },
        ...(admins.has(userId) ? [{ text: "🛠 SMM admin" }] : []),
      ],
    ],
  });

  bot.command("start", async (ctx) => {
    states.delete(ctx.from.id);
    await ctx.reply(
      bot.config.welcome || "SMM xizmatlariga buyurtma berish botiga xush kelibsiz!",
      replyKeyboard(ctx.from.id),
    );
  });

  bot.command("cancel", async (ctx) => {
    states.delete(ctx.from.id);
    await ctx.reply("Amal bekor qilindi.", replyKeyboard(ctx.from.id));
  });

  async function saveConfig(update) {
    if (!Bots) return;
    await Bots.updateOne({ _id: botId }, { $set: update });
  }

  async function showAdmin(ctx) {
    if (!admins.has(ctx.from.id)) return;
    const pending = await Topups.countDocuments({ botId, status: "pending" });
    const users = await Users.countDocuments({ botId });
    const orders = await Orders.countDocuments({ botId });
    await ctx.reply(
      `🛠 SMM admin panel\n\n👥 Foydalanuvchilar: ${users}\n📦 Buyurtmalar: ${orders}\n💳 Kutilayotgan to‘lovlar: ${pending}\n\nProvayder: ${apiUrl ? "sozlangan" : "sozlanmagan"}\nKurs: 1 USD = ${som(usdRate)}\nUstama: ${markup}%`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📊 To‘liq statistika", callback_data: "smmadmin:stats" }],
            [{ text: "🔄 Xizmatlarni yangilash", callback_data: "smmadmin:reload" }],
            [{ text: "🌐 API havolasi", callback_data: "smmadmin:url" }, { text: "🔑 API kaliti", callback_data: "smmadmin:key" }],
            [{ text: "💱 USD kursi", callback_data: "smmadmin:rate" }, { text: "📈 Ustama foizi", callback_data: "smmadmin:markup" }],
            [{ text: "🏦 Karta raqami", callback_data: "smmadmin:card" }, { text: "👤 Karta egasi", callback_data: "smmadmin:cardowner" }],
          ],
        },
      },
    );
  }

  bot.command("admin", showAdmin);
  bot.onText(/^🛠 SMM admin$/i, showAdmin);

  bot.onCallbackData(/^smmadmin:(stats|reload|url|key|rate|markup|card|cardowner)$/, async (ctx, match) => {
    await ctx.answer();
    if (!admins.has(ctx.from.id)) return;
    const action = match[1];
    if (action === "stats") {
      const [users, orders, topups, revenue] = await Promise.all([
        Users.countDocuments({ botId }),
        Orders.countDocuments({ botId }),
        Topups.countDocuments({ botId, status: "approved" }),
        Orders.aggregate([{ $match: { botId } }, { $group: { _id: null, sum: { $sum: "$charge" } } }]).toArray(),
      ]);
      return ctx.reply(`📊 SMM statistika\n\nFoydalanuvchilar: ${users}\nBuyurtmalar: ${orders}\nTasdiqlangan to‘lovlar: ${topups}\nJami buyurtma aylanmasi: ${som(revenue[0]?.sum || 0)}`);
    }
    if (action === "reload") {
      try {
        await loadServices(true);
        await ctx.reply(`✅ Xizmatlar yangilandi: ${services.size} ta.`);
      } catch (error) {
        await ctx.reply(`❌ Yangilab bo‘lmadi: ${error.message}`);
      }
      return;
    }
    const prompts = {
      url: "Yangi SMM API havolasini yuboring:",
      key: "Yangi SMM API kalitini yuboring:",
      rate: "1 USD kursini so'mda yuboring:",
      markup: "Narx ustamasini foizda yuboring:",
      card: "Qabul qilish karta raqamini yuboring:",
      cardowner: "Karta egasi nomini yuboring:",
    };
    states.set(ctx.from.id, { step: `admin_${action}` });
    await ctx.reply(prompts[action]);
  });

  bot.onText(/^💰 Balans$/i, async (ctx) => {
    const user = await Users.findOne({ _id: ctx.from.id });
    await ctx.reply(`💰 Balansingiz: ${som(user?.balance || 0)}\nTelegram ID: ${ctx.from.id}`);
  });

  bot.onText(/^📦 Buyurtmalarim$/i, async (ctx) => {
    const list = await Orders.find({ userId: ctx.from.id }).sort({ createdAt: -1 }).limit(10).toArray();
    if (!list.length) return ctx.reply("Hali buyurtmangiz yo'q.");
    await ctx.reply(list.map((order) =>
      `№${order.providerOrderId}\n${short(order.serviceName, 45)}\n${order.quantity} ta · ${som(order.charge)} · ${order.status}`,
    ).join("\n\n"));
  });

  bot.onText(/^☎️ Aloqa$/i, async (ctx) => {
    await ctx.reply(`Savol va muammolar uchun bot egasi: ${bot.config.ownerId || "admin"}`);
  });

  bot.onText(/^💳 Hisobni to‘ldirish$/i, async (ctx) => {
    states.set(ctx.from.id, { step: "topup_amount" });
    await ctx.reply("To‘ldirmoqchi bo‘lgan summani raqamda yuboring. Minimal summa 5 000 so'm.");
  });

  bot.onText(/^🛒 Buyurtma berish$/i, async (ctx) => {
    try {
      await Users.updateOne(
        { _id: ctx.from.id },
        { $set: { botId, name: ctx.from.first_name, username: ctx.from.username || null }, $setOnInsert: { balance: 0 } },
        { upsert: true },
      );
      await loadServices();
      if (!categories.length) return ctx.reply("Hozircha xizmatlar mavjud emas.");
      await ctx.reply("Kategoriyani tanlang:", {
        reply_markup: {
          inline_keyboard: categories.map((category, index) =>
            [{ text: short(category.name, 50), callback_data: `cat:${index}:0` }],
          ),
        },
      });
    } catch (error) {
      await ctx.reply(error.message);
    }
  });

  bot.onCallbackData(/^cat:(\d+):(\d+)$/, async (ctx, match) => {
    await ctx.answer();
    const category = categories[Number(match[1])];
    if (!category) return ctx.reply("Ro'yxat yangilangan, qaytadan tanlang.");
    const page = Number(match[2]);
    const ids = category.ids.slice(page * 8, (page + 1) * 8);
    const rows = ids.map((id) => {
      const service = services.get(id);
      return [{ text: `${short(service.name, 38)} · ${som(per1000(service))}/1000`, callback_data: `svc:${id}` }];
    });
    if (page > 0) rows.push([{ text: "⬅️ Oldingi", callback_data: `cat:${match[1]}:${page - 1}` }]);
    if ((page + 1) * 8 < category.ids.length) rows.push([{ text: "Keyingi ➡️", callback_data: `cat:${match[1]}:${page + 1}` }]);
    rows.push([{ text: "⬅️ Kategoriyalar", callback_data: "cats" }]);
    await ctx.edit(category.name, { reply_markup: { inline_keyboard: rows } });
  });

  bot.onCallbackData(/^cats$/, async (ctx) => {
    await ctx.answer();
    await ctx.edit("Kategoriyani tanlang:", {
      reply_markup: {
        inline_keyboard: categories.map((category, index) =>
          [{ text: short(category.name, 50), callback_data: `cat:${index}:0` }],
        ),
      },
    });
  });

  bot.onCallbackData(/^svc:(\d+)$/, async (ctx, match) => {
    await ctx.answer();
    const service = services.get(Number(match[1]));
    if (!service) return ctx.reply("Xizmat topilmadi.");
    states.set(ctx.from.id, { step: "link", serviceId: service.id });
    await ctx.edit(
      `${service.name}\n\n1000 ta narxi: ${som(per1000(service))}\nMinimal: ${service.min}\nMaksimal: ${service.max}\n\nHavolani yuboring.`,
    );
  });

  bot.onText(/^[\s\S]+$/, async (ctx) => {
    const text = ctx.text.trim();
    if (!text || text.startsWith("/")) return;
    const state = states.get(ctx.from.id);
    if (!state) return;

    if (state.step?.startsWith("admin_") && admins.has(ctx.from.id)) {
      const action = state.step.slice(6);
      states.delete(ctx.from.id);
      try {
        if (action === "url") {
          if (!/^https?:\/\//i.test(text)) throw new Error("API havolasi http:// yoki https:// bilan boshlansin.");
          apiUrl = text;
          await saveConfig({ smmApiUrl: apiUrl });
        } else if (action === "key") {
          if (text.length < 8) throw new Error("API kaliti juda qisqa.");
          apiKey = text;
          await saveConfig({ smmApiKey: apiKey });
        } else if (action === "rate") {
          const value = Number(text.replace(/[^\d.]/g, ""));
          if (!Number.isFinite(value) || value <= 0) throw new Error("USD kursi musbat son bo'lsin.");
          usdRate = value;
          await saveConfig({ smmUsdRate: usdRate });
        } else if (action === "markup") {
          const value = Number(text.replace(/[^\d.-]/g, ""));
          if (!Number.isFinite(value) || value < 0 || value > 500) throw new Error("Ustama 0–500% oralig'ida bo'lsin.");
          markup = value;
          await saveConfig({ smmMarkupPercent: markup });
        } else if (action === "card") {
          const value = text.replace(/\D/g, "");
          if (value.length < 12 || value.length > 23) throw new Error("Karta raqami noto'g'ri.");
          card = text;
          await saveConfig({ smmCardNumber: card });
        } else if (action === "cardowner") {
          if (text.length < 2 || text.length > 80) throw new Error("Karta egasi nomi noto'g'ri.");
          cardOwner = text;
          await saveConfig({ smmCardOwner: cardOwner });
        }
        await ctx.reply("✅ Sozlama saqlandi.", replyKeyboard(ctx.from.id));
      } catch (error) {
        await ctx.reply(`❌ ${error.message}`, replyKeyboard(ctx.from.id));
      }
      return;
    }

    if (state.step === "topup_amount") {
      const amount = Number(text.replace(/[^\d]/g, ""));
      if (!Number.isSafeInteger(amount) || amount < 5000) {
        await ctx.reply("Summani 5 000 so'm yoki undan ko'p qilib yuboring.");
        return;
      }
      states.set(ctx.from.id, { step: "topup_receipt", amount });
      await ctx.reply(
        `${som(amount)} ni quyidagi kartaga o‘tkazing:\n\n${card}${cardOwner ? `\n${cardOwner}` : ""}\n\nTo‘lov chekining rasmini yuboring.`,
      );
      return;
    }

    if (state.step === "link") {
      if (text.length < 4) return ctx.reply("Havola noto'g'ri.");
      states.set(ctx.from.id, { ...state, step: "quantity", link: text });
      const service = services.get(state.serviceId);
      await ctx.reply(`Miqdorni yuboring (${service.min}–${service.max}):`);
      return;
    }

    if (state.step === "quantity") {
      const quantity = Number(text);
      const service = services.get(state.serviceId);
      if (!Number.isInteger(quantity) || quantity < service.min || quantity > service.max) {
        await ctx.reply(`Miqdor ${service.min}–${service.max} oralig‘ida butun son bo‘lsin.`);
        return;
      }
      const price = priceOf(service, quantity);
      states.set(ctx.from.id, { ...state, step: "confirm", quantity, price });
      await ctx.reply(
        `Buyurtmani tasdiqlang\n\n${short(service.name, 60)}\nHavola: ${short(state.link, 80)}\nMiqdor: ${quantity}\nNarx: ${som(price)}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Tasdiqlash", callback_data: "order:confirm" },
              { text: "❌ Bekor qilish", callback_data: "order:cancel" },
            ]],
          },
        },
      );
    }
  });

  bot.onPhoto(async (ctx) => {
    const state = states.get(ctx.from.id);
    if (state?.step !== "topup_receipt") return;
    states.delete(ctx.from.id);
    const result = await Topups.insertOne({
      botId,
      ownerId: ctx.from.id,
      amount: state.amount,
      status: "pending",
      receiptFileId: ctx.message.photo.at(-1).file_id,
      createdAt: new Date(),
    });
    for (const adminId of admins) {
      await bot.sendPhoto(adminId, ctx.message.photo.at(-1).file_id, "chek.jpg", {
        caption: `SMM to‘lov so‘rovi\nFoydalanuvchi: ${ctx.from.id}\nSumma: ${som(state.amount)}`,
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Tasdiqlash", callback_data: `topup:ok:${result.insertedId}` },
            { text: "❌ Rad etish", callback_data: `topup:no:${result.insertedId}` },
          ]],
        },
      }).catch(() => {});
    }
    await ctx.reply("Chek adminga yuborildi. Tasdiqlangach balans to‘ldiriladi.", replyKeyboard(ctx.from.id));
  });

  bot.onCallbackData(/^topup:(ok|no):(.+)$/, async (ctx, match) => {
    await ctx.answer();
    if (!admins.has(ctx.from.id)) return;
    let id;
    try {
      id = new ObjectId(match[2]);
    } catch {
      return ctx.reply("To‘lov ID noto‘g‘ri.");
    }
    const approved = match[1] === "ok";
    const topup = await Topups.findOneAndUpdate(
      { _id: id, botId, status: "pending" },
      { $set: { status: approved ? "approved" : "rejected", reviewedBy: ctx.from.id, reviewedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!topup) return ctx.reply("Bu to‘lov so‘rovi allaqachon ko‘rilgan.");
    if (approved) {
      await Users.updateOne(
        { _id: topup.ownerId },
        { $inc: { balance: topup.amount } },
        { upsert: true },
      );
    }
    await bot.sendMessage(topup.ownerId, approved
      ? `✅ Balansingiz ${som(topup.amount)} ga to‘ldirildi.`
      : "❌ To‘lov cheki tasdiqlanmadi.");
  });

  bot.onCallbackData(/^order:(confirm|cancel)$/, async (ctx, match) => {
    await ctx.answer();
    const state = states.get(ctx.from.id);
    if (!state || state.step !== "confirm") return ctx.reply("Sessiya tugagan. Buyurtmani qaytadan boshlang.");
    states.delete(ctx.from.id);
    if (match[1] === "cancel") return ctx.reply("Buyurtma bekor qilindi.", replyKeyboard(ctx.from.id));

    const paid = await Users.findOneAndUpdate(
      { _id: ctx.from.id, balance: { $gte: state.price } },
      { $inc: { balance: -state.price } },
      { returnDocument: "after" },
    );
    if (!paid) return ctx.reply("❌ Balans yetarli emas. Hisobni to‘ldiring.");

    try {
      const service = services.get(state.serviceId);
      const result = await smm({ action: "add", service: state.serviceId, link: state.link, quantity: state.quantity });
      await Orders.insertOne({
        botId,
        userId: ctx.from.id,
        serviceId: service.id,
        serviceName: service.name,
        link: state.link,
        quantity: state.quantity,
        charge: state.price,
        providerOrderId: String(result.order),
        status: "Pending",
        final: false,
        createdAt: new Date(),
      });
      await ctx.reply(`✅ Buyurtma qabul qilindi.\n№ ${result.order}\nNarx: ${som(state.price)}`, replyKeyboard(ctx.from.id));
    } catch (error) {
      await Users.updateOne({ _id: ctx.from.id }, { $inc: { balance: state.price } });
      await ctx.reply(`❌ Buyurtma rad qilindi. Pul balansingizga qaytarildi.\n${error.message}`);
    }
  });

  const STATUS_UZ = {
    Pending: "⏳ Kutilmoqda",
    Processing: "⚙️ Qayta ishlanmoqda",
    "In progress": "🚀 Bajarilmoqda",
    Completed: "✅ Bajarildi",
    Partial: "⚠️ Qisman bajarildi",
    Canceled: "❌ Bekor qilindi",
    Refunded: "↩️ Qaytarildi",
  };
  const FINAL_STATUSES = new Set(["Completed", "Partial", "Canceled", "Refunded"]);

  async function pollOrders() {
    if (!apiUrl || !apiKey) return;
    const openOrders = await Orders.find({ botId, final: { $ne: true } }).limit(100).toArray();
    if (!openOrders.length) return;

    let response;
    if (openOrders.length === 1) {
      response = await smm({ action: "status", order: openOrders[0].providerOrderId });
    } else {
      response = await smm({
        action: "status",
        orders: openOrders.map((order) => order.providerOrderId).join(","),
      });
    }

    for (const order of openOrders) {
      let statusData = openOrders.length === 1 ? response : response?.[order.providerOrderId];
      if (!statusData || statusData.error || !statusData.status || statusData.status === order.status) continue;

      const final = FINAL_STATUSES.has(statusData.status);
      await Orders.updateOne(
        { _id: order._id },
        { $set: { status: statusData.status, final, startsCount: statusData.start_count, remainsCount: statusData.remains } },
      );

      let refund = 0;
      if (statusData.status === "Canceled" || statusData.status === "Refunded") refund = order.charge;
      if (statusData.status === "Partial") {
        const remains = Number(statusData.remains);
        if (Number.isFinite(remains) && remains >= 0) {
          refund = Math.floor((order.charge * remains) / order.quantity);
        }
      }
      if (refund > 0) {
        const refundResult = await Orders.updateOne(
          { _id: order._id, refunded: { $ne: true } },
          { $set: { refunded: true, refund } },
        );
        if (refundResult.modifiedCount) {
          await Users.updateOne({ _id: order.userId }, { $inc: { balance: refund } });
        }
      }

      if (final) {
        await bot.sendMessage(
          order.userId,
          `${STATUS_UZ[statusData.status] || statusData.status}\nBuyurtma №${order.providerOrderId} · ${short(order.serviceName, 50)}${refund > 0 ? `\n💰 Balansingizga ${som(refund)} qaytarildi.` : ""}`,
        ).catch(() => {});
      }
    }
  }

  const orderPoll = setInterval(() => {
    pollOrders().catch((error) => console.error(`SMM bot ${botId} holatini tekshirib bo'lmadi:`, error.message));
  }, 60 * 1000);
  orderPoll.unref?.();

  return {
    cancelPending: async () => {
      states.clear();
    },
  };
}

module.exports = registerSmmPanel;
