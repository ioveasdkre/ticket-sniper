// ============================================================
// momoshop-content.js — Momoshop 自動購買腳本
// 執行於 ISOLATED world
//
// 流程：
//   1. 商品頁 → 設定數量 → 勾選同意條款 → 點擊「放入購物車」
//   2. 攔截 alert「加入購物車成功!」→ 導向購物車頁
//   3. 購物車頁 → 點擊結帳按鈕
//   4. 結帳頁 → 填寫收件資訊 → 選擇付款/配送方式 → 送出
//   5. (若有) 驗證碼頁 → OCR 辨識 → 送出
//
// 實際 selector 來自 2026-06-11 playwright-cli 探索結果：
//   商品頁 URL: /goods/GoodsDetail.jsp?i_code=XXXXX
//   購物車 URL: https://cart.momoshop.com.tw/view/cart/WEB/newNormal
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

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "updateGlobalEnabled") {
      globalEnabled = msg.enabled;
      if (!globalEnabled && isRunning) shouldStop = true;
    }
  });

  function isStopped() { return shouldStop; }

  // ---------- 共用工具（透過 shared.js 擴充） ----------
  // shared.js 已提供: delay, sendLog, sendEvent, waitForElement,
  //   typeInput, imageElementToBase64, clickWithRetry
  // 以下為 momoshop 特有的包裝與自訂工具

  const _alertListeners = new Set();
  const _confirmListeners = new Set();

  window.addEventListener("__momoshop_alert", (e) => {
    const msg = e.detail ?? "";
    if (msg) {
      window.sendLog(`⚠️ 攔截 alert：${msg}`, "warn", "momoshop-content");
      _alertListeners.forEach(fn => fn(msg));
      _alertListeners.clear();
    }
  });
  window.addEventListener("__momoshop_confirm", (e) => {
    const msg = e.detail ?? "";
    if (msg) {
      window.sendLog(`⚠️ 攔截 confirm：${msg}`, "warn", "momoshop-content");
      _confirmListeners.forEach(fn => fn(msg));
      _confirmListeners.clear();
    }
  });

  // ---------- 參數 ----------
  let CONFIG = {
    buy_count: 1,
    name: "",
    phone: "",
    address: "",
    reload_delay: 1,
    ocr_api_url: "http://localhost:5511/ocr",
  };

  // ---------- OCR 輔助（透過 background 代理）----------
  async function recognizeCaptcha(imgEl) {
    const base64 = await window.imageElementToBase64(imgEl);
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "OCR_REQUEST", ocrApiUrl: CONFIG.ocr_api_url + "/ocr", image: base64 },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp.success) return reject(new Error(resp.error));
          resolve(resp.data);
        }
      );
    });
    if (!result.success) throw new Error(`OCR 失敗：${result.error}`);
    window.sendLog(`OCR 結果：${result.code}`, "success", "momoshop-content");
    return result.code;
  }

  async function reloadAfterDelay() {
    const ms = Math.max(100, (CONFIG.reload_delay || 1) * 1000);
    window.sendLog(`等待 ${CONFIG.reload_delay || 1}s 後重新整理...`, "warn", "momoshop-content");
    await window.delay(ms);
    window.location.reload();
  }

  // ---------- 頁面偵測 ----------
  function detectPageType() {
    const url = window.location.href;
    if (/\/goods\/GoodsDetail\.jsp/.test(url)) return "PRODUCT";
    if (/cart\.momoshop\.com\.tw/.test(url)) return "CART";
    if (/\/order\//.test(url) || /\/checkout\//.test(url) || /\/ecm\/order\//.test(url)) return "CHECKOUT";
    if (/\/captcha/i.test(url)) return "CAPTCHA";
    if (/\/order\/complete/i.test(url) || /thank/i.test(url)) return "DONE";
    return "UNKNOWN";
  }

  // ================================================================
  //  步驟實作（selector 來自實際網站觀察）
  // ================================================================

  // --- 步驟 1：商品頁 → 加入購物車 ---
  async function productStep_addToCart() {
    // 1a. 設定購買數量
    const qtySel = document.querySelector("select#count");
    if (qtySel) {
      const targetVal = String(CONFIG.buy_count);
      const validOptions = [...qtySel.options].map(o => o.value);
      if (validOptions.includes(targetVal)) {
        qtySel.value = targetVal;
        qtySel.dispatchEvent(new Event("change", { bubbles: true }));
        window.sendLog(`已設定購買數量：${CONFIG.buy_count}`, "info", "momoshop-content");
      } else {
        window.sendLog(`數量選項不含 ${CONFIG.buy_count}，維持預設`, "warn", "momoshop-content");
      }
    }

    // 1b. 勾選同意條款（兩個 checkbox: 贈險與個資）
    const insureCb = document.querySelector("#insureChkBox");
    if (insureCb && !insureCb.checked) {
      insureCb.click();
      window.sendLog("已勾選：獲取贈險及mo幣", "info", "momoshop-content");
    }
    const insureCb2 = document.querySelector("#insureChkBox2");
    if (insureCb2 && !insureCb2.checked) {
      insureCb2.click();
      window.sendLog("已勾選：個資利用同意書", "info", "momoshop-content");
    }

    // 1c. 監聽 alert: 加入購物車成功→導向購物車頁
    _alertListeners.add(async (msg) => {
      if (/成功/.test(msg)) {
        window.sendLog("✅ 加入購物車成功，導向購物車頁", "success", "momoshop-content");
        await window.delay(500);
        // 從 TopCart data 取得購物車 URL，或直接用已知 URL
        try {
          const cartUrl = document.querySelector("#TopCart")
            ?.getAttribute("data-cart-url") ||
            "https://cart.momoshop.com.tw/view/cart/WEB/newNormal";
          const params = "cid=memfu&oid=cart&mdiv=1000100000-bt_0_100_01&ctype=B";
          window.location.href = cartUrl.includes("?") ? cartUrl : cartUrl + "?" + params;
        } catch {
          window.location.href = "https://cart.momoshop.com.tw/view/cart/WEB/newNormal";
        }
      }
    });

    // 1d. 點擊「放入購物車」：有兩個可能的選擇器
    //    - img[alt="放入購物車"] → 在 dd.fastbtn a 中
    //    - 也可點擊其父層 a 標籤
    let cartBtn = document.querySelector("img[alt='放入購物車']");
    if (!cartBtn) {
      // 備用：透過 onclick 找 OrderProcess('cart', ...)
      cartBtn = document.querySelector("a[onclick*=\"OrderProcess('cart'\"]");
    }
    if (!cartBtn) {
      throw new Error("找不到「放入購物車」按鈕，請確認已在商品頁面");
    }
    cartBtn.click();
    window.sendLog("已點擊「放入購物車」", "success", "momoshop-content");
    return true;
  }

  // --- 步驟 2：購物車頁 → 結帳 ---
  async function cartStep_goToCheckout() {
    // 購物車頁面的結帳按鈕，實際 selector 待探索（需登入）
    const selectors = [
      ".checkoutBtn",
      "a[href*='checkout']",
      "a[href*='order']",
      "button.checkout",
      "input[value*='結帳']",
      ".cartChkOut",
    ];
    let btn = null;
    for (const sel of selectors) {
      btn = document.querySelector(sel);
      if (btn) break;
    }
    if (!btn) {
      throw new Error("找不到結帳按鈕，請確認已在購物車頁面");
    }
    btn.click();
    window.sendLog("已點擊結帳按鈕", "success", "momoshop-content");
    return true;
  }

  // --- 步驟 3：結帳頁 → 填寫資訊 ---
  async function checkoutStep_fillInfo() {
    // 填寫收件人姓名
    const nameEl = await window.waitForElement(
      "input[name='name'], input[name*='Name'], input[name*='buyerName'], input[id*='name']",
      10000, document, isStopped
    ).catch(() => null);
    if (nameEl && CONFIG.name) {
      window.typeInput(nameEl, CONFIG.name);
      window.sendLog(`已填入姓名：${CONFIG.name}`, "info", "momoshop-content");
    }

    // 填寫電話
    const phoneEl = document.querySelector(
      "input[name='phone'], input[name*='Phone'], input[name*='tel'], input[name*='mobile']"
    );
    if (phoneEl && CONFIG.phone) {
      window.typeInput(phoneEl, CONFIG.phone);
      window.sendLog(`已填入電話：${CONFIG.phone}`, "info", "momoshop-content");
    }

    // 填寫地址
    const addrEl = document.querySelector(
      "input[name='address'], input[name*='Address'], input[name*='addr']"
    );
    if (addrEl && CONFIG.address) {
      window.typeInput(addrEl, CONFIG.address);
      window.sendLog(`已填入地址：${CONFIG.address}`, "info", "momoshop-content");
    }

    // 購買數量（結帳頁可能也有）
    const qtySel = document.querySelector("select[name='count'], select[name*='qty'], select[name*='amount']");
    if (qtySel) {
      const targetVal = String(CONFIG.buy_count);
      const validOptions = [...qtySel.options].map(o => o.value);
      if (validOptions.includes(targetVal)) {
        qtySel.value = targetVal;
        qtySel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    return true;
  }

  // --- 步驟 4：驗證碼頁 ---
  async function captchaStep_solve() {
    const imgSelectors = [
      "img.captcha",
      "img[class*='captcha']",
      "img[src*='captcha']",
      "img[src*='verify']",
    ];
    let img = null;
    for (const sel of imgSelectors) {
      img = document.querySelector(sel);
      if (img && img.offsetParent !== null) break;
    }
    if (!img) throw new Error("找不到驗證碼圖片");

    const code = await recognizeCaptcha(img);

    const inputSelectors = [
      "input[name='captcha']",
      "input[name*='captcha']",
      "input[name*='verifyCode']",
      "input[class*='captcha']",
    ];
    let input = null;
    for (const sel of inputSelectors) {
      input = document.querySelector(sel);
      if (input) break;
    }
    if (!input) throw new Error("找不到驗證碼輸入框");

    window.typeInput(input, code);

    const submitBtn = document.querySelector("button[type='submit'], input[type='submit']");
    if (!submitBtn) throw new Error("找不到送出按鈕");
    submitBtn.click();
    window.sendLog(`已填入驗證碼並送出：${code}`, "success", "momoshop-content");
    return true;
  }

  // ================================================================
  //  主流程
  // ================================================================
  async function runFlow() {
    isRunning = true;
    shouldStop = false;
    const pageType = detectPageType();

    try {
      if (pageType === "PRODUCT") {
        await productStep_addToCart();
        // alert 攔截器會在攔截到「加入購物車成功!」後自動跳轉購物車頁
      } else if (pageType === "CART") {
        await cartStep_goToCheckout();
      } else if (pageType === "CHECKOUT") {
        await checkoutStep_fillInfo();
        // 嘗試找到結帳頁的送出按鈕
        const submitBtn = document.querySelector(
          "button[type='submit'], input[type='submit'], a[onclick*='submit'], a.submitBtn, a[href*='confirm']"
        );
        if (submitBtn) {
          submitBtn.click();
          window.sendLog("已點擊確認送出", "success", "momoshop-content");
        } else {
          window.sendLog("⚠️ 請手動確認訂單（未找到送出按鈕）", "warn", "momoshop-content");
        }
      } else if (pageType === "CAPTCHA") {
        await captchaStep_solve();
      } else if (pageType === "DONE") {
        window.sendLog("🎉 訂單完成！", "success", "momoshop-content");
        window.sendEvent("DONE", {}, "momoshop-content");
      } else {
        window.sendLog(
          `未識別的頁面類型：${window.location.href}（pageType=${pageType}）`,
          "warn",
          "momoshop-content"
        );
      }
    } catch (e) {
      if (e.message === "使用者已停止") {
        window.sendLog("流程被使用者停止", "warn", "momoshop-content");
      } else {
        window.sendLog(`❌ 錯誤：${e.message}`, "error", "momoshop-content");
        window.sendEvent("RELOAD", {}, "momoshop-content");
        await reloadAfterDelay();
      }
    } finally {
      isRunning = false;
    }
  }

  // ---------- 訊息處理 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "START") {
      if (!globalEnabled) {
        sendResponse({ log: "腳本已關閉", type: "error" });
        return true;
      }
      Object.assign(CONFIG, msg);
      if (!isRunning) {
        runFlow();
        sendResponse({ log: "🚀 Momoshop 流程啟動", type: "success" });
      } else {
        sendResponse({ log: "已在執行中", type: "warn" });
      }
      return true;
    }
    if (msg.action === "STOP") {
      shouldStop = true;
      isRunning = false;
      sendResponse({ log: "已停止", type: "warn" });
      return true;
    }
  });

  // ---------- 初始化 ----------
  function onDomReady() {
    chrome.storage.local.get(["momoshop_isRunning", "momoshop_runningConfig"], (res) => {
      if (res.momoshop_isRunning && res.momoshop_runningConfig) {
        Object.assign(CONFIG, res.momoshop_runningConfig);
        runFlow();
      }
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onDomReady);
  } else {
    onDomReady();
  }
}