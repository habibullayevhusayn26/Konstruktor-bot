"use strict";

const crypto = require("node:crypto");

const PAYMENT_TTL_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 3_000;
const PREMIUM_PLANS = Object.freeze({
  1: Object.freeze({ months: 1, label: "1 oy" }),
  3: Object.freeze({ months: 3, label: "3 oy" }),
  12: Object.freeze({ months: 12, label: "12 oy" }),
});

function positiveAmount(value) {
  const amount = typeof value === "number" ? value : Number(String(value || "").replace(/\s/g, ""));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function createTolovPaymentService({
  botId,
  UserSchedulerUsers,
  api,
  notifyUser,
  onPaymentApplied,
  now = Date.now,
}) {
  const timers = new Map();
  const locks = new Map();
  let stopped = false;

  async function withUserLock(userId, operation) {
    const previous = locks.get(userId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    locks.set(userId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(userId) === current) locks.delete(userId);
    }
  }

  async function ensureUserRecord(userId) {
    const filter = { botId, userId };
    await UserSchedulerUsers.updateOne(
      filter,
      {
        $setOnInsert: {
          botId,
          userId,
          balance: 0,
          createdAt: new Date(now()),
        },
      },
      { upsert: true },
    );
    const record = await UserSchedulerUsers.findOne(filter);
    if (!record) throw new Error("User Bot foydalanuvchi yozuvi topilmadi.");
    return record;
  }

  async function sendNotification(userId, text) {
    try {
      await notifyUser(userId, text);
    } catch (error) {
      console.error(`User scheduler ${botId} ${userId} TolovAPI xabarini yubora olmadi:`, error.message);
    }
  }

  async function clearPendingPayment(userId, paymentId) {
    return UserSchedulerUsers.updateOne(
      { botId, userId, "pendingTolovPayment.paymentId": paymentId },
      { $unset: { pendingTolovPayment: "" } },
    );
  }

  function schedulePoll(userId, payment, delay = POLL_INTERVAL_MS) {
    if (stopped) return;
    const key = `${userId}:${payment.paymentId}`;
    if (timers.has(key)) return;
    const timer = setTimeout(() => {
      timers.delete(key);
      void check(userId).catch((error) => {
        console.error(`User scheduler ${botId} TolovAPI holatini tekshira olmadi:`, error.message);
        schedulePoll(userId, payment);
      });
    }, delay);
    timer.unref?.();
    timers.set(key, timer);
  }

  async function applyPaidPayment(userId, payment, result) {
    if (result.test) {
      await clearPendingPayment(userId, payment.paymentId);
      await sendNotification(userId, "TolovAPI test to‘lovi bo‘lgani uchun balans yoki Premium berilmadi.");
      return { status: "test" };
    }
    if (String(result.order_id || "") !== String(payment.orderId)) {
      throw new Error("TolovAPI order_id mos kelmadi; to'lov xavfsizlik uchun qo'llanmadi.");
    }
    if (positiveAmount(result.amount) !== payment.amount) {
      throw new Error("TolovAPI to'lov summasi mos kelmadi; to'lov xavfsizlik uchun qo'llanmadi.");
    }

    const user = await UserSchedulerUsers.findOne({ botId, userId });
    if (!user?.pendingTolovPayment || user.pendingTolovPayment.paymentId !== payment.paymentId) {
      return { status: "already_processed" };
    }
    const paidAt = new Date(now());
    const historyEntry = {
      provider: "tolovapi",
      purpose: payment.purpose,
      amount: payment.amount,
      orderId: payment.orderId,
      paymentId: payment.paymentId,
      paidAt,
    };
    const update = {
      $unset: { pendingTolovPayment: "" },
      $push: { autoPaymentHistory: historyEntry },
    };
    let premiumUntil = null;
    if (payment.purpose === "premium") {
      const plan = PREMIUM_PLANS[payment.months];
      if (!plan) throw new Error("Premium to'lov rejasi noto'g'ri.");
      const currentUntil = user.premiumUntil instanceof Date
        ? user.premiumUntil
        : user.premiumUntil
          ? new Date(user.premiumUntil)
          : null;
      const start = currentUntil && currentUntil > paidAt ? currentUntil : paidAt;
      premiumUntil = new Date(start);
      premiumUntil.setUTCMonth(premiumUntil.getUTCMonth() + plan.months);
      update.$set = {
        premium: true,
        premiumUntil,
        premiumPlan: plan.label,
      };
      update.$push.premiumHistory = {
        plan: plan.label,
        amount: payment.amount,
        method: "tolovapi",
        paidAt,
      };
    } else {
      update.$inc = { balance: payment.amount };
      update.$push.balanceHistory = historyEntry;
    }

    const saved = await UserSchedulerUsers.updateOne(
      { botId, userId, "pendingTolovPayment.paymentId": payment.paymentId },
      update,
    );
    if (saved.matchedCount !== 1) return { status: "already_processed" };

    const updatedUser = await UserSchedulerUsers.findOne({ botId, userId });
    await onPaymentApplied?.(userId, updatedUser);
    const text = payment.purpose === "premium"
      ? `TolovAPI to‘lovi tasdiqlandi.\n${PREMIUM_PLANS[payment.months].label} Premium faollashtirildi, ${premiumUntil.toLocaleDateString("uz-UZ")} gacha.`
      : `TolovAPI to‘lovi tasdiqlandi.\nBalansingizga ${payment.amount.toLocaleString("uz-UZ")} so‘m qo‘shildi.`;
    await sendNotification(userId, text);
    return { status: "paid", premiumUntil };
  }

  async function check(userId) {
    return withUserLock(userId, async () => {
      const user = await UserSchedulerUsers.findOne({ botId, userId });
      const payment = user?.pendingTolovPayment;
      if (!payment?.paymentId) return { status: "none" };

      const result = await api.paymentStatus(payment.paymentId);
      if (result?.status === "paid") {
        const applied = await applyPaidPayment(userId, payment, result);
        if (applied.status !== "already_processed") {
          return applied;
        }
        return { status: "already_processed" };
      }
      if (result?.status === "cancel") {
        await clearPendingPayment(userId, payment.paymentId);
        await sendNotification(userId, "TolovAPI to‘lovi bekor qilindi.");
        return { status: "cancel" };
      }
      if (result?.status !== "pending") {
        throw new Error(result?.error || "TolovAPI to'lov holatini qaytarmadi.");
      }

      const expiresAt = new Date(payment.expiresAt).getTime();
      if (Number.isFinite(expiresAt) && now() >= expiresAt) {
        const canceled = await api.cancelPayment(payment.paymentId);
        if (canceled?.status === "paid") {
          const paid = await api.paymentStatus(payment.paymentId);
          if (paid?.status !== "paid") {
            throw new Error("TolovAPI bekor qilish va holat javoblari mos kelmadi.");
          }
          const applied = await applyPaidPayment(userId, payment, paid);
          if (applied.status !== "already_processed") return applied;
        } else if (canceled?.status === "cancel") {
          await clearPendingPayment(userId, payment.paymentId);
          await sendNotification(userId, "To‘lov vaqti tugadi. Qayta urinib ko‘rishingiz mumkin.");
          return { status: "expired" };
        } else if (!canceled?.ok) {
          throw new Error(canceled?.error || "TolovAPI to'lovni bekor qila olmadi.");
        }
      }
      schedulePoll(userId, payment);
      return { status: "pending", payment };
    });
  }

  async function createProviderPayment(userId, request) {
    const result = await api.createPayment(request.orderId, request.amount);
    if (result?.error_code === "amount_busy") {
      const suggestedAmount = positiveAmount(result.suggested_amount);
      if (!suggestedAmount) {
        throw new Error("TolovAPI band summa uchun yaroqli muqobil summa bermadi.");
      }
      await UserSchedulerUsers.updateOne(
        { botId, userId },
        {
          $set: {
            pendingTolovRequest: {
              ...request,
              requestedAmount: request.amount,
              amount: suggestedAmount,
              suggestedAt: new Date(now()),
            },
          },
        },
        { upsert: true },
      );
      return { status: "amount_busy", requestedAmount: request.amount, suggestedAmount };
    }
    if (!result?.ok) {
      throw new Error(result?.error || "TolovAPI to'lov yaratilmadi.");
    }

    const paymentId = result.payment_id == null ? "" : String(result.payment_id);
    const amount = positiveAmount(result.amount);
    const cardNumber = typeof result.card_number === "string" ? result.card_number.trim() : "";
    const expiresAt = new Date(result.expires_at);
    if (!paymentId || !amount || !cardNumber || !Number.isFinite(expiresAt.getTime())) {
      if (paymentId) {
        await api.cancelPayment(paymentId).catch((error) => {
          console.error(`User scheduler ${botId} TolovAPI to'lovini bekor qila olmadi:`, error.message);
        });
      }
      throw new Error("TolovAPI to'lov ma'lumotlari to'liq emas.");
    }

    const payment = {
      paymentId,
      orderId: request.orderId,
      purpose: request.purpose,
      amount,
      months: request.months,
      cardNumber,
      cardLast4: String(result.card_last4 || ""),
      expiresAt,
      createdAt: new Date(now()),
    };
    try {
      const saved = await UserSchedulerUsers.updateOne(
        {
          botId,
          userId,
          "pendingTolovPayment": { $exists: false },
        },
        {
          $set: { pendingTolovPayment: payment },
          $unset: { pendingTolovRequest: "" },
        },
      );
      if (saved.matchedCount !== 1) {
        throw new Error("Sizda boshqa kutayotgan TolovAPI to'lovi bor.");
      }
    } catch (error) {
      await api.cancelPayment(paymentId).catch((cancelError) => {
        console.error(`User scheduler ${botId} saqlanmagan TolovAPI to'lovini bekor qila olmadi:`, cancelError.message);
      });
      throw error;
    }
    schedulePoll(userId, payment);
    return { status: "created", payment };
  }

  async function create(userId, { purpose, amount, months }) {
    if (!api.isConfigured()) {
      throw new Error("TolovAPI sozlanmagan. Bot egasi server environment qiymatlarini kiritishi kerak.");
    }
    const normalizedAmount = positiveAmount(amount);
    if (!normalizedAmount) throw new Error("Summani musbat butun so'mda kiriting.");
    if (purpose !== "balance" && purpose !== "premium") {
      throw new Error("TolovAPI to'lov maqsadi noto'g'ri.");
    }
    if (purpose === "premium" && !PREMIUM_PLANS[months]) {
      throw new Error("Premium muddati noto'g'ri.");
    }

    return withUserLock(userId, async () => {
      const user = await ensureUserRecord(userId);
      if (user.pendingTolovPayment?.paymentId) {
        return { status: "existing", payment: user.pendingTolovPayment };
      }
      if (user.pendingTolovRequest) {
        const suggestedAt = new Date(user.pendingTolovRequest.suggestedAt).getTime();
        if (Number.isFinite(suggestedAt) && now() - suggestedAt <= PAYMENT_TTL_MS) {
          return {
            status: "amount_busy",
            requestedAmount: user.pendingTolovRequest.requestedAmount,
            suggestedAmount: user.pendingTolovRequest.amount,
          };
        }
        await UserSchedulerUsers.updateOne(
          { botId, userId },
          { $unset: { pendingTolovRequest: "" } },
        );
      }
      const request = {
        orderId: `ub${botId}_${userId}_${crypto.randomBytes(6).toString("hex")}`,
        purpose,
        amount: normalizedAmount,
        ...(purpose === "premium" ? { months: Number(months) } : {}),
      };
      return createProviderPayment(userId, request);
    });
  }

  async function confirm(userId) {
    if (!api.isConfigured()) throw new Error("TolovAPI sozlanmagan.");
    return withUserLock(userId, async () => {
      const user = await UserSchedulerUsers.findOne({ botId, userId });
      const request = user?.pendingTolovRequest;
      if (!request) throw new Error("Tasdiqlash uchun kutilayotgan summa topilmadi.");
      if (user.pendingTolovPayment?.paymentId) {
        throw new Error("Sizda boshqa kutayotgan TolovAPI to'lovi bor.");
      }
      const suggestedAt = new Date(request.suggestedAt).getTime();
      if (!Number.isFinite(suggestedAt) || now() - suggestedAt > PAYMENT_TTL_MS) {
        await UserSchedulerUsers.updateOne(
          { botId, userId },
          { $unset: { pendingTolovRequest: "" } },
        );
        throw new Error("TolovAPI taklif qilgan summa eskirgan. To'lovni qaytadan boshlang.");
      }
      return createProviderPayment(userId, request);
    });
  }

  async function cancel(userId) {
    return withUserLock(userId, async () => {
      const user = await UserSchedulerUsers.findOne({ botId, userId });
      if (user?.pendingTolovRequest) {
        await UserSchedulerUsers.updateOne(
          { botId, userId },
          { $unset: { pendingTolovRequest: "" } },
        );
        return { status: "cancelled" };
      }
      const payment = user?.pendingTolovPayment;
      if (!payment?.paymentId) return { status: "none" };

      const result = await api.cancelPayment(payment.paymentId);
      if (result?.status === "paid") {
        const paid = await api.paymentStatus(payment.paymentId);
        if (paid?.status !== "paid") {
          throw new Error("TolovAPI bekor qilish va holat javoblari mos kelmadi.");
        }
        return applyPaidPayment(userId, payment, paid);
      }
      if (result?.status === "cancel") {
        await clearPendingPayment(userId, payment.paymentId);
        return { status: "cancelled" };
      }
      if (!result?.ok) throw new Error(result?.error || "TolovAPI to'lovni bekor qila olmadi.");
      schedulePoll(userId, payment);
      return { status: "pending", payment };
    });
  }

  async function resume() {
    if (!api.isConfigured()) return;
    const users = await UserSchedulerUsers.find({
      botId,
      "pendingTolovPayment.paymentId": { $exists: true },
    }).toArray();
    for (const user of users) {
      if (user.pendingTolovPayment?.paymentId) {
        schedulePoll(Number(user.userId), user.pendingTolovPayment, 0);
      }
    }
  }

  function stop() {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return {
    isConfigured: api.isConfigured,
    create,
    confirm,
    cancel,
    check,
    resume,
    stop,
  };
}

module.exports = {
  POLL_INTERVAL_MS,
  PAYMENT_TTL_MS,
  createTolovPaymentService,
};
