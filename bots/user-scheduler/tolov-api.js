"use strict";

const API_URL = "https://tolovapi.uz/api/";

function createTolovApi({
  shopId = "",
  shopKey = "",
  getCredentials,
  isConfigured: isConfiguredOverride,
  fetchImpl = globalThis.fetch,
} = {}) {
  function credentials() {
    const current = getCredentials ? getCredentials() : { shopId, shopKey };
    return {
      shopId: String(current?.shopId || "").trim(),
      shopKey: String(current?.shopKey || "").trim(),
    };
  }

  function isConfigured() {
    if (isConfiguredOverride) return Boolean(isConfiguredOverride());
    const current = credentials();
    return Boolean(current.shopId && current.shopKey);
  }

  async function request(path, params, method = "POST") {
    const current = credentials();
    if (!current.shopId || !current.shopKey) throw new Error("TolovAPI ID yoki kaliti sozlanmagan.");
    if (typeof fetchImpl !== "function") {
      throw new Error("Bu Node.js versiyasida fetch mavjud emas.");
    }

    const body = { shop_id: current.shopId, ...params };
    const headers = { "X-Shop-Key": current.shopKey };
    const response = method === "GET"
      ? await fetchImpl(`${API_URL}${path}?${new URLSearchParams(body)}`, { headers })
      : await fetchImpl(`${API_URL}${path}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
    const result = await response.json();
    if (!response.ok && result?.error_code !== "amount_busy") {
      throw new Error(result?.error || `TolovAPI HTTP ${response.status}`);
    }
    return result;
  }

  return {
    isConfigured,
    createPayment: (orderId, amount) =>
      request("payment/create", { amount, order_id: orderId }),
    paymentStatus: (paymentId) =>
      request("payment/status", { payment_id: paymentId }, "GET"),
    cancelPayment: (paymentId) =>
      request("payment/cancel", { payment_id: paymentId }),
  };
}

module.exports = { createTolovApi };
