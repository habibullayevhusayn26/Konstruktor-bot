"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BotConstructor } = require("../bot-constructor");
const { createTolovApi } = require("../bots/user-scheduler/tolov-api");
const { createTolovPaymentService } = require("../bots/user-scheduler/tolov-payments");
const {
  purchasePremiumWithBalance,
  registerUserScheduler,
} = require("../bots/user-scheduler");

function createPaymentStore() {
  const records = new Map();
  const recordKey = ({ botId, userId }) => `${botId}:${userId}`;
  const getPath = (record, path) => path.split(".").reduce(
    (value, key) => value == null ? undefined : value[key],
    record,
  );
  const matches = (record, filter) => Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((condition) => matches(record, condition));
    const actual = getPath(record, key);
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, "$exists")) {
        return (actual !== undefined) === expected.$exists;
      }
      if (Object.prototype.hasOwnProperty.call(expected, "$gte")) {
        return Number(actual) >= expected.$gte;
      }
    }
    return actual === expected;
  });
  return {
    records,
    collection: {
      async updateOne(filter, update, options = {}) {
        const key = recordKey(filter);
        let record = records.get(key);
        const inserted = !record;
        if (record && !matches(record, filter)) return { matchedCount: 0 };
        if (!record && !options.upsert) return { matchedCount: 0 };
        if (!record) {
          record = { botId: filter.botId, userId: filter.userId };
          records.set(key, record);
        }
        if (inserted && update.$setOnInsert) Object.assign(record, update.$setOnInsert);
        if (update.$set) Object.assign(record, update.$set);
        if (update.$inc) {
          for (const [field, amount] of Object.entries(update.$inc)) {
            record[field] = (Number(record[field]) || 0) + amount;
          }
        }
        if (update.$push) {
          for (const [field, value] of Object.entries(update.$push)) {
            if (!Array.isArray(record[field])) record[field] = [];
            record[field].push(value);
          }
        }
        if (update.$unset) {
          for (const field of Object.keys(update.$unset)) delete record[field];
        }
        return { matchedCount: inserted ? 0 : 1, upsertedCount: inserted ? 1 : 0 };
      },
      async findOne(filter) {
        const record = records.get(recordKey(filter));
        return record ? structuredClone(record) : null;
      },
      find(filter) {
        return {
          toArray: async () => [...records.values()]
            .filter((record) => record.botId === filter.botId && matches(record, filter))
            .map((record) => structuredClone(record)),
        };
      },
    },
  };
}

test("TolovAPI uses the shop key header and supports create, status, and cancel", async () => {
  const calls = [];
  const responses = [
    { ok: false, status: 409, body: { ok: false, error_code: "amount_busy", suggested_amount: 50017 } },
    { ok: true, status: 200, body: { ok: true, status: "pending" } },
    { ok: true, status: 200, body: { ok: true, status: "cancel" } },
  ];
  const api = createTolovApi({
    shopId: "test-shop",
    shopKey: "test-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      const response = responses.shift();
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.body,
      };
    },
  });

  assert.equal(api.isConfigured(), true);
  assert.deepEqual(
    await api.createPayment("order-1", 50000),
    { ok: false, error_code: "amount_busy", suggested_amount: 50017 },
  );
  assert.deepEqual(await api.paymentStatus("payment-1"), { ok: true, status: "pending" });
  assert.deepEqual(await api.cancelPayment("payment-1"), { ok: true, status: "cancel" });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://tolovapi.uz/api/payment/create");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Shop-Key"], "test-secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    shop_id: "test-shop",
    amount: 50000,
    order_id: "order-1",
  });
  assert.match(calls[1].url, /payment\/status\?.*payment_id=payment-1/);
  assert.equal(calls[1].options.headers["X-Shop-Key"], "test-secret");
  assert.equal(calls[2].options.headers["X-Shop-Key"], "test-secret");
});

test("TolovAPI rejects requests when credentials are missing", async () => {
  const api = createTolovApi({ shopId: "", shopKey: "", fetchImpl: async () => { throw new Error("unexpected"); } });
  assert.equal(api.isConfigured(), false);
  await assert.rejects(api.createPayment("order", 50000), /sozlanmagan/);
});

test("TolovAPI reads each bot's current credentials without sharing them", async () => {
  const calls = [];
  const firstBot = { shopId: "shop-one", shopKey: "key-one" };
  const secondBot = { shopId: "shop-two", shopKey: "key-two" };
  const makeApi = (settings) => createTolovApi({
    getCredentials: () => ({ ...settings }),
    isConfigured: () => Boolean(settings.shopId && settings.shopKey),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  const firstApi = makeApi(firstBot);
  const secondApi = makeApi(secondBot);

  await firstApi.createPayment("order-one", 1000);
  await secondApi.createPayment("order-two", 2000);
  firstBot.shopId = "shop-one-updated";
  firstBot.shopKey = "key-one-updated";
  await firstApi.createPayment("order-one-updated", 3000);

  assert.equal(calls[0].options.headers["X-Shop-Key"], "key-one");
  assert.equal(JSON.parse(calls[0].options.body).shop_id, "shop-one");
  assert.equal(calls[1].options.headers["X-Shop-Key"], "key-two");
  assert.equal(JSON.parse(calls[1].options.body).shop_id, "shop-two");
  assert.equal(calls[2].options.headers["X-Shop-Key"], "key-one-updated");
  assert.equal(JSON.parse(calls[2].options.body).shop_id, "shop-one-updated");
});

test("amount-busy suggestions require confirmation before creating Premium payment", async () => {
  const store = createPaymentStore();
  const calls = [];
  const notifications = [];
  const api = {
    isConfigured: () => true,
    async createPayment(orderId, amount) {
      calls.push({ orderId, amount });
      if (calls.length === 1) {
        return { ok: false, error_code: "amount_busy", suggested_amount: 50017 };
      }
      return {
        ok: true,
        payment_id: "payment-1",
        amount,
        card_number: "8600 0000 0000 0000",
        card_last4: "0000",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async paymentStatus(paymentId) {
      return {
        ok: true,
        status: "paid",
        payment_id: paymentId,
        order_id: calls[1].orderId,
        amount: 50017,
      };
    },
    async cancelPayment() {
      return { ok: true, status: "cancel" };
    },
  };
  const service = createTolovPaymentService({
    botId: 88,
    UserSchedulerUsers: store.collection,
    api,
    notifyUser: async (userId, text) => notifications.push({ userId, text }),
  });

  try {
    const busy = await service.create(77, { purpose: "premium", amount: 50000, months: 1 });
    assert.deepEqual(
      { status: busy.status, requestedAmount: busy.requestedAmount, suggestedAmount: busy.suggestedAmount },
      { status: "amount_busy", requestedAmount: 50000, suggestedAmount: 50017 },
    );
    assert.equal(calls.length, 1);
    const created = await service.confirm(77);
    assert.equal(created.status, "created");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].orderId, calls[1].orderId);
    assert.equal(calls[1].amount, 50017);

    const paid = await service.check(77);
    assert.equal(paid.status, "paid");
    const user = await store.collection.findOne({ botId: 88, userId: 77 });
    assert.equal(user.premium, true);
    assert.equal(user.balance, 0);
    assert.equal(user.premiumHistory.length, 1);
    assert.equal(user.premiumHistory[0].method, "tolovapi");
    assert.equal(user.pendingTolovPayment, undefined);
    assert.match(user.tolovPaymentHistory[0].transactionId, /^TXN-[A-Z0-9]+-[A-F0-9]{12}$/);
    assert.equal(user.tolovPaymentHistory[0].status, "paid");
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].text, /Premium faollashtirildi/);
    assert.equal((await service.check(77)).status, "none");
    assert.equal((await store.collection.findOne({ botId: 88, userId: 77 })).premiumHistory.length, 1);
  } finally {
    service.stop();
  }
});

test("paid balance top-ups credit the User Bot balance once", async () => {
  const store = createPaymentStore();
  const now = Date.now();
  const api = {
    isConfigured: () => true,
    async createPayment(orderId, amount) {
      return {
        ok: true,
        payment_id: "payment-balance",
        order_id: orderId,
        amount,
        card_number: "8600 0000 0000 0000",
        expires_at: new Date(now + 60_000).toISOString(),
      };
    },
    async paymentStatus(paymentId) {
      const user = await store.collection.findOne({ botId: 88, userId: 77 });
      return {
        ok: true,
        status: "paid",
        payment_id: paymentId,
        order_id: user.pendingTolovPayment.orderId,
        amount: user.pendingTolovPayment.amount,
      };
    },
    async cancelPayment() {
      return { ok: true, status: "cancel" };
    },
  };
  const service = createTolovPaymentService({
    botId: 88,
    UserSchedulerUsers: store.collection,
    api,
    notifyUser: async () => {},
    now: () => now,
  });

  try {
    const created = await service.create(77, { purpose: "balance", amount: 25000 });
    assert.equal(created.status, "created");
    assert.equal(created.payment.requestedAmount, 25000);
    assert.equal(created.payment.amount, 25001);
    assert.match(created.payment.transactionId, /^TXN-[A-Z0-9]+-[A-F0-9]{12}$/);
    assert.equal((await service.check(77)).status, "paid");
    assert.equal((await store.collection.findOne({ botId: 88, userId: 77 })).balance, 25001);
    assert.equal((await service.check(77)).status, "none");
    const user = await store.collection.findOne({ botId: 88, userId: 77 });
    assert.equal(user.balanceHistory.length, 1);
    assert.equal(user.autoPaymentHistory.length, 1);
    assert.equal(user.autoPaymentHistory[0].transactionId, created.payment.transactionId);
    assert.equal(user.tolovPaymentHistory[0].status, "paid");
  } finally {
    service.stop();
  }
});

test("concurrent top-ups receive distinct amounts and expire within five minutes", async () => {
  const store = createPaymentStore();
  const now = Date.now();
  const requests = [];
  const api = {
    isConfigured: () => true,
    async createPayment(orderId, amount) {
      requests.push({ orderId, amount });
      return {
        ok: true,
        payment_id: `payment-${requests.length}`,
        amount,
        card_number: "8600 0000 0000 0000",
        expires_at: new Date(now + 60 * 60_000).toISOString(),
      };
    },
    async paymentStatus() {
      return { ok: true, status: "pending" };
    },
    async cancelPayment() {
      return { ok: true, status: "cancel" };
    },
  };
  const service = createTolovPaymentService({
    botId: 88,
    UserSchedulerUsers: store.collection,
    api,
    notifyUser: async () => {},
    now: () => now,
  });

  try {
    const [first, second] = await Promise.all([
      service.create(77, { purpose: "balance", amount: 1500 }),
      service.create(78, { purpose: "balance", amount: 1500 }),
    ]);
    assert.deepEqual(requests.map((request) => request.amount), [1501, 1502]);
    assert.deepEqual([first.payment.amount, second.payment.amount], [1501, 1502]);
    for (const result of [first, second]) {
      assert.equal(result.payment.expiresAt.getTime(), now + 5 * 60_000);
    }
  } finally {
    service.stop();
  }
});

test("the five-minute window starts with the submitted amount, not TolovAPI's expiry timestamp", async () => {
  const store = createPaymentStore();
  const enteredAt = Date.now();
  let currentTime = enteredAt;
  const api = {
    isConfigured: () => true,
    async createPayment(orderId, amount) {
      currentTime += 60_000;
      return {
        ok: true,
        payment_id: "payment-stale-expiry",
        amount,
        card_number: "8600 0000 0000 0000",
        expires_at: new Date(enteredAt - 1).toISOString(),
      };
    },
    async paymentStatus() {
      return { ok: true, status: "pending" };
    },
    async cancelPayment() {
      return { ok: true, status: "cancel" };
    },
  };
  const service = createTolovPaymentService({
    botId: 88,
    UserSchedulerUsers: store.collection,
    api,
    notifyUser: async () => {},
    now: () => currentTime,
  });

  try {
    const created = await service.create(77, { purpose: "balance", amount: 1500 });
    assert.equal(created.payment.createdAt.getTime(), enteredAt);
    assert.equal(created.payment.expiresAt.getTime(), enteredAt + 5 * 60_000);
    assert.equal((await service.check(77)).status, "pending");
  } finally {
    service.stop();
  }
});

test("expired pending TolovAPI payment is cancelled without credit", async () => {
  const store = createPaymentStore();
  const now = Date.now();
  let currentTime = now;
  const api = {
    isConfigured: () => true,
    async createPayment(orderId, amount) {
      return {
        ok: true,
        payment_id: "payment-expired",
        amount,
        card_number: "8600 0000 0000 0000",
        expires_at: new Date(now + 60_000).toISOString(),
      };
    },
    async paymentStatus() {
      return { ok: true, status: "pending" };
    },
    async cancelPayment() {
      return { ok: true, status: "cancel" };
    },
  };
  const service = createTolovPaymentService({
    botId: 88,
    UserSchedulerUsers: store.collection,
    api,
    notifyUser: async () => {},
    now: () => currentTime,
  });

  try {
    await service.create(77, { purpose: "balance", amount: 10000 });
    currentTime = now + 5 * 60_000 + 1;
    assert.equal((await service.check(77)).status, "expired");
    const user = await store.collection.findOne({ botId: 88, userId: 77 });
    assert.equal(user.balance, 0);
    assert.equal(user.pendingTolovPayment, undefined);
    assert.equal(user.tolovPaymentHistory[0].status, "expired");
  } finally {
    service.stop();
  }
});

test("Premium can be purchased with balance and insufficient funds do not debit it", async () => {
  const store = createPaymentStore();
  const record = {
    botId: 88,
    userId: 77,
    balance: 120000,
    premiumHistory: [],
  };
  store.records.set("88:77", record);
  const now = new Date("2026-11-28T00:00:00.000Z");
  const purchased = await purchasePremiumWithBalance({
    UserSchedulerUsers: store.collection,
    botId: 88,
    userId: 77,
    months: 1,
    prices: { 1: 50000 },
    now,
  });
  assert.equal(purchased.status, "purchased");
  assert.equal(purchased.user.balance, 70000);
  assert.equal(purchased.user.premium, true);
  assert.equal(purchased.user.premiumHistory[0].method, "balance");

  const insufficient = await purchasePremiumWithBalance({
    UserSchedulerUsers: store.collection,
    botId: 88,
    userId: 77,
    months: 3,
    prices: { 3: 120000 },
    now,
  });
  assert.equal(insufficient.status, "insufficient");
  assert.equal(insufficient.currentBalance, 70000);
  assert.equal((await store.collection.findOne({ botId: 88, userId: 77 })).balance, 70000);
});

test("User Bot Premium menu creates a TolovAPI payment using the admin price", async () => {
  const store = createPaymentStore();
  const bot = new BotConstructor("test-token");
  const sent = [];
  bot.api = async (method, payload) => {
    sent.push({ method, payload });
    return { message_id: sent.length };
  };
  const paymentRequests = [];
  const tolovApi = {
    isConfigured: () => true,
    async createPayment(orderId, amount) {
      paymentRequests.push({ orderId, amount });
      return {
        ok: true,
        payment_id: "payment-ui",
        amount,
        card_number: "8600 0000 0000 0000",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async paymentStatus() {
      return { ok: true, status: "pending" };
    },
    async cancelPayment() {
      return { ok: true, status: "cancel" };
    },
  };
  const runtime = registerUserScheduler(bot, {
    doc: {
      _id: 88,
      ownerId: 77,
      username: "test_user_bot",
      premiumSettings: {
        stars: { 1: 100, 3: 250, 12: 800 },
        tolovApiPrices: { 1: 25000, 3: 70000, 12: 200000 },
      },
    },
    Bots: { updateOne: async () => ({ matchedCount: 1 }) },
    UserSchedulerUsers: store.collection,
    encryptSecret: (value) => value,
    decryptSecret: (value) => value,
    tolovApi,
  });

  try {
    await bot.processUpdate({
      callback_query: {
        id: "open-autopay",
        from: { id: 77 },
        message: { chat: { id: 77, type: "private" }, message_id: 1 },
        data: "premium:autopay",
      },
    });
    assert.ok(sent.some(({ method, payload }) =>
      method === "sendMessage" && payload.text.includes("TolovAPI orqali Premium"),
    ));

    await bot.processUpdate({
      callback_query: {
        id: "create-payment",
        from: { id: 77 },
        message: { chat: { id: 77, type: "private" }, message_id: 2 },
        data: "premium:autobuy:1",
      },
    });

    assert.equal(paymentRequests.length, 1);
    assert.equal(paymentRequests[0].amount, 25000);
    assert.ok(sent.some(({ method, payload }) =>
      method === "sendMessage" &&
      payload.text.includes("8600 0000 0000 0000") &&
      payload.reply_markup.inline_keyboard[0][0].callback_data === "userbot:tolov-cancel",
    ));
  } finally {
    await runtime.stop();
  }
});

test("User Bot balance button accepts a top-up amount and creates its payment", async () => {
  const store = createPaymentStore();
  const bot = new BotConstructor("test-token");
  bot.api = async () => ({ message_id: 1 });
  const sent = [];
  const requests = [];
  const runtime = registerUserScheduler(bot, {
    doc: { _id: 88, ownerId: 77, username: "test_user_bot" },
    Bots: { updateOne: async () => ({ matchedCount: 1 }) },
    UserSchedulerUsers: store.collection,
    encryptSecret: (value) => value,
    decryptSecret: (value) => value,
    createSessionBot: (token, options) => {
      const sessionBot = new BotConstructor(token, options);
      sessionBot.api = async (method, payload) => {
        sent.push({ method, payload });
        return { message_id: sent.length };
      };
      return sessionBot;
    },
    tolovApi: {
      isConfigured: () => true,
      async createPayment(orderId, amount) {
        requests.push({ orderId, amount });
        return {
          ok: true,
          payment_id: "payment-topup-ui",
          amount,
          card_number: "8600 0000 0000 0000",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      async paymentStatus() {
        return { ok: true, status: "pending" };
      },
      async cancelPayment() {
        return { ok: true, status: "cancel" };
      },
    },
  });

  try {
    await bot.processUpdate({
      callback_query: {
        id: "open-balance",
        from: { id: 77 },
        message: { chat: { id: 77, type: "private" }, message_id: 1 },
        data: "userbot:balance",
      },
    });
    await bot.processUpdate({
      message: {
        message_id: 2,
        chat: { id: 77, type: "private" },
        from: { id: 77 },
        text: "30000",
      },
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].amount, 30001);
    const paymentMessage = sent.find(({ method, payload }) =>
      method === "sendMessage" &&
      payload.text.includes("8600 0000 0000 0000") &&
      payload.text.includes("aynan") &&
      payload.text.includes("yuboring"),
    );
    assert.ok(paymentMessage);
    assert.match(paymentMessage.payload.text.replace(/\u00a0/g, " "), /aynan 30 001 so'm yuboring/);
  } finally {
    await runtime.stop();
  }
});
