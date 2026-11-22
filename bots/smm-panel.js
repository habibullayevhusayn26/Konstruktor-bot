"use strict";

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
  if (!Users || !Orders || !Topups) {
    throw new Error("SMM bot uchun MongoDB kolleksiyalari sozlanmagan.");
  }

  const env = process.env;
  const apiUrl = bot.config.smmApiUrl || env.SMM_API_URL || "";
  const apiKey = bot.config.smmApiKey || env.SMM_API_KEY || "";
  const usdRate = Number(bot.config.smmUsdRate || env.SMM_USD_RATE || 12700);
  const markup = Number(bot.config.smmMarkupPercent || env.SMM_MARKUP_PERCENT || 30);
  const card = bot.config.smmCardNumber || env.SMM_CARD_NUMBER || "0000 0000 0000 0000";
  const cardOwner = bot.config.smmCardOwner || env.SMM_CARD_OWNER || "";
  const states = new Map();
  const admins = new Set((env.ADMIN_IDS || "").split(",").map((id) => Number(id)).filter(Boolean));
  if (bot.config.ownerId) admins.add(Number(bot.config.ownerId));

  let services = new Map();
  let categories = [];

  async function smm(params) {
    if (!apiUrl || !apiKey) throw new Error("Provayder API hali sozlanmagan.");
    const response = await fetch(apiUrl, {
      method: "POST",
      body: new URLSearchParams({ key: apiKey, ...params }),
    });
    const data = await response.json();
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
  const replyKeyboard = {
    resize_keyboard: true,
    keyboard: [
      [{ text: "🛒 Buyurtma berish" }, { text: "📦 Buyurtmalarim" }],
      [{ text: "💰 Balans" }, { text: "💳 Hisobni to‘ldirish" }],
      [{ text: "☎️ Aloqa" }],
    ],
  };

  bot.command("start", async (ctx) => {
    states.delete(ctx.from.id);
    await ctx.reply(
      bot.config.welcome || "SMM xizmatlariga buyurtma berish botiga xush kelibsiz!",
      replyKeyboard,
    );
  });

  bot.command("cancel", async (ctx) => {
    states.delete(ctx.from.id);
    await ctx.reply("Amal bekor qilindi.", replyKeyboard);
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
        { $set: { name: ctx.from.first_name, username: ctx.from.username || null }, $setOnInsert: { balance: 0 } },
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
    await ctx.answerCallbackQuery();
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
    await ctx.answerCallbackQuery();
    await ctx.edit("Kategoriyani tanlang:", {
      reply_markup: {
        inline_keyboard: categories.map((category, index) =>
          [{ text: short(category.name, 50), callback_data: `cat:${index}:0` }],
        ),
      },
    });
  });

  bot.onCallbackData(/^svc:(\d+)$/, async (ctx, match) => {
    await ctx.answerCallbackQuery();
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
    await ctx.reply("Chek adminga yuborildi. Tasdiqlangach balans to‘ldiriladi.", replyKeyboard);
  });

  bot.onCallbackData(/^topup:(ok|no):(.+)$/, async (ctx, match) => {
    await ctx.answerCallbackQuery();
    if (!admins.has(ctx.from.id)) return;
    const { ObjectId } = require("mongodb");
    let id;
    try {
      id = new ObjectId(match[2]);
    } catch {
      return ctx.reply("To‘lov ID noto‘g‘ri.");
    }
    const topup = await Topups.findOne({ _id: id, status: "pending" });
    if (!topup) return ctx.reply("Bu to‘lov so‘rovi allaqachon ko‘rilgan.");
    const approved = match[1] === "ok";
    await Topups.updateOne({ _id: id }, { $set: { status: approved ? "approved" : "rejected" } });
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
    await ctx.answerCallbackQuery();
    const state = states.get(ctx.from.id);
    if (!state || state.step !== "confirm") return ctx.reply("Sessiya tugagan. Buyurtmani qaytadan boshlang.");
    states.delete(ctx.from.id);
    if (match[1] === "cancel") return ctx.reply("Buyurtma bekor qilindi.", replyKeyboard);

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
      await ctx.reply(`✅ Buyurtma qabul qilindi.\n№ ${result.order}\nNarx: ${som(state.price)}`, replyKeyboard);
    } catch (error) {
      await Users.updateOne({ _id: ctx.from.id }, { $inc: { balance: state.price } });
      await ctx.reply(`❌ Buyurtma rad qilindi. Pul balansingizga qaytarildi.\n${error.message}`);
    }
  });

  return {
    cancelPending: async () => {
      states.clear();
    },
  };
}

module.exports = registerSmmPanel;
