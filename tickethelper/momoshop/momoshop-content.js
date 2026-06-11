// ============================================================
// momoshop-content.js — Momoshop 自動購買腳本 (整合版)
// 執行於 ISOLATED world，核心流程與 tixcraft 近似，
// 依序：偵測頁面類型 → 加入購物車 → 前往結帳 → (若有) 驗證碼 OCR → 完成訂單
// ============================================================

if (window.__momoshopLoaded) {
  console.log("[搶票助手][Momoshop] content already injected, skip");
} else {
  window.__momoshopLoaded = true;

  // ---------- 全域狀態 ----------
  let isRunning = false;
  let shouldStop = false;
  let globalEnabled = true;

  chrome.storage.local.get(["globalEnabled"], (res) => {
    globalEnabled = res.globalEnabled !== false;
    if (!globalEnabled) console.log("[Momoshop] 全域關閉，腳本不執行");
  });

  // ---------- 工具函式 ----------
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  const _alertListeners = new Set();
  const _confirmListeners = new Set();
  const originalAlert = window.alert;
  const originalConfirm = window.confirm;

  window.addEventListener("__momoshop_alert", e => {
    const msg = e.detail ?? "";
    if (msg) {
      sendLog(`⚠️ 攔截 alert：${msg}`, "warn");
      _alertListeners.forEach(fn => fn(msg));
      _alertListeners.clear();
      window.alert = originalAlert;
    }
  });
  window.addEventListener("__momoshop_confirm", e => {
    const msg = e.detail ?? "";
    if (msg) {
      sendLog(`⚠️ 攔截 confirm：${msg}`, "warn");
      _confirmListeners.forEach(fn => fn(msg));
      _confirmListeners.clear();
      window.confirm = originalConfirm;
    }
  });

  function sendLog(text, type = "info") {
    console.log(`[搶票助手][Momoshop] ${text}`);
    chrome.runtime.sendMessage({ from: "momoshop-content", event: "LOG", text, type });
  }
  function sendEvent(event, extra = {}) {
    chrome.runtime.sendMessage({ from: "momoshop-content", event, ...extra });
  }

  async function waitForElement(selector, timeout = 12000, ctx = document) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (shouldStop) throw new Error("使用者已停止");
      const el = ctx.querySelector(selector);
      if (el) return el;
    }
    throw new Error(`等待元素逾時：${selector}`);
  }

  async function imageElementToBase64(img) {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      try { resolve(canvas.toDataURL("image/png")); }
      catch (e) { reject(e); }
    });
  }

  async function recognizeCaptcha(imgEl) {
    const base64 = await imageElementToBase64(imgEl);
    const resp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: "OCR_REQUEST", ocrApiUrl: CONFIG.ocr_api_url, image: base64 }, r => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!r.success) return reject(new Error(r.error));
        resolve(r.data);
      });
    });
    if (!resp.success) throw new Error(`OCR 失敗：${resp.error}`);
    sendLog(`OCR 結果：${resp.code}`, "success");
    return resp.code;
  }

  function typeInput(el, txt) {
    if (!el) return;
    el.focus();
    el.value = txt;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function reloadAfterDelay() {
    const ms = Math.max(100, (CONFIG.reload_delay || 1) * 1000);
    sendLog(`等待 ${CONFIG.reload_delay || 1}s 後重新整理...`, "warn");
    await delay(ms);
    window.location.reload();
  }

  // ---------- 參數 ----------
  let CONFIG = {
    buy_count: 1,
    ocr_api_url: "http://localhost:5511/ocr",
    reload_delay: 1,
    // 依需求自行擴充，如收件地址、付款資訊等
  };

  // ---------- 頁面偵測 ----------
  function detectPageType() {
    const url = window.location.href;
    if (/\/product\//.test(url)) return "PRODUCT";
    if (/\/cart/.test(url)) return "CART";
    if (/\/checkout/.test(url)) return "CHECKOUT";
    if (/captcha/.test(url)) return "CAPTCHA";
    if (/order/.test(url) || /thank/.test(url)) return "DONE";
    return "UNKNOWN";
  }

  // ---------- 步驟實作 ----------
  async function productStep_addToCart() {
    const btn = await waitForElement("button[data-action='add-to-cart']", 15000);
    btn.click();
    sendLog("已點擊加入購物車", "success");
    return true;
  }

  async function cartStep_goToCheckout() {
    const btn = await waitForElement("a[href*='checkout']", 15000);
    btn.click();
    sendLog("前往結帳頁面", "info");
    return true;
  }

  async function checkoutStep_fillInfo() {
    // 假設表單欄位名稱為 name, phone, address 等，根據 CONFIG 填寫
    const nameEl = await waitForElement("input[name='name']", 8000).catch(() => null);
    if (nameEl && CONFIG.name) typeInput(nameEl, CONFIG.name);
    const phoneEl = await waitForElement("input[name='phone']", 8000).catch(() => null);
    if (phoneEl && CONFIG.phone) typeInput(phoneEl, CONFIG.phone);
    const addrEl = await waitForElement("input[name='address']", 8000).catch(() => null);
    if (addrEl && CONFIG.address) typeInput(addrEl, CONFIG.address);
    // 訂購數量
    const qtySel = document.querySelector("select[name='quantity']");
    if (qtySel) { qtySel.value = CONFIG.buy_count; qtySel.dispatchEvent(new Event('change', { bubbles: true })); }
    sendLog("填寫結帳資訊", "info");
    return true;
  }

  async function captchaStep_solve() {
    const img = await waitForElement("img.captcha", 12000);
    const code = await recognizeCaptcha(img);
    const input = await waitForElement("input[name='captcha']", 8000);
    typeInput(input, code);
    const submit = await waitForElement("button[type='submit']", 8000);
    submit.click();
    sendLog("送出驗證碼", "info");
    return true;
  }

  // ---------- 主流程 ----------
  async function runFlow() {
    isRunning = true; shouldStop = false;
    const type = detectPageType();
    try {
      if (type === "PRODUCT") {
        await productStep_addToCart();
        // 可能自動導向購物車，若未導向則自行前往
        if (!/\/cart/.test(window.location.href)) {
          await delay(500);
          window.location.href = "https://www.momoshop.com.tw/cart";
        }
      } else if (type === "CART") {
        await cartStep_goToCheckout();
      } else if (type === "CHECKOUT") {
        await checkoutStep_fillInfo();
        // 若有 captcha 步驟則由頁面自行跳轉或在此呼叫 captchaStep_solve
        if (/captcha/.test(window.location.href)) {
          await captchaStep_solve();
        } else {
          const submit = await waitForElement("button[type='submit']", 8000);
          submit.click();
        }
      } else if (type === "CAPTCHA") {
        await captchaStep_solve();
      } else if (type === "DONE") {
        sendLog("🎉 訂單完成！", "success");
        sendEvent("DONE");
      } else {
        sendLog(`未識別的頁面類型：${window.location.href}`, "warn");
      }
    } catch (e) {
      if (e.message === "使用者已停止") {
        sendLog("流程被使用者停止", "warn");
      } else {
        sendLog(`❌ 錯誤：${e.message}`, "error");
        await reloadAfterDelay();
      }
    } finally { isRunning = false; }
  }

  // ---------- 訊息處理 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "START") {
      if (!globalEnabled) { sendResponse({ log: "腳本已關閉", type: "error" }); return true; }
      // 載入使用者設定，允許任意欄位 (name, phone, address, etc.)
      Object.assign(CONFIG, msg);
      if (!isRunning) { runFlow(); sendResponse({ log: "流程啟動", type: "success" }); }
      else { sendResponse({ log: "已在執行中", type: "warn" }); }
      return true;
    }
    if (msg.action === "STOP") { shouldStop = true; isRunning = false; sendResponse({ log: "已停止", type: "warn" }); return true; }
  });

  // ---------- 初始化 ----------
  function onDomReady() {
    // 若上一次仍在執行狀態，從 storage 恢復
    chrome.storage.local.get(["momoshop_isRunning", "momoshop_runningConfig"], (res) => {
      if (res.momoshop_isRunning && res.momoshop_runningConfig) {
        Object.assign(CONFIG, res.momoshop_runningConfig);
        runFlow();
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onDomReady);
  else onDomReady();
}
