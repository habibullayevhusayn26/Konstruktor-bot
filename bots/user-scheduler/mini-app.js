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
  const screenTitle = document.getElementById("screen-title");
  const otpBoxes = [...document.querySelectorAll(".otp-box")];
  const codeInput = document.getElementById("code");
  const resendCodeButton = document.getElementById("resend-code");
  let lastPhoneNumber = "";
  let polling = false;
  let phase = "idle";
  let previousPhase = "";

  if (!telegram || !telegram.initData || !appMatch) {
    statusElement.textContent = "Mini App’ni Telegram ichida oching.";
    return;
  }

  telegram.ready();
  telegram.expand();

  const botId = appMatch[1];
  const pathPrefix = window.location.pathname.replace(/\/user-scheduler\/app\/\d+\/?$/, "");
  const apiBase = `${pathPrefix}/user-scheduler/api/${botId}`;

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

  function syncOtpInput() {
    codeInput.value = otpBoxes.map((box) => box.value).join("");
  }

  otpBoxes.forEach((box, index) => {
    box.addEventListener("input", () => {
      box.value = box.value.replace(/\D/g, "").slice(-1);
      syncOtpInput();
      if (box.value && index < otpBoxes.length - 1) otpBoxes[index + 1].focus();
    });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !box.value && index > 0) {
        otpBoxes[index - 1].focus();
      }
    });
    box.addEventListener("paste", (event) => {
      const digits = event.clipboardData?.getData("text").replace(/\D/g, "") || "";
      if (!digits) return;
      event.preventDefault();
      for (let offset = 0; offset < otpBoxes.length; offset++) {
        otpBoxes[offset].value = digits[offset] || "";
      }
      syncOtpInput();
      otpBoxes[Math.min(digits.length, otpBoxes.length) - 1]?.focus();
    });
  });

  function updateView(state) {
    phase = state.phase || "error";
    statusElement.textContent = state.message || "Ulanish holati yangilanmoqda.";
    setVisibleForm(null);
    cancelButton.hidden = !["connecting", "processing", "code", "password", "email", "email-code"].includes(phase);

    if (phase === "idle" || phase === "error" || phase === "cancelled") {
      screenTitle.textContent = "OTP Verification UI";
      setVisibleForm("phone");
      polling = false;
      return;
    }
    if (phase === "code") {
      screenTitle.textContent = "OTP Verification UI";
      setVisibleForm("code");
      if (previousPhase !== "code") {
        otpBoxes.forEach((box) => { box.value = ""; });
        otpBoxes[0].focus();
      }
    } else if (phase === "password") {
      screenTitle.textContent = "2FA Verification";
      setVisibleForm("password");
      document.getElementById("password-hint").textContent =
        state.passwordHint ? `Telegram parol ishorasi: ${state.passwordHint}` : "";
      document.getElementById("password").focus();
    } else if (phase === "email") {
      screenTitle.textContent = "Email Verification";
      setVisibleForm("email");
      document.getElementById("email").focus();
    } else if (phase === "email-code") {
      screenTitle.textContent = "Email Verification";
      setVisibleForm("emailCode");
      document.getElementById("email-hint").textContent =
        state.emailPattern ? `Kod shu manzilga yuborildi: ${state.emailPattern}` : "Emailingizdagi Telegram kodini kiriting.";
      document.getElementById("email-code").focus();
    } else if (phase === "success") {
      screenTitle.textContent = "Account Connected";
      polling = false;
      cancelButton.hidden = true;
      window.setTimeout(() => telegram.close(), 1800);
    } else if (phase === "connected") {
      polling = false;
      cancelButton.hidden = true;
    }
    previousPhase = phase;
  }

  async function refreshStatus() {
    try {
      const state = await request("status");
      updateView(state);
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
        const state = await request("status");
        updateView(state);
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
    statusElement.textContent = "Telegram login kodi so'ralmoqda...";
    lastPhoneNumber = document.getElementById("phone").value.trim();
    try {
      const state = await request("start", {
        phoneNumber: lastPhoneNumber,
        consent: true,
      });
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
    syncOtpInput();
    const value = codeInput.value.trim();
    if (!/^\d{3,12}$/.test(value)) {
      statusElement.textContent = "Barcha kod raqamlarini kiriting.";
      otpBoxes.find((box) => !box.value)?.focus();
      return;
    }
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

  resendCodeButton.addEventListener("click", async () => {
    if (!lastPhoneNumber) {
      statusElement.textContent = "Avval telefon raqamini kiriting.";
      return;
    }
    resendCodeButton.disabled = true;
    try {
      await request("cancel");
      const state = await request("start", {
        phoneNumber: lastPhoneNumber,
        consent: true,
      });
      updateView(state);
      if (["connecting", "processing", "code", "password", "email", "email-code"].includes(state.phase)) {
        void pollStatus();
      }
    } catch (error) {
      statusElement.textContent = error.message;
    } finally {
      resendCodeButton.disabled = false;
    }
  });

  void refreshStatus();
})();
