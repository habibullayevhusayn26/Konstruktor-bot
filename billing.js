const crypto = require("node:crypto");

const BOT_TYPES = [
  "smm",
  "qr",
  "nickname",
  "footer",
  "watermark",
  "music",
  "file-editor",
  "image-text",
];

const DEFAULT_BILLING_SETTINGS = Object.freeze({
  _id: "billing",
  prices: Object.freeze(
    Object.fromEntries(
      BOT_TYPES.map((type) => [
        type,
        Object.freeze({ initial: 10000, monthly: 1000, enabled: true }),
      ]),
    ),
  ),
  stars: Object.freeze({ count: 100, amount: 25000 }),
  paymentInstructions: "",
  sampleBots: Object.freeze(Object.fromEntries(BOT_TYPES.map((type) => [type, ""]))),
});

function getBillingSettings(stored = {}) {
  const prices = {};
  const sampleBots = {};
  for (const type of BOT_TYPES) {
    prices[type] = {
      ...DEFAULT_BILLING_SETTINGS.prices[type],
      ...(stored.prices?.[type] || {}),
    };
    sampleBots[type] =
      typeof stored.sampleBots?.[type] === "string"
        ? stored.sampleBots[type]
        : DEFAULT_BILLING_SETTINGS.sampleBots[type];
  }
  return {
    ...DEFAULT_BILLING_SETTINGS,
    ...stored,
    prices,
    stars: {
      ...DEFAULT_BILLING_SETTINGS.stars,
      ...(stored.stars || {}),
    },
    paymentInstructions:
      typeof stored.paymentInstructions === "string"
        ? stored.paymentInstructions
        : DEFAULT_BILLING_SETTINGS.paymentInstructions,
    sampleBots,
  };
}

function parseSampleBotUsername(value) {
  const input = String(value || "").trim();
  if (input === "/clear") return "";

  const match =
    input.match(/^@?([A-Za-z0-9_]{5,32})$/) ||
    input.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/([A-Za-z0-9_]{5,32})\/?$/i);
  return match ? match[1] : null;
}

function addCalendarMonth(date) {
  const next = new Date(date);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

class BillingService {
  constructor({
    client,
    Bots,
    Users,
    Topups,
    BalanceTransactions,
    PlatformSettings,
    stopChild,
    startChild,
    notifyOwner,
  }) {
    this.client = client;
    this.Bots = Bots;
    this.Users = Users;
    this.Topups = Topups;
    this.BalanceTransactions = BalanceTransactions;
    this.PlatformSettings = PlatformSettings;
    this.stopChild = stopChild;
    this.startChild = startChild;
    this.notifyOwner = notifyOwner;
  }

  async settings() {
    return getBillingSettings(
      (await this.PlatformSettings.findOne({ _id: "billing" })) || {},
    );
  }

  async withTransaction(operation) {
    const session = this.client.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await operation(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async approveManualTopup(topupId, adminId) {
    return this.withTransaction(async (session) => {
      const topup = await this.Topups.findOne(
        { _id: topupId, method: "manual", status: "pending" },
        { session },
      );
      if (!topup) return null;

      const changed = await this.Topups.updateOne(
        { _id: topupId, method: "manual", status: "pending" },
        {
          $set: {
            status: "approved",
            reviewedBy: adminId,
            reviewedAt: new Date(),
          },
        },
        { session },
      );
      if (!changed.modifiedCount) return null;

      await this.Users.updateOne(
        { _id: topup.ownerId },
        { $inc: { balance: topup.amount } },
        { upsert: true, session },
      );
      await this.BalanceTransactions.insertOne(
        {
          ownerId: topup.ownerId,
          amount: topup.amount,
          type: "manual_topup",
          reference: `manual-topup:${topupId}`,
          createdAt: new Date(),
          reviewedBy: adminId,
        },
        { session },
      );
      return topup;
    });
  }

  async rejectManualTopup(topupId, adminId) {
    return this.Topups.updateOne(
      { _id: topupId, method: "manual", status: "pending" },
      {
        $set: {
          status: "rejected",
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
      },
    );
  }

  async setUserBalance(ownerId, balance, adminId) {
    if (!Number.isSafeInteger(balance) || balance < 0) {
      throw new Error("Balans 0 yoki undan katta butun so'm bo'lishi kerak.");
    }

    return this.withTransaction(async (session) => {
      const user = await this.Users.findOne({ _id: ownerId }, { session });
      const oldBalance = Number(user?.balance) || 0;
      await this.Users.updateOne(
        { _id: ownerId },
        { $set: { balance } },
        { upsert: true, session },
      );
      await this.BalanceTransactions.insertOne(
        {
          ownerId,
          amount: balance - oldBalance,
          balanceAfter: balance,
          type: "admin_balance_adjustment",
          reference: `admin-balance:${crypto.randomUUID()}`,
          adminId,
          createdAt: new Date(),
        },
        { session },
      );
      return { oldBalance, balance };
    });
  }

  async completeStarsTopup(ownerId, payment) {
    const credited = await this.withTransaction(async (session) => {
      const topup = await this.Topups.findOne(
        {
          ownerId,
          method: "stars",
          status: "pending",
          payload: payment.invoice_payload,
          stars: payment.total_amount,
          currency: payment.currency,
        },
        { session },
      );
      if (!topup) return null;

      const changed = await this.Topups.updateOne(
        { _id: topup._id, status: "pending" },
        {
          $set: {
            status: "approved",
            telegramChargeId: payment.telegram_payment_charge_id,
            providerChargeId: payment.provider_payment_charge_id,
            reviewedAt: new Date(),
          },
        },
        { session },
      );
      if (!changed.modifiedCount) return null;

      await this.Users.updateOne(
        { _id: ownerId },
        { $inc: { balance: topup.amount } },
        { upsert: true, session },
      );
      await this.BalanceTransactions.insertOne(
        {
          ownerId,
          amount: topup.amount,
          type: "stars_topup",
          reference: `stars-topup:${topup._id}`,
          createdAt: new Date(),
          stars: topup.stars,
        },
        { session },
      );
      return topup;
    });

    return credited;
  }

  async processDueBots(ownerId, now = new Date()) {
    const filter = {
      $or: [
        { initialFeePaid: { $ne: true }, trialEndsAt: { $lte: now } },
        { initialFeePaid: true, nextBillingAt: { $lte: now } },
      ],
    };
    if (ownerId !== undefined) filter.ownerId = ownerId;

    const summary = { charged: 0, suspended: 0, resumed: 0 };
    for await (const bot of this.Bots.find(filter)) {
      const result = await this.chargeBot(bot._id, now);
      if (!result) continue;

      if (result.status === "charged") {
        summary.charged++;
        if (result.wasSuspended) {
          try {
            await this.startChild(result.bot);
            summary.resumed++;
          } catch (error) {
            console.error(`@${result.bot.username} qayta ishga tushmadi:`, error.message);
          }
        }
      } else if (result.status === "suspended") {
        this.stopChild(bot._id);
        summary.suspended++;
        if (result.notify) {
          await this.notifyOwner(
            bot.ownerId,
            `⏸ @${bot.username} boti balans yetarli bo'lmagani uchun to'xtatildi. Balansni to'ldiring — bot avtomatik qayta ishga tushadi.`,
          );
        }
      }
    }
    return summary;
  }

  async chargeBot(botId, now) {
    const result = await this.withTransaction(async (session) => {
      const bot = await this.Bots.findOne({ _id: botId }, { session });
      if (!bot || bot.banned) return null;

      const isInitialCharge = bot.initialFeePaid !== true;
      const dueAt = isInitialCharge ? bot.trialEndsAt : bot.nextBillingAt;
      if (!(dueAt instanceof Date) || dueAt > now) return null;

      const initial = Number(bot.pricing?.initial) || 0;
      const monthly = Number(bot.pricing?.monthly) || 0;
      const amount = isInitialCharge ? initial + monthly : monthly;
      const reference = isInitialCharge
        ? `bot-initial:${bot._id}`
        : `bot-monthly:${bot._id}:${dueAt.toISOString()}`;
      const prior = await this.BalanceTransactions.findOne(
        { reference },
        { session },
      );
      if (prior) return null;

      const debit =
        amount === 0
          ? { matchedCount: 1 }
          : await this.Users.updateOne(
              { _id: bot.ownerId, balance: { $gte: amount } },
              { $inc: { balance: -amount } },
              { session },
            );
      if (!debit.matchedCount) {
        const changed = await this.Bots.updateOne(
          { _id: bot._id },
          {
            $set: {
              billingStatus: "suspended",
              suspendedAt: now,
            },
          },
          { session },
        );
        return {
          status: "suspended",
          notify: changed.modifiedCount > 0 && bot.billingStatus !== "suspended",
        };
      }

      const nextBillingAt = addCalendarMonth(now);
      const update = {
        initialFeePaid: true,
        billingStatus: "active",
        nextBillingAt,
        paidThrough: nextBillingAt,
      };
      const changed = await this.Bots.updateOne(
        { _id: bot._id },
        { $set: update, $unset: { suspendedAt: "" } },
        { session },
      );
      if (!changed.matchedCount) throw new Error("Bot billing yozuvini yangilab bo'lmadi.");

      await this.BalanceTransactions.insertOne(
        {
          ownerId: bot.ownerId,
          botId: bot._id,
          amount: -amount,
          type: isInitialCharge ? "bot_initial_fee" : "bot_monthly_fee",
          reference,
          createdAt: now,
        },
        { session },
      );
      return {
        status: "charged",
        wasSuspended: bot.billingStatus === "suspended",
        bot: { ...bot, ...update },
      };
    });
    return result;
  }
}

module.exports = {
  BOT_TYPES,
  BillingService,
  DEFAULT_BILLING_SETTINGS,
  addCalendarMonth,
  getBillingSettings,
  parseSampleBotUsername,
};
