"use strict";

(() => {
  const telegram = window.Telegram?.WebApp;
  const appMatch = window.location.pathname.match(/\/user-scheduler\/app\/(\d+)\/?$/);
  const statusElement = document.getElementById("status");
  const forms = {
    phone: document.getElementById("phone-form"),
    code: document.getElementById("code-form"),
    password: document.getElementById("password-form"),
    email: document.getElementById("email-form"),
    emailCode: document.getElementById("email-code-form"),
  };
  const cancelButton = document.getElementById("cancel");
  let polling = false;

  if (!telegram || !telegram.initData || !appMatch) {
    statusElement.textContent = "Mini App’ni Telegram ichida oching.";
    return;
  }

  telegram.ready();
  telegram.expand();

  const botId = appMatch[1];
  const pathPrefix = window.location.pathname.replace(/\/user-scheduler\/app\/\d+\/?$/, "");
  const apiBase = `${pathPrefix}/user-scheduler/api/${botId}`;

  function normalizePhoneNumber(value) {
    let normalized = String(value || "").replace(/[^\d+]/g, "");
    normalized = normalized.replace(/(?!^)\+/g, "");
    if (/^\d{9,15}$/.test(normalized)) normalized = `+${normalized}`;
    return normalized;
  }

  function setVisibleForm(name) {
    for (const [key, form] of Object.entries(forms)) form.hidden = key !== name;
  }

  async function request(action, payload = {}) {
    const response = await fetch(`${apiBase}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "omit",
      body: JSON.stringify({ initData: telegram.initData, ...payload }),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("Serverdan noto'g'ri javob olindi.");
    }
    if (!response.ok) throw new Error(result.error || "So'rov bajarilmadi.");
    return result;
  }

  function updateView(state) {
    statusElement.textContent = state.message || "Ulanish holati yangilanmoqda.";
    setVisibleForm(null);
    cancelButton.hidden = !["connecting", "processing", "code", "password", "email", "email-code"].includes(state.phase);

    if (state.phase === "idle" || state.phase === "error" || state.phase === "cancelled") {
      setVisibleForm("phone");
      polling = false;
      return;
    }
    if (state.phase === "code") {
      setVisibleForm("code");
      document.getElementById("code").focus();
    } else if (state.phase === "password") {
      setVisibleForm("password");
      document.getElementById("password-hint").textContent =
        state.passwordHint ? `Telegram parol ishorasi: ${state.passwordHint}` : "";
      document.getElementById("password").focus();
    } else if (state.phase === "email") {
      setVisibleForm("email");
      document.getElementById("email").focus();
    } else if (state.phase === "email-code") {
      setVisibleForm("emailCode");
      document.getElementById("email-hint").textContent =
        state.emailPattern ? `Kod shu manzilga yuborildi: ${state.emailPattern}` : "Emailingizdagi Telegram kodini kiriting.";
      document.getElementById("email-code").focus();
    } else if (state.phase === "success") {
      polling = false;
      cancelButton.hidden = true;
      window.setTimeout(() => telegram.close(), 1800);
    } else if (state.phase === "connected") {
      polling = false;
      cancelButton.hidden = true;
    }
  }

  async function refreshStatus() {
    try {
      updateView(await request("status"));
    } catch (error) {
      statusElement.textContent = error.message;
      polling = false;
    }
  }

  async function pollStatus() {
    if (polling) return;
    polling = true;
    while (polling) {
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      if (!polling) break;
      try {
        updateView(await request("status"));
      } catch (error) {
        statusElement.textContent = error.message;
        polling = false;
      }
    }
  }

  async function submit(action, value) {
    for (const form of Object.values(forms)) {
      const button = form.querySelector("button[type=submit]");
      if (button) button.disabled = true;
    }
    try {
      const state = await request(action, { value });
      updateView(state);
      if (["connecting", "processing", "code", "password", "email", "email-code"].includes(state.phase)) {
        void pollStatus();
      }
    } catch (error) {
      statusElement.textContent = error.message;
    } finally {
      for (const form of Object.values(forms)) {
        const button = form.querySelector("button[type=submit]");
        if (button) button.disabled = false;
      }
    }
  }

  forms.phone.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!document.getElementById("consent").checked) return;
    const phoneNumber = normalizePhoneNumber(document.getElementById("phone").value);
    document.getElementById("phone").value = phoneNumber;
    statusElement.textContent = "Telegram login kodi so'ralmoqda...";
    try {
      const state = await request("start", { phoneNumber, consent: true });
      updateView(state);
      if (["connecting", "processing", "code", "password", "email", "email-code"].includes(state.phase)) {
        void pollStatus();
      }
    } catch (error) {
      statusElement.textContent = error.message;
    }
  });

  forms.code.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("code");
    const value = input.value.trim();
    input.value = "";
    void submit("code", value);
  });

  forms.password.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("password");
    const value = input.value;
    input.value = "";
    void submit("password", value);
  });

  forms.email.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("email");
    const value = input.value.trim();
    input.value = "";
    void submit("email", value);
  });

  forms.emailCode.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("email-code");
    const value = input.value.trim();
    input.value = "";
    void submit("email-code", value);
  });

  cancelButton.addEventListener("click", async () => {
    polling = false;
    try {
      updateView(await request("cancel"));
    } catch (error) {
      statusElement.textContent = error.message;
    }
  });

  void refreshStatus();
})();
