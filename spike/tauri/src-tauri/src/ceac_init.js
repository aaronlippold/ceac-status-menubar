// Injected into the CEAC status page by the spike. Runs on every page load in
// the CEAC window (Cloudflare check page, form page, postback reloads).
// It fills the case fields out of sight, shows only the site's own CAPTCHA,
// code field and submit button, and sends the result panel to the app.
// It never reads, solves or submits the CAPTCHA; the human presses Check.
(function () {
  if (window.top !== window) return;

  var CASE = __CEAC_CASE_JSON__;
  var IDS = {
    type: "Visa_Application_Type",
    caseNumber: "Visa_Case_Number",
    passport: "Passport_Number",
    surname: "Surname",
    captchaInput: "Captcha",
    captchaImage: "c_status_ctl00_contentplaceholder1_defaultcaptcha_CaptchaImage",
    submit: "ctl00_ContentPlaceHolder1_btnSubmit"
  };
  var RESULT_IDS = {
    status: "ctl00_ContentPlaceHolder1_ucApplicationStatusView_lblStatus",
    caseCreated: "ctl00_ContentPlaceHolder1_ucApplicationStatusView_lblSubmitDate",
    lastUpdated: "ctl00_ContentPlaceHolder1_ucApplicationStatusView_lblStatusDate",
    message: "ctl00_ContentPlaceHolder1_ucApplicationStatusView_lblMessage"
  };
  var reported = {};
  var showFullPage = false;
  var resultSent = false;

  function invoke(cmd, args) {
    var ipc = window.__TAURI_INTERNALS__;
    if (!ipc || typeof ipc.invoke !== "function") {
      console.warn("[ceac-spike] Tauri IPC not available on this page");
      return;
    }
    ipc.invoke(cmd, args).catch(function (e) {
      console.warn("[ceac-spike] " + cmd + " failed", e);
    });
  }

  function report(stage, detail) {
    invoke("spike_report", { stage: stage, detail: detail || {} });
  }

  function reportOnce(stage, detail) {
    if (reported[stage]) return;
    reported[stage] = true;
    report(stage, detail);
  }

  function text(id) {
    var el = document.getElementById(id);
    return el ? (el.textContent || "").trim() : "";
  }

  function installStyle() {
    if (document.getElementById("ceac-spike-style")) return;
    var style = document.createElement("style");
    style.id = "ceac-spike-style";
    style.textContent = [
      "html.ceac-captcha-only body { visibility: hidden !important; overflow: hidden !important; }",
      "html.ceac-captcha-only [data-ceac-show], html.ceac-captcha-only [data-ceac-show] * { visibility: visible !important; }",
      "html.ceac-captcha-only [data-ceac-show] { position: fixed !important; margin: 0 !important; }",
      "html.ceac-captcha-only [data-ceac-show='input'] { width: 260px !important; font-size: 18px !important; padding: 6px !important; }",
      "html.ceac-captcha-only [data-ceac-show='error'] { right: 16px !important; color: #b00020 !important; }",
      "html.ceac-captcha-only [data-ceac-show='reload'], html.ceac-captcha-only [data-ceac-show='sound'] { display: inline-block !important; }",
      "#ceac-spike-header { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647; visibility: visible !important;",
      "  display: flex; justify-content: space-between; align-items: center; padding: 8px 16px;",
      "  font: 13px -apple-system, system-ui, sans-serif; background: #f3f4f6; color: #111; border-bottom: 1px solid #d1d5db; }",
      "html:not(.ceac-captcha-only) #ceac-spike-header { display: none; }",
      "#ceac-spike-fullpage { position: fixed; right: 12px; bottom: 10px; z-index: 2147483647; visibility: visible !important;",
      "  font: 12px -apple-system, system-ui, sans-serif; color: #2563eb; background: none; border: none; padding: 2px 4px; cursor: pointer; text-decoration: underline; }"
    ].join("\n");
    document.head.appendChild(style);
  }

  function installHeader() {
    if (document.getElementById("ceac-spike-header")) return;
    var header = document.createElement("div");
    header.id = "ceac-spike-header";
    header.textContent = CASE.synthetic ? "Fake values: do not submit" : "Type the code, press Submit";
    document.body.appendChild(header);

    var toggle = document.createElement("button");
    toggle.id = "ceac-spike-fullpage";
    toggle.type = "button";
    toggle.textContent = "Show full page";
    toggle.addEventListener("click", function () {
      showFullPage = !showFullPage;
      toggle.textContent = showFullPage ? "CAPTCHA only" : "Show full page";
      document.documentElement.classList.toggle("ceac-captcha-only", !showFullPage);
    });
    document.body.appendChild(toggle);
  }

  function mark(el, role) {
    if (el && el.getAttribute("data-ceac-show") !== role) el.setAttribute("data-ceac-show", role);
  }

  function place(el, top, left) {
    if (!el) return;
    el.style.setProperty("top", top + "px", "important");
    el.style.setProperty("left", left + "px", "important");
  }

  // Lays the visible pieces out in a column under the header, measured from
  // the real rendered sizes so nothing overlaps when text wraps.
  function layout(parts) {
    var header = document.getElementById("ceac-spike-header");
    var y = (header ? header.offsetHeight : 40) + 12;
    var imageBox = parts.captcha.getBoundingClientRect();
    place(parts.captcha, y, 16);
    var iconX = 16 + Math.ceil(imageBox.width) + 10;
    place(parts.reload, y, iconX);
    place(parts.sound, y + 28, iconX);
    y += Math.ceil(imageBox.height) + 14;
    place(parts.input, y, 16);
    y += Math.ceil(parts.input.getBoundingClientRect().height) + 12;
    place(parts.submit, y, 16);
    y += Math.ceil(parts.submit.getBoundingClientRect().height) + 12;
    parts.errors.forEach(function (el) {
      place(el, y, 16);
      y += Math.ceil(el.getBoundingClientRect().height) + 6;
    });
  }

  function ensureValue(id, value) {
    var el = document.getElementById(id);
    if (!el) return false;
    if (el.value !== value) {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }

  function sendResult() {
    if (resultSent || !text(RESULT_IDS.status)) return false;
    resultSent = true;
    invoke("case_result", {
      result: {
        status: text(RESULT_IDS.status),
        caseCreated: text(RESULT_IDS.caseCreated),
        lastUpdated: text(RESULT_IDS.lastUpdated),
        message: text(RESULT_IDS.message)
      }
    });
    return true;
  }

  function tick() {
    if (/just a moment/i.test(document.title)) {
      reportOnce("cloudflare_challenge", { webdriver: navigator.webdriver === true });
      return;
    }
    if (sendResult()) return;

    var type = document.getElementById(IDS.type);
    if (!type) {
      reportOnce("page_without_form", { title: document.title });
      return;
    }
    reportOnce("form_page_loaded", { webdriver: navigator.webdriver === true });

    if (type.value !== "IV") {
      if (!reported.switching_to_iv) {
        reportOnce("switching_to_iv", { from: type.value });
        type.value = "IV";
        type.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    var filled = ensureValue(IDS.caseNumber, CASE.caseNumber) &&
      ensureValue(IDS.passport, CASE.passport) &&
      ensureValue(IDS.surname, CASE.surname);
    var captchaInput = document.getElementById(IDS.captchaInput);
    var captchaImage = document.getElementById(IDS.captchaImage);
    var submit = document.getElementById(IDS.submit);
    if (!filled || !captchaInput || !captchaImage || !submit) {
      reportOnce("form_fields_missing", {
        filled: filled, captchaInput: !!captchaInput, captchaImage: !!captchaImage, submit: !!submit
      });
      return;
    }

    installStyle();
    installHeader();
    var reload = document.getElementById("c_status_ctl00_contentplaceholder1_defaultcaptcha_ReloadLink");
    var sound = document.getElementById("c_status_ctl00_contentplaceholder1_defaultcaptcha_SoundLink");
    mark(captchaImage, "captcha");
    mark(reload, "reload");
    mark(sound, "sound");
    mark(captchaInput, "input");
    mark(submit, "submit");
    var errors = [];
    Array.prototype.forEach.call(
      document.querySelectorAll("[id*='lblError'], [id*='ValidationSummary'], [id^='ctl00_ContentPlaceHolder1_vld']"),
      function (el) {
        var message = (el.textContent || "").trim();
        if (!message || el.offsetParent === null) return;
        mark(el, "error");
        errors.push(el);
        reportOnce("error_shown:" + el.id + ":" + message, { id: el.id, message: message });
      }
    );
    if (!showFullPage) {
      document.documentElement.classList.add("ceac-captcha-only");
      layout({ captcha: captchaImage, reload: reload, sound: sound, input: captchaInput, submit: submit, errors: errors });
    }

    if (captchaInput.getAttribute("data-ceac-focused") !== "1") {
      captchaInput.setAttribute("data-ceac-focused", "1");
      captchaInput.focus();
      report("captcha_ready", {
        synthetic: CASE.synthetic,
        reloadLink: !!reload,
        soundLink: !!sound,
        captchaFocused: document.activeElement === captchaInput
      });
    }
  }

  function start() {
    tick();
    setInterval(tick, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
