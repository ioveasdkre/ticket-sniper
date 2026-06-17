// ============================================================
// momoshop-content.js - Momoshop platform content script
// ============================================================
// Flow:
// 1. Product page: wait for "direct buy" button, click it or reload.
// 2. Cart page: wait for cart content, then click checkout.
// 3. Order form: fill receiver/payment fields, then submit order.
// ============================================================

if (window.__momoshopLoaded) {
    console.log("[tickethelper][momoshop-content] already loaded");
} else {
    window.__momoshopLoaded = true;

    const helper = window.TicketHelperShared;

    const DEFAULT_CONFIG = {
        target_url: "",
        reload_delay: 1,
        order_info_mode: "custom",
        receiver_name: "",
        receiver_phone: "",
        receiver_city: "",
        receiver_post: "",
        receiver_addr: "",
        payment_method: "MPAY_ID",
        mobile_payment_method: "Linepay_ID",
        selected_spec: null,
        auto_submit: true,
    };

    function normalizeConfig(raw = {}) {
        return {
            target_url: String(raw.targetUrl ?? raw.target_url ?? DEFAULT_CONFIG.target_url).trim(),
            reload_delay: Math.max(0.1, Number(raw.reloadDelay ?? raw.reload_delay ?? DEFAULT_CONFIG.reload_delay) || 1),
            order_info_mode: normalizeOrderInfoMode(raw.orderInfoMode ?? raw.order_info_mode ?? DEFAULT_CONFIG.order_info_mode),
            receiver_name: String(raw.receiverName ?? raw.receiver_name ?? DEFAULT_CONFIG.receiver_name).trim(),
            receiver_phone: String(raw.receiverPhone ?? raw.receiver_phone ?? DEFAULT_CONFIG.receiver_phone).replace(/\D/g, ""),
            receiver_city: String(raw.receiverCity ?? raw.receiver_city ?? DEFAULT_CONFIG.receiver_city).trim(),
            receiver_post: String(raw.receiverPost ?? raw.receiver_post ?? DEFAULT_CONFIG.receiver_post).trim(),
            receiver_addr: String(raw.receiverAddr ?? raw.receiver_addr ?? DEFAULT_CONFIG.receiver_addr).trim(),
            payment_method: String(raw.paymentMethod ?? raw.payment_method ?? DEFAULT_CONFIG.payment_method).trim() || "MPAY_ID",
            mobile_payment_method: String(raw.mobilePaymentMethod ?? raw.mobile_payment_method ?? DEFAULT_CONFIG.mobile_payment_method).trim() || "Linepay_ID",
            selected_spec: normalizeSpec(raw.selectedSpec ?? raw.selected_spec ?? DEFAULT_CONFIG.selected_spec),
            auto_submit: raw.autoSubmit ?? raw.auto_submit ?? DEFAULT_CONFIG.auto_submit,
        };
    }

    function normalizeSpec(value) {
        if (!value || typeof value !== "object") return null;
        return {
            index: Number.isInteger(value.index) ? value.index : Number(value.index),
            text: String(value.text ?? "").trim(),
        };
    }

    function normalizeOrderInfoMode(value) {
        return value === "account" ? "account" : "custom";
    }

    const controller = helper.createContentController({
        source: "momoshop-content",
        storageRunningKey: "momoshop_isRunning",
        storageConfigKey: "momoshop_runningConfig",
        defaultConfig: DEFAULT_CONFIG,
        parseConfig: normalizeConfig,
        persistStartConfig: false,
        onStart: async (config, meta) => {
            await runFlow(config, meta.token);
        },
        onResume: async (config, meta) => {
            controller.sendLog("偵測到 Momoshop 進行中設定，自動恢復流程", "info");
            await runFlow(config, meta.token);
        },
    });

    function isStopped() {
        return controller.isStopped();
    }

    function sendLogMomoshop(text, type = "info") {
        controller.sendLog(text, type);
    }

    function sendEventMomoshop(event, extra = {}) {
        controller.sendEvent(event, extra);
    }

    window.addEventListener("__momoshop_alert", (event) => {
        const message = String(event.detail ?? "");
        if (message) {
            sendLogMomoshop(`攔截 alert：${message}`, "warn");
        }
    });

    window.addEventListener("__momoshop_confirm", (event) => {
        const message = String(event.detail ?? "");
        if (message) {
            sendLogMomoshop(`攔截 confirm：${message}`, "warn");
        }
    });

    function assertNotStopped() {
        if (isStopped()) {
            throw new Error("STOPPED");
        }
    }

    async function waitForCondition(check, timeout = 10000, interval = 100) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            assertNotStopped();
            const result = check();
            if (result) return result;
            await helper.delay(interval);
        }
        throw new Error("等待條件逾時");
    }

    async function reloadAfterDelay(config, reason) {
        sendLogMomoshop(`${reason}，${config.reload_delay} 秒後重新整理`, "warn");
        sendEventMomoshop("RELOAD");
        await helper.delay(config.reload_delay * 1000);
        assertNotStopped();
        window.location.reload();
    }

    function hasTextContent(selector) {
        const element = document.querySelector(selector);
        return !!element && String(element.textContent || "").trim().length > 0;
    }

    function detectPageType() {
        const url = window.location.href;

        if (/^https:\/\/cart\.momoshop\.com\.tw\/view\/cart\/WEB\/newNormal/.test(url)) {
            if (document.querySelector("form#orderForm a#orderSave")) return "ORDER_FORM";
            if (document.querySelector("div#parentBlock")) return "CART";
            return "CART_LOADING";
        }

        if (/^https:\/\/www\.momoshop\.com\.tw\/product\//.test(url)) return "PRODUCT";
        if (/order\/complete|thank/i.test(url)) return "DONE";
        return "UNKNOWN";
    }

    function findDirectBuyButton() {
        return Array.from(document.querySelectorAll("button[aria-label='直接購買']"))
            .find(button => String(button.textContent || "").trim().includes("直接購買"));
    }

    function getSpecButtons() {
        const root = document.querySelector('div[data-testid="spec-select"]');
        if (!root) return [];

        return Array.from(root.querySelectorAll("button"))
            .map((button, index) => ({
                button,
                index,
                text: String(button.textContent || button.getAttribute("aria-label") || "").trim().replace(/\s+/g, " "),
                disabled: button.disabled || button.getAttribute("aria-disabled") === "true",
            }))
            .filter(item => item.text);
    }

    function collectSpecOptions() {
        return getSpecButtons().map(({ index, text, disabled, button }) => ({
            index,
            text,
            disabled,
            selected:
                button.getAttribute("aria-pressed") === "true" ||
                button.getAttribute("aria-selected") === "true" ||
                button.classList.contains("selected") ||
                button.classList.contains("active"),
        }));
    }

    async function productStepSelectSpec(config) {
        const specButtons = getSpecButtons();
        if (specButtons.length === 0) return;

        if (!config.selected_spec || !Number.isInteger(config.selected_spec.index)) {
            throw new Error("此商品需要選擇規格，請先在 momo UI 選擇規格");
        }

        const matched = specButtons.find(item =>
            item.index === config.selected_spec.index &&
            (!config.selected_spec.text || item.text === config.selected_spec.text)
        );

        if (!matched) {
            throw new Error(`找不到指定規格：${config.selected_spec.text || config.selected_spec.index}`);
        }

        if (matched.disabled) {
            throw new Error(`指定規格不可購買：${matched.text}`);
        }

        clickElement(matched.button, `規格「${matched.text}」`);
        sendLogMomoshop(`已選擇規格：${matched.text}`, "success");
        await helper.delay(300);
    }

    function clickElement(element, label) {
        if (!element) {
            throw new Error(`找不到${label}`);
        }
        element.scrollIntoView?.({ block: "center", inline: "center" });
        element.click();
    }

    function setInputValue(selector, value, label) {
        const element = document.querySelector(selector);
        if (!element) {
            throw new Error(`找不到${label}`);
        }
        window.typeInput(element, value);
        sendLogMomoshop(`已填入${label}`, "info");
        return element;
    }

    function selectOptionByTextOrValue(selector, target, label) {
        const select = document.querySelector(selector);
        if (!select) {
            throw new Error(`找不到${label}`);
        }

        const option = Array.from(select.options).find(item => {
            const value = String(item.value || "").trim();
            const text = String(item.textContent || "").trim();
            return value === target || text === target || text.includes(target);
        });

        if (!option) {
            throw new Error(`${label}找不到選項：${target}`);
        }

        select.value = option.value;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        sendLogMomoshop(`已選擇${label}：${option.textContent.trim()}`, "info");
        return select;
    }

    async function productStepDirectBuy(config) {
        sendLogMomoshop("目前在 Momoshop 商品頁，檢查直接購買按鈕", "info");
        await productStepSelectSpec(config);

        const button = await waitForCondition(() => findDirectBuyButton(), 1200, 100).catch(() => null);
        if (!button) {
            await reloadAfterDelay(config, "找不到「直接購買」按鈕");
            return false;
        }

        clickElement(button, "直接購買按鈕");
        sendLogMomoshop("已點擊「直接購買」", "success");
        return true;
    }

    async function cartStepCheckout(config) {
        sendLogMomoshop("目前在購物車頁，等待購物車內容", "info");
        await waitForCondition(() => hasTextContent("div#parentBlock"), 15000, 150);

        const checkoutButton = await helper.waitForElement("button#btnDetailCheckout", 10000, document, isStopped);
        clickElement(checkoutButton, "結帳按鈕");
        sendLogMomoshop("已點擊結帳按鈕", "success");

        const orderForm = await waitForCondition(() => document.querySelector("form#orderForm"), 10000, 150)
            .catch(() => null);
        if (orderForm) {
            sendLogMomoshop("同頁偵測到訂單表單，繼續填寫資料", "info");
            await orderStepHandle(config);
        }

        return true;
    }

    async function orderStepHandle(config) {
        if (config.order_info_mode === "account") {
            return orderStepSubmitOnly();
        }
        return orderStepFillAndSubmit(config);
    }

    async function orderStepFillAndSubmit(config) {
        sendLogMomoshop("目前在訂單表單頁，開始填寫收件資料", "info");
        await waitForCondition(() => hasTextContent("form#orderForm"), 15000, 150);

        const receiverLabel = document.querySelector("input#reveiver1[type=radio]")?.closest("label");
        if (receiverLabel) {
            clickElement(receiverLabel, "收件人選項");
            sendLogMomoshop("已選擇收件人資料選項", "info");
        } else {
            sendLogMomoshop("找不到收件人 radio，略過選擇", "warn");
        }

        if (!config.receiver_name) throw new Error("尚未設定收件人姓名");
        if (config.receiver_phone.length !== 10) throw new Error("手機號碼需為 10 碼");
        if (!config.receiver_city) throw new Error("尚未設定縣市");
        if (!config.receiver_post) throw new Error("尚未設定鄉鎮市區");
        if (!config.receiver_addr) throw new Error("尚未設定詳細地址");

        setInputValue("input#receiverName", config.receiver_name, "收件人姓名");
        setInputValue("input#receiverHp1", config.receiver_phone.slice(0, 4), "手機前 4 碼");
        setInputValue("input#receiverHp23", config.receiver_phone.slice(4), "手機後 6 碼");

        selectOptionByTextOrValue("select#receiverCity", config.receiver_city, "縣市");
        await waitForCondition(() => {
            const select = document.querySelector("select#receiverPost");
            if (!select) return null;
            return Array.from(select.options).some(option => {
                const value = String(option.value || "").trim();
                const text = String(option.textContent || "").trim();
                return value === config.receiver_post || text === config.receiver_post || text.includes(config.receiver_post);
            }) ? select : null;
        }, 10000, 150);
        selectOptionByTextOrValue("select#receiverPost", config.receiver_post, "鄉鎮市區");
        setInputValue("input#receiverAddr", config.receiver_addr, "詳細地址");

        const paymentLabel = document.querySelector(`ul#paymentRadioBtn li label[for="${CSS.escape(config.payment_method)}"]`);
        clickElement(paymentLabel, "付款方式");
        sendLogMomoshop(`已選擇付款方式：${config.payment_method}`, "info");

        const mobilePaymentLabel = document.querySelector(`input#${CSS.escape(config.mobile_payment_method)}`)?.closest("label");
        clickElement(mobilePaymentLabel, "行動支付方式");
        sendLogMomoshop(`已選擇行動支付：${config.mobile_payment_method}`, "info");

        if (config.auto_submit) {
            const submitButton = await helper.waitForElement("a#orderSave", 10000, document, isStopped);
            clickElement(submitButton, "確認結帳按鈕");
            sendLogMomoshop("已點擊確認結帳按鈕", "success");
        } else {
            sendLogMomoshop("已填完訂單資料，依設定不自動送出", "success");
        }

        return true;
    }

    async function orderStepSubmitOnly() {
        sendLogMomoshop("使用原始帳號訂購資訊，直接確認結帳", "info");
        await waitForCondition(() => document.querySelector("form#orderForm"), 15000, 150);

        const submitButton = await helper.waitForElement("a#orderSave", 10000, document, isStopped);
        clickElement(submitButton, "確認結帳按鈕");
        sendLogMomoshop("已點擊確認結帳按鈕", "success");
        return true;
    }

    async function runFlow(config, token) {
        try {
            if (token !== controller.state.runToken) return;

            const pageType = detectPageType();
            switch (pageType) {
                case "PRODUCT":
                    await productStepDirectBuy(config);
                    break;

                case "CART":
                    await cartStepCheckout(config);
                    break;

                case "CART_LOADING":
                    sendLogMomoshop("購物車頁尚未載入完成，等待內容出現", "info");
                    await waitForCondition(() => detectPageType() !== "CART_LOADING" && detectPageType(), 15000, 150);
                    await runFlow(config, token);
                    break;

                case "ORDER_FORM":
                    await orderStepHandle(config);
                    break;

                case "DONE":
                    sendLogMomoshop("Momoshop 訂單流程完成", "success");
                    sendEventMomoshop("DONE");
                    break;

                default:
                    if (config.target_url) {
                        sendLogMomoshop("目前不在 Momoshop 流程頁，跳轉至商品網址", "info");
                        window.location.href = config.target_url;
                    } else {
                        sendLogMomoshop(`無法辨識目前頁面：${window.location.href}`, "warn");
                    }
                    break;
            }
        } catch (error) {
            if (error.message === "STOPPED") {
                sendLogMomoshop("流程已停止", "warn");
                return;
            }

            sendLogMomoshop(`流程錯誤：${error.message}`, "error");
            await reloadAfterDelay(config, "流程發生錯誤");
        }
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "GET_SPECS") {
            sendResponse({
                specs: collectSpecOptions(),
                hasSpecSelect: !!document.querySelector('div[data-testid="spec-select"]'),
                url: window.location.href,
                title: document.title,
            });
            return true;
        }

        return controller.handleRuntimeMessage(message, sender, sendResponse);
    });

    function onDomReady() {
        controller.loadGlobalEnabled();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", onDomReady, { once: true });
    } else {
        onDomReady();
    }
}
