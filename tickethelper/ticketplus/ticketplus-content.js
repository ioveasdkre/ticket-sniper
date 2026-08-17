// ============================================================
// ticketplus-content.js — TicketPlus（ticketplus.com.tw）平台內容腳本
// ============================================================
// 本檔案是 E:\project\ticketsystem\chrome_tixcraft.py 中 ticketplus 段
// （L9889-11293，dispatcher 在 L11565）的 JavaScript 移植版本。
//
// 移植原則：選擇器、判斷條件、執行順序、延遲時間一律比照 Python 原始碼，
// 每個函式上方標註對應的 Python 函式與行號，方便日後比對。
//
// 架構面沿用 tixcraft 模組（createContentController + alert override +
// background 重注入 + popup 面板）。
//
// 與 Python 的差異（已與使用者確認）：
// 1. 不移植 OCR 驗證碼（ticketplus_order_ocr / ticketplus_auto_ocr 在
//    Python 中是未被呼叫的死碼，ticketplus_main 全程不跑 OCR）。
// 2. 不移植自動登入（ticketplus_account_auto_fill / _sign_in）。
// 3. play_sound_while_ordering 改為 DONE 事件 + Discord 通知。
// 4. 訂單頁找不到可購票區時，改為點擊頁面上的「更新票數」按鈕（Vue 會直接
//    更新票區資料），不再整頁 location.reload()；找不到該按鈕時才退回重整。
//
// 流程（對應 ticketplus_main）：
//   /activity/XXX      → 關閉實名制/其他活動對話框 → 自動選場次
//   /order/XXX/OOO     → 關閉實名制/購票失敗對話框 → 未開賣輪詢重整 → 選區域/張數/密碼/送出
//   /confirm/XX/OO     → 自動勾選同意條款
// ============================================================

if (window.__ticketplusLoaded) {
    console.log("[tickethelper][ticketplus-content] already loaded");
} else {
    window.__ticketplusLoaded = true;

    const helper = window.TicketHelperShared;

    // ============================================================
    // 常數（對應 chrome_tixcraft.py L103-106）
    // ============================================================
    const CONST_FROM_TOP_TO_BOTTOM = "from top to bottom";
    const CONST_FROM_BOTTOM_TO_TOP = "from bottom to top";
    const CONST_CENTER = "center";
    const CONST_RANDOM = "random";

    // ticketplus 訂單頁的兩種版型，送出鈕選擇器（py L10583 / L10598）
    const NEXT_BTN_STYLE_2 = "div.order-footer > div.container > div.row > div > button.nextBtn";
    const NEXT_BTN_STYLE_1 = "div.order-footer > div.container > div.row > div > div.row > div > button.nextBtn";

    // 未開賣輪詢用的 API 網址關鍵字（py L9920 / L10526）
    const API_URL_KEYWORD = "apis.ticketplus.com.tw/config/api/";

    // 更新票數，按鈕選擇器
    const TICKET_NUMBER_PLUS_SELECTOR = "main.v-main > div.v-main__wrap > div > button";

    // 預設設定（內部一律 snake_case，對應 Python 的 config_dict）
    const DEFAULT_CONFIG = {
        buy_count: 2,                       // config_dict["ticket_number"]
        date_auto_select_enable: true,      // date_auto_select.enable
        choose_date: [],                    // date_auto_select.date_keyword
        date_mode: CONST_RANDOM,            // date_auto_select.mode
        choose_area: [],                    // area_auto_select.area_keyword
        area_mode: CONST_RANDOM,            // area_auto_select.mode
        exclude_area: [],                   // keyword_exclude
        pass_date_is_sold_out: true,        // tixcraft.pass_date_is_sold_out
        auto_reload_coming_soon: true,      // tixcraft.auto_reload_coming_soon_page
        reload_delay: 0.1,                  // advanced.auto_reload_page_interval
        user_guess_string: [],              // advanced.user_guess_string
        auto_guess_options: true,           // advanced.auto_guess_options
        date_fallback: "refresh",           // 擴充功能專屬：找不到場次時的策略
        area_fallback: "refresh",           // 擴充功能專屬：找不到區域時的策略
        target_url: "",                     // 首頁導向用
        sale_start_at: 0,                   // 擴充功能專屬：排程啟動的絕對時間（毫秒），0 代表立即執行
    };

    /**
     * 正規化使用者輸入的設定
     * 同時接受 popup / background 傳來的 camelCase 與內部的 snake_case
     */
    function normalizeConfig(raw = {}) {
        const bool = (value, fallback) => (value === undefined || value === null ? fallback : value !== false);
        const mode = value => {
            const list = [CONST_FROM_TOP_TO_BOTTOM, CONST_FROM_BOTTOM_TO_TOP, CONST_CENTER, CONST_RANDOM];
            return list.includes(value) ? value : CONST_RANDOM;
        };

        return {
            buy_count: Math.max(1, Number(raw.buyCount ?? raw.buy_count ?? 2) || 2),
            date_auto_select_enable: bool(raw.dateAutoSelect ?? raw.date_auto_select_enable, true),
            choose_date: helper.normalizeKeywordList(raw.chooseDate ?? raw.choose_date ?? []),
            date_mode: mode(raw.dateMode ?? raw.date_mode),
            choose_area: helper.normalizeKeywordList(raw.chooseArea ?? raw.choose_area ?? []),
            area_mode: mode(raw.areaMode ?? raw.area_mode),
            exclude_area: helper.normalizeKeywordList(raw.excludeArea ?? raw.exclude_area ?? []),
            pass_date_is_sold_out: bool(raw.passDateIsSoldOut ?? raw.pass_date_is_sold_out, true),
            auto_reload_coming_soon: bool(raw.autoReloadComingSoon ?? raw.auto_reload_coming_soon, true),
            reload_delay: Math.max(0, Number(raw.reloadDelay ?? raw.reload_delay ?? 0.1) || 0),
            user_guess_string: helper.normalizeKeywordList(raw.userGuessString ?? raw.user_guess_string ?? []),
            auto_guess_options: bool(raw.autoGuessOptions ?? raw.auto_guess_options, true),
            date_fallback: raw.dateFallback ?? raw.date_fallback ?? "refresh",
            area_fallback: raw.areaFallback ?? raw.area_fallback ?? "refresh",
            target_url: String(raw.targetUrl ?? raw.target_url ?? "").trim(),
            sale_start_at: Math.max(0, Number(raw.scheduledStartAt ?? raw.sale_start_at ?? 0) || 0),
        };
    }

    // 建立流程控制器（與 tixcraft 模組相同的機制）
    const controller = helper.createContentController({
        source: "ticketplus-content",
        storageRunningKey: "ticketplus_isRunning",
        storageConfigKey: "ticketplus_runningConfig",
        defaultConfig: DEFAULT_CONFIG,
        parseConfig: normalizeConfig,
        onStart: async (config, meta) => {
            await runMainLoop(config, meta.token);
        },
        onResume: async (config, meta) => {
            controller.sendLog("偵測到 TicketPlus 進行中設定，自動恢復流程", "info");
            await runMainLoop(config, meta.token);
        },
    });

    function isStopped() {
        return controller.isStopped();
    }

    // 主迴圈每 50ms 跑一次，相同訊息連續輸出會洗版，因此做去重
    let lastLogText = "";
    function sendLogTicketplus(text, type = "info") {
        if (text === lastLogText) return;
        lastLogText = text;
        controller.sendLog(text, type);
    }

    function sendEventTicketplus(event, extra = {}) {
        controller.sendEvent(event, extra);
    }

    // ============================================================
    // alert / confirm 攔截與恢復（對應 ticketplus-alert-override.js）
    // ============================================================
    const originalAlert = window.alert;
    const originalConfirm = window.confirm;

    window.addEventListener("__ticketplus_alert", event => {
        const message = event.detail ?? "";
        if (!message) return;
        sendLogTicketplus(`攔截 alert：${message}`, "warn");
        window.alert = originalAlert;
    });

    window.addEventListener("__ticketplus_confirm", event => {
        const message = event.detail ?? "";
        if (!message) return;
        sendLogTicketplus(`攔截 confirm：${message}`, "warn");
        window.confirm = originalConfirm;
    });

    // ============================================================
    // 共用工具（自 util.py / chrome_tixcraft.py 移植）
    // ============================================================

    /**
     * util.py:70 remove_html_tags
     * Python 的 '<.*?>' 中的 . 不匹配換行，因此這裡用 [^\n] 保持一致行為
     */
    function removeHtmlTags(text) {
        if (text === null || text === undefined) return "";
        return String(text).replace(/<[^\n]*?>/g, "").trim();
    }

    /**
     * util.py:296 format_keyword_string
     * 比對前的正規化：全形斜線轉半形、去掉全形空白/逗號/半形逗號/$/半形空白，最後轉小寫
     */
    function formatKeywordString(keyword) {
        if (keyword === null || keyword === undefined) return keyword;
        let result = String(keyword);
        if (result.length === 0) return result;
        result = result.split("／").join("/");
        result = result.split("　").join("");
        result = result.split(",").join("");
        result = result.split("，").join("");
        result = result.split("$").join("");
        result = result.split(" ").join("").toLowerCase();
        return result;
    }

    /**
     * util.py:1308 is_row_match_keyword
     * 任一關鍵字項命中即為 true；項目內含半形空白時，所有 token 都要命中（AND）
     *
     * [與 Python 的差異] Python 用 len(keyword_string) > 0 當守門條件，
     * 關鍵字字串為空時會回傳 True（等同「全部排除」）。本擴充功能改用
     * 陣列長度判斷，關鍵字清空時代表「不排除任何項目」。
     */
    function isRowMatchKeyword(keywordList, rowText) {
        const normalizedRow = formatKeywordString(rowText);

        let isMatchKeyword = false;
        if (keywordList.length > 0 && normalizedRow.length > 0) {
            for (const itemList of keywordList) {
                if (itemList.length > 0) {
                    if (itemList.includes(" ")) {
                        const keywordItemArray = itemList.split(" ");
                        let isMatchAll = true;
                        for (const eachItem of keywordItemArray) {
                            if (!normalizedRow.includes(formatKeywordString(eachItem))) {
                                isMatchAll = false;
                            }
                        }
                        if (isMatchAll) isMatchKeyword = true;
                    } else if (normalizedRow.includes(formatKeywordString(itemList))) {
                        isMatchKeyword = true;
                    }
                } else {
                    // 空項目代表匹配全部
                    isMatchKeyword = true;
                }
                if (isMatchKeyword) break;
            }
        }
        return isMatchKeyword;
    }

    /** util.py:1342 reset_row_text_if_match_keyword_exclude */
    function resetRowTextIfMatchKeywordExclude(config, rowText) {
        return isRowMatchKeyword(config.exclude_area, rowText);
    }

    /** util.py:1216 get_matched_blocks_by_keyword_item_set */
    function getMatchedBlocksByKeywordItemSet(config, autoSelectMode, keywordItemSet, formatedAreaList) {
        const matchedBlocks = [];
        for (const row of formatedAreaList) {
            let rowText = "";
            try {
                rowText = removeHtmlTags(row.innerHTML);
            } catch (_) {
                break;
            }

            if (rowText.length > 0 && resetRowTextIfMatchKeywordExclude(config, rowText)) {
                rowText = "";
            }

            if (rowText.length > 0) {
                rowText = formatKeywordString(rowText);

                let isMatchAll = false;
                if (keywordItemSet.includes(" ")) {
                    const keywordItemArray = keywordItemSet.split(" ");
                    isMatchAll = true;
                    for (const keywordItem of keywordItemArray) {
                        if (!rowText.includes(formatKeywordString(keywordItem))) {
                            isMatchAll = false;
                        }
                    }
                } else if (rowText.includes(formatKeywordString(keywordItemSet))) {
                    isMatchAll = true;
                }

                if (isMatchAll) {
                    matchedBlocks.push(row);
                    // 由上而下模式只需要第一筆
                    if (autoSelectMode === CONST_FROM_TOP_TO_BOTTOM) break;
                }
            }
        }
        return matchedBlocks;
    }

    /**
     * util.py:1293 get_matched_blocks_by_keyword
     * 依序試每個關鍵字項，第一個有命中的就回傳
     */
    function getMatchedBlocksByKeyword(config, autoSelectMode, keywordList, formatedAreaList) {
        let matchedBlocks = [];
        for (const keywordItemSet of keywordList) {
            matchedBlocks = getMatchedBlocksByKeywordItemSet(config, autoSelectMode, keywordItemSet, formatedAreaList);
            if (matchedBlocks.length > 0) break;
        }
        return matchedBlocks;
    }

    /** util.py:1268 get_target_item_from_matched_list */
    function getTargetItemFromMatchedList(matchedBlocks, autoSelectMode) {
        if (matchedBlocks === null || matchedBlocks === undefined) return null;

        const count = matchedBlocks.length;
        if (count === 0) return null;

        let targetRowIndex = 0;
        if (autoSelectMode === CONST_FROM_BOTTOM_TO_TOP) {
            targetRowIndex = count - 1;
        }
        if (autoSelectMode === CONST_RANDOM) {
            if (count > 1) targetRowIndex = Math.floor(Math.random() * count);
        }
        if (autoSelectMode === CONST_CENTER) {
            if (count > 2) targetRowIndex = Math.floor(count / 2);
        }
        return matchedBlocks[targetRowIndex];
    }

    /** chrome_tixcraft.py:974 press_button */
    function pressButton(selector, context = document) {
        try {
            const button = context.querySelector(selector);
            if (button && !button.disabled) {
                button.click();
                return true;
            }
        } catch (_) {
            // 與 Python 相同：忽略例外
        }
        return false;
    }

    /** chrome_tixcraft.py:2927 force_check_checkbox */
    function forceCheckCheckbox(checkbox) {
        if (!checkbox) return false;
        if (checkbox.disabled) return false;
        if (checkbox.checked) return true;

        try {
            checkbox.click();
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * util.py:1347 guess_tixcraft_question
     * 僅移植前兩條規則；第三條 get_answer_list_from_question_string
     * （大型題目啟發式解析器）未移植，會回傳空陣列。
     */
    function guessTicketplusQuestion(questionText) {
        if (!questionText) return [];

        // util.py:307 format_quota_string：各種括號統一成【】
        let text = questionText;
        for (const ch of ["「", "『", "〔", "﹝", "〈", "《", "［", "〖", "[", "（", "("]) {
            text = text.split(ch).join("【");
        }
        for (const ch of ["」", "』", "〕", "﹞", "〉", "》", "］", "〗", "]", "）", ")"]) {
            text = text.split(ch).join("】");
        }

        // 請輸入"YES"，代表您已詳閱且瞭解並同意。
        if (text.includes('輸入"YES"')) {
            if (text.includes("已詳閱") || text.includes("請詳閱")) {
                if (text.includes("同意")) return ["YES"];
            }
        }

        // 購票前請詳閱注意事項，並於驗證碼欄位輸入【同意】繼續購票流程。
        if (text.includes("驗證碼") || text.includes("驗證欄位")) {
            if (text.includes("已詳閱") || text.includes("請詳閱")) {
                if (text.includes("輸入【同意】")) return ["同意"];
            }
        }

        return [];
    }

    /** chrome_tixcraft.py:1812 get_text_by_selector（attribute='innerText' 分支） */
    function getTextBySelector(selector) {
        const element = document.querySelector(selector);
        if (!element) return "";
        try {
            return removeHtmlTags(element.innerHTML);
        } catch (_) {
            return "";
        }
    }

    /** 送出 Enter 鍵（對應 Selenium 的 send_keys(Keys.ENTER)） */
    function sendEnterKey(element) {
        for (const type of ["keydown", "keypress", "keyup"]) {
            element.dispatchEvent(new KeyboardEvent(type, {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
            }));
        }
    }

    /**
     * 重新整理頁面
     * Python 是 driver.refresh() 之後再 sleep(0.3) + auto_reload_page_interval，
     * 瀏覽器端 reload 會直接終止腳本，因此改為先等待相同的時間再 reload，
     * 兩者的「每次重整之間的冷卻時間」等價。
     */
    async function reloadPage(config, reason) {
        sendLogTicketplus(`${reason}，重新整理頁面`, "warn");
        sendEventTicketplus("RELOAD");
        await helper.delay(50);
        if (config.reload_delay > 0) {
            await helper.delay(config.reload_delay * 1000);
        }
        window.location.reload();
    }

    /**
     * 更新票數資訊
     * 訂單頁上的「更新票數」按鈕會重新向 API 取得票區與剩餘張數，Vue 會直接更新畫面，
     * 因此不需要整頁重新載入（Python 端只能用 driver.refresh()）。
     * 找不到或按鈕被停用時，才退回 Python 原本的重新整理行為。
     */
    async function ticketplusRefreshTicketInfo(config, reason) {
        const refreshButton = document.querySelector(TICKET_NUMBER_PLUS_SELECTOR);
        if (!refreshButton || refreshButton.disabled) {
            await reloadPage(config, reason);
            return false;
        }

        sendLogTicketplus(`${reason}，點擊「更新票數」重新取得票區資訊`, "warn");
        refreshButton.click();
        if (config.reload_delay > 0) {
            await helper.delay(config.reload_delay * 1000);
        }
        return true;
    }

    /** chrome_tixcraft.py:10500 get_performance_log 的瀏覽器端等價實作 */
    function getPerformanceLog(urlKeyword) {
        try {
            return performance
                .getEntriesByType("resource")
                .map(entry => entry.name)
                .filter(name => name.includes(urlKeyword));
        } catch (_) {
            return [];
        }
    }

    // ============================================================
    // 步驟函式
    // ============================================================

    /**
     * chrome_tixcraft.py:9889 ticketplus_date_auto_select
     * /activity/XXX 頁：挑選場次並按下「立即購買」
     */
    async function ticketplusDateAutoSelect(config) {
        const autoSelectMode = config.date_mode;
        const dateKeywordList = config.choose_date;
        const passDateIsSoldOutEnable = config.pass_date_is_sold_out;
        const autoReloadComingSoonPageEnable = config.auto_reload_coming_soon;

        // PS: 'sesstion' 是 ticketplus 原站的拼字，勿修正
        let areaList = Array.from(document.querySelectorAll("div.sesstion-item > div.row"));
        let areaListCount = areaList.length;
        if (areaListCount === 0) {
            sendLogTicketplus("場次列表尚未載入，等待重試", "info");
            await helper.delay(50);
        }

        // 沒有場次列，也沒有打過 ticketplus API → 這頁還不是真正的活動頁
        const urlList = getPerformanceLog(API_URL_KEYWORD);
        if (areaListCount === 0 && urlList.length === 0) {
            areaList = null;
        }

        // '立即購票' -> '立即購買'
        const findTicketTextList = [">立即購", "尚未開賣"];
        const soldOutTextList = ["銷售一空"];

        let matchedBlocks = null;
        let formatedAreaList = null;
        let isVueReady = true;

        if (areaList !== null) {
            areaListCount = areaList.length;
            if (areaListCount > 0) {
                formatedAreaList = [];
                for (const row of areaList) {
                    let rowText = "";
                    let rowHtml = "";
                    try {
                        rowHtml = row.innerHTML;
                        rowText = removeHtmlTags(rowHtml);
                    } catch (_) {
                        break;
                    }

                    if (rowText.length > 0 && resetRowTextIfMatchKeywordExclude(config, rowText)) {
                        rowText = "";
                    }

                    if (rowText.length > 0 && rowHtml.includes('<div class="v-progress-circular__info"></div>')) {
                        // vue 尚未套用
                        isVueReady = false;
                        break;
                    }

                    if (rowText.length > 0) {
                        let rowIsEnabled = false;
                        for (const textItem of findTicketTextList) {
                            if (rowHtml.includes(textItem)) {
                                rowIsEnabled = true;
                                break;
                            }
                        }

                        if (rowIsEnabled && passDateIsSoldOutEnable) {
                            for (const soldOutItem of soldOutTextList) {
                                if (rowText.includes(soldOutItem)) {
                                    rowIsEnabled = false;
                                    break;
                                }
                            }
                        }

                        if (rowIsEnabled) formatedAreaList.push(row);
                    }
                }

                if (dateKeywordList.length === 0) {
                    matchedBlocks = formatedAreaList;
                } else {
                    matchedBlocks = getMatchedBlocksByKeyword(config, autoSelectMode, dateKeywordList, formatedAreaList);

                    // 擴充功能專屬：找不到符合場次時改選第一個可購場次
                    if (matchedBlocks.length === 0 && config.date_fallback === "select_first" && formatedAreaList.length > 0) {
                        sendLogTicketplus("找不到符合日期的場次，改選可購買場次", "warn");
                        matchedBlocks = formatedAreaList;
                    }
                }
            }
        }

        let isDateClicked = false;
        if (isVueReady) {
            const targetArea = getTargetItemFromMatchedList(matchedBlocks, autoSelectMode);
            if (targetArea) {
                try {
                    const targetButton = targetArea.querySelector("button");
                    if (targetButton && !targetButton.disabled) {
                        targetButton.click();
                        isDateClicked = true;
                        sendLogTicketplus(`已選定場次：${removeHtmlTags(targetArea.innerHTML).replace(/\s+/g, " ")}`, "success");
                    }
                } catch (_) {
                    // 與 Python 相同：忽略例外
                }
            }

            // [PS]: 只有在「可購場次清單為空陣列」時才重整
            if (autoReloadComingSoonPageEnable && !isDateClicked) {
                if (formatedAreaList !== null && formatedAreaList.length === 0) {
                    await reloadPage(config, "目前沒有可購買場次");
                }
            }
        }

        return isDateClicked;
    }

    /**
     * chrome_tixcraft.py:10059 ticketplus_assign_ticket_number
     * 以 + 按鈕把張數加到設定值。scope 可為某個票區容器，也可為 document（整頁）
     */
    async function ticketplusAssignTicketNumber(scope, config) {
        let isPriceAssignByBot = false;

        let ticketNumberDiv = null;
        try {
            ticketNumberDiv = scope.querySelector("div.count-button > div");
        } catch (_) {
            ticketNumberDiv = null;
        }

        if (ticketNumberDiv) {
            const ticketNumber = config.buy_count;

            let ticketNumberText = "";
            try {
                ticketNumberText = (ticketNumberDiv.innerText || "").trim();
            } catch (_) {
                ticketNumberText = "";
            }

            if (ticketNumberText.length > 0) {
                let ticketNumberTextInt = parseInt(ticketNumberText, 10);
                if (Number.isNaN(ticketNumberTextInt)) return false;

                if (ticketNumberTextInt < ticketNumber) {
                    let ticketNumberPlus = null;
                    try {
                        ticketNumberPlus = scope.querySelector("button > span > i.mdi-plus");
                    } catch (_) {
                        ticketNumberPlus = null;
                    }

                    if (ticketNumberPlus) {
                        const addCount = ticketNumber - ticketNumberTextInt;
                        for (let i = 0; i < addCount; i += 1) {
                            try {
                                ticketNumberPlus.click();
                                isPriceAssignByBot = true;
                                if (i === 0) await helper.delay(50);

                                ticketNumberText = (ticketNumberDiv.innerText || "").trim();
                                if (ticketNumberText.length > 0) {
                                    ticketNumberTextInt = parseInt(ticketNumberText, 10);
                                    if (ticketNumberTextInt >= ticketNumber) {
                                        sendLogTicketplus(`張數已設定為 ${ticketNumberTextInt}（目標 ${ticketNumber}）`, "success");
                                        break;
                                    }
                                }
                            } catch (_) {
                                // 與 Python 相同：忽略例外
                            }
                        }
                    }
                } else {
                    // 已達目標張數
                    isPriceAssignByBot = true;
                }
            }
        }

        return isPriceAssignByBot;
    }

    /**
     * chrome_tixcraft.py:10139 ticketplus_order_expansion_auto_select
     * 訂單頁票區選擇（核心）
     * @returns {Promise<{isNeedRefresh:boolean, isPriceAssignByBot:boolean, isResetQuery:boolean}>}
     */
    async function ticketplusOrderExpansionAutoSelect(config, areaKeywordItem, currentLayoutStyle) {
        const autoSelectMode = config.area_mode;

        let isNeedRefresh = false;
        let isClickOnFolder = false;
        let matchedBlocks = null;

        let areaList = null;
        try {
            // style 2: .text-title
            let myCssSelector = "div.rwd-margin > div.text-title";
            if (currentLayoutStyle === 1) {
                // style 1: .text-title
                // PS: 價格資訊表頭的格式也是 div.v-expansion-panels > div.v-expansion-panel
                myCssSelector = "div.seats-area > div.v-expansion-panel > div.v-expansion-panel-content > div.v-expansion-panel-content__wrap > div.text-title";
            }
            areaList = Array.from(document.querySelectorAll(myCssSelector));

            if (currentLayoutStyle === 1 && areaList.length === 0) {
                // 找不到收合的資料夾按鈕，改掃描已展開的 text-title
                const priceGroupList = document.querySelectorAll("div.price-group > div");
                if (priceGroupList.length > 0) {
                    // price group 版型
                    areaList = Array.from(document.querySelectorAll("div.seats-area > div.v-expansion-panel"));
                } else {
                    // 非 price group 版型
                    areaList = Array.from(document.querySelectorAll('div.seats-area > div.v-expansion-panel[aria-expanded="false"]'));
                    // 觸發重新查詢
                    isClickOnFolder = true;
                }
            }
        } catch (_) {
            areaList = null;
        }

        let formatedAreaList = null;
        if (areaList !== null) {
            const areaListCount = areaList.length;
            if (areaListCount > 0) {
                formatedAreaList = [];
                let soldoutCount = 0;

                for (const row of areaList) {
                    let rowText = "";
                    let rowHtml = "";
                    try {
                        rowHtml = row.innerHTML;
                        rowText = removeHtmlTags(rowHtml);
                    } catch (_) {
                        break;
                    }

                    // for style_2
                    if (rowText.length > 0 && rowText.includes("剩餘 0")) {
                        soldoutCount += 1;
                        rowText = "";
                    }
                    if (rowText.length > 0 && rowText.includes("已售完")) {
                        soldoutCount += 1;
                        rowText = "";
                    }
                    // for style_1
                    if (rowText.length > 0 && rowText.includes("剩餘：0")) {
                        soldoutCount += 1;
                        rowText = "";
                    }
                    if (rowText.length > 0 && rowHtml.includes(' soldout"')) {
                        soldoutCount += 1;
                        rowText = "";
                    }
                    if (rowText.length > 0 && rowHtml.includes(" soldout ")) {
                        soldoutCount += 1;
                        rowText = "";
                    }

                    if (rowText.length > 0 && resetRowTextIfMatchKeywordExclude(config, rowText)) {
                        rowText = "";
                    }

                    if (rowText.length > 0) formatedAreaList.push(row);
                }

                if (soldoutCount > 0 && areaListCount === soldoutCount) {
                    formatedAreaList = null;
                    isNeedRefresh = true;
                }
            }
        }

        let isPricePanelExpanded = false;
        if (formatedAreaList !== null) {
            const areaListCount = formatedAreaList.length;
            if (areaListCount > 0) {
                matchedBlocks = [];
                if (areaKeywordItem.length === 0) {
                    matchedBlocks = formatedAreaList;
                } else {
                    for (const row of formatedAreaList) {
                        let rowText = "";
                        let rowHtml = "";
                        try {
                            rowHtml = row.innerHTML;
                            rowText = removeHtmlTags(rowHtml);
                        } catch (_) {
                            break;
                        }

                        if (rowText.length > 0) {
                            rowText = formatKeywordString(rowText);

                            // 必須命中關鍵字（項目內以半形空白分隔時為 AND）
                            let isMatchArea = true;
                            const areaKeywordArray = areaKeywordItem.split(" ");
                            for (const areaKeyword of areaKeywordArray) {
                                if (!rowText.includes(formatKeywordString(areaKeyword))) {
                                    isMatchArea = false;
                                    break;
                                }
                            }

                            if (isMatchArea) {
                                matchedBlocks.push(row);

                                if (autoSelectMode === CONST_FROM_TOP_TO_BOTTOM) {
                                    if (rowHtml.includes(' aria-expanded="true"')) {
                                        isPricePanelExpanded = true;
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }

                if (matchedBlocks.length === 0) {
                    // 擴充功能專屬：找不到符合區域時改選第一個可購區域
                    if (config.area_fallback === "select_first") {
                        sendLogTicketplus("找不到符合條件的區域，改選可購買區域", "warn");
                        matchedBlocks = formatedAreaList;
                    } else {
                        matchedBlocks = null;
                        isNeedRefresh = true;
                    }
                }
            }
        }

        const targetArea = getTargetItemFromMatchedList(matchedBlocks, autoSelectMode);
        if (matchedBlocks !== null && matchedBlocks.length === 0) {
            isNeedRefresh = true;
        }

        // style_1 需要先點一次展開
        let isClicked = false;
        if (!isPricePanelExpanded && currentLayoutStyle === 1 && targetArea) {
            // PS: 必須點 button 而不是 div 才展得開
            const targetButton = targetArea.querySelector("button");
            if (targetButton) {
                targetButton.click();
                isClicked = true;
                sendLogTicketplus("已展開票區面板", "info");
            } else {
                // plan B：強制以 JS 點擊
                try {
                    const titleBar = document.getElementById("titleBar");
                    if (titleBar !== null) titleBar.innerHTML = "";
                    targetArea.scrollIntoView();
                    targetArea.firstElementChild?.click();
                } catch (_) {
                    // 與 Python 相同：忽略例外
                }
            }
        }

        let isResetQuery = false;
        if (isClickOnFolder && isClicked) {
            await helper.delay(50);
            isResetQuery = true;
        }

        let isPriceAssignByBot = false;
        if (!isResetQuery && targetArea) {
            // PS: 每個票價各有一個 div，必須傳入所屬容器才能加張數
            for (let retryIndex = 0; retryIndex < 2; retryIndex += 1) {
                isPriceAssignByBot = await ticketplusAssignTicketNumber(targetArea, config);
                if (isPriceAssignByBot) break;
            }
        }

        return { isNeedRefresh, isPriceAssignByBot, isResetQuery };
    }

    /**
     * chrome_tixcraft.py:10390 ticketplus_order_expansion_panel
     * 依序試每個區域關鍵字，必要時重整頁面
     */
    async function ticketplusOrderExpansionPanel(config, currentLayoutStyle) {
        let isPriceAssignByBot = false;
        let isNeedRefresh = false;

        const areaKeywordArray = config.choose_area;

        if (areaKeywordArray.length > 0) {
            let isResetQuery = false;
            for (let retryIdx = 0; retryIdx < 2; retryIdx += 1) {
                for (const areaKeywordItem of areaKeywordArray) {
                    const result = await ticketplusOrderExpansionAutoSelect(config, areaKeywordItem, currentLayoutStyle);
                    isNeedRefresh = result.isNeedRefresh;
                    isPriceAssignByBot = result.isPriceAssignByBot;
                    isResetQuery = result.isResetQuery;

                    if (isResetQuery) break;
                    if (!isNeedRefresh) break;
                    sendLogTicketplus(`關鍵字沒有可選票區：${areaKeywordItem}`, "warn");
                }

                // 重新查詢時要再跑一次
                if (!isResetQuery) break;
            }
        } else {
            // 空關鍵字，匹配全部
            const result = await ticketplusOrderExpansionAutoSelect(config, "", currentLayoutStyle);
            isNeedRefresh = result.isNeedRefresh;
            isPriceAssignByBot = result.isPriceAssignByBot;
        }

        if (isNeedRefresh) {
            // vue 模式：點「更新票數」就會重新拉票區資料並更新畫面，不需要整頁重新整理。
            // 下一輪主迴圈會重新掃描更新後的票區清單。
            await ticketplusRefreshTicketInfo(config, "目前沒有可購買票區");
        }

        return isPriceAssignByBot;
    }

    /**
     * chrome_tixcraft.py:10453 ticketplus_order_exclusive_code
     * 搭配 chrome_tixcraft.py:1833 fill_common_verify_form
     * 密碼 / 驗證問題（單一輸入框、以 Enter 送出）
     */
    function ticketplusOrderExclusiveCode(config, failList) {
        const questionText = getTextBySelector(".exclusive-code > form > div");
        let isAnswerSent = false;
        let isQuestionPopup = false;

        if (questionText.length > 0) {
            isQuestionPopup = true;
            sendLogTicketplus(`偵測到驗證問題：${questionText.replace(/\s+/g, " ")}`, "info");

            let answerList = config.user_guess_string;
            if (answerList.length === 0 && config.auto_guess_options) {
                answerList = guessTicketplusQuestion(questionText);
            }

            let inferredAnswerString = "";
            for (const answerItem of answerList) {
                if (!failList.includes(answerItem)) {
                    inferredAnswerString = answerItem;
                    break;
                }
            }

            const inputTextCss = ".exclusive-code > form > div.v-input > div > div > div > input[type='text']";
            const formInputList = Array.from(document.querySelectorAll(inputTextCss));
            const formInput1 = formInputList.length > 0 ? formInputList[0] : null;
            // 單一輸入框時才自動送出
            const isDoPressNextButton = formInputList.length === 1;

            if (formInput1) {
                const inputedValue1 = formInput1.value ?? "";

                if (inferredAnswerString.length > 0) {
                    if (inputedValue1 !== inferredAnswerString) {
                        helper.typeInput(formInput1, inferredAnswerString);
                    }

                    let isButtonClicked = false;
                    if (isDoPressNextButton) {
                        // submit_by_enter = True
                        sendEnterKey(formInput1);
                        isButtonClicked = true;
                    }

                    if (isButtonClicked) {
                        isAnswerSent = true;
                        failList.push(inferredAnswerString);
                        sendLogTicketplus(`已填入驗證答案：${inferredAnswerString}`, "success");
                    }
                } else if (inputedValue1.length === 0) {
                    // 沒有可用答案，把游標移到輸入框讓使用者手動輸入
                    if (document.activeElement !== formInput1) formInput1.focus();
                    sendLogTicketplus("找不到可用的驗證答案，請手動輸入", "warn");
                }
            }
        }

        return { isAnswerSent, failList, isQuestionPopup };
    }

    /**
     * chrome_tixcraft.py:10522 ticketplus_order_auto_reload_coming_soon
     * Python 註解明確指出這段要交由 chrome extension 負責（py L11268）。
     * 重新抓取頁面本身打過的 ticketplus API，狀態為 pending（未開賣）就重整。
     */
    let lastComingSoonPollAt = 0;
    function ticketplusOrderAutoReloadComingSoon(config) {
        // Python 主迴圈每 50ms 就送一次，實務上過於頻繁，這裡以重整延遲節流
        const intervalMs = Math.max(50, config.reload_delay * 1000);
        const now = Date.now();
        if (now - lastComingSoonPollAt < intervalMs) return;
        lastComingSoonPollAt = now;

        const urlList = getPerformanceLog(API_URL_KEYWORD);
        let getSeatsByTicketAreaIdUrl = "";
        for (const requestUrl of urlList) {
            if (requestUrl.includes("get?productId=")) {
                getSeatsByTicketAreaIdUrl = requestUrl;
                break;
            }
            if (requestUrl.includes("get?ticketAreaId=")) {
                getSeatsByTicketAreaIdUrl = requestUrl;
                break;
            }
        }

        if (getSeatsByTicketAreaIdUrl.length === 0) return;

        // 與 Python 相同：射後不理，不阻塞本輪流程
        fetch(getSeatsByTicketAreaIdUrl)
            .then(response => response.json())
            .then(data => {
                if (data.result.product.length > 0 && data.result.product[0].status === "pending") {
                    ticketplusRefreshTicketInfo(config, "票券尚未開賣");
                    //sendLogTicketplus("票券尚未開賣，重新整理頁面", "warn");
                    //sendEventTicketplus("RELOAD");
                    //window.location.reload();
                }
            })
            .catch(() => { });
    }

    /**
     * chrome_tixcraft.py:10570 ticketplus_order
     * 訂單頁主流程
     */
    async function ticketplusOrder(config, ticketplusDict) {
        // PS: 只有在送出鈕為 disabled 時才需要動作
        let isButtonDisabled = false;
        let currentLayoutStyle = 0;

        const style2Button = document.querySelector(NEXT_BTN_STYLE_2);
        if (style2Button) {
            if (style2Button.disabled) {
                isButtonDisabled = true;
                currentLayoutStyle = 2;
            }
        } else {
            const style1Button = document.querySelector(NEXT_BTN_STYLE_1);
            if (style1Button && style1Button.disabled) {
                isButtonDisabled = true;
                currentLayoutStyle = 1;
            }
        }

        if (!isButtonDisabled) return ticketplusDict;

        sendLogTicketplus(`偵測到訂單頁版型 style_${currentLayoutStyle}`, "info");

        let isPriceAssignByBot = await ticketplusOrderExpansionPanel(config, currentLayoutStyle);
        if (!isPriceAssignByBot) {
            isPriceAssignByBot = await ticketplusAssignTicketNumber(document, config);
        }

        if (isPriceAssignByBot) {
            const result = ticketplusOrderExclusiveCode(config, ticketplusDict.fail_list);
            ticketplusDict.fail_list = result.failList;

            // auto_submit = True
            let isFormSubmited = pressButton(NEXT_BTN_STYLE_2);
            if (!isFormSubmited) {
                isFormSubmited = pressButton(NEXT_BTN_STYLE_1);
            }

            if (isFormSubmited) {
                sendLogTicketplus("已送出訂單表單，等待結果", "success");
                await helper.delay(500);
            }
        }

        return ticketplusDict;
    }

    // ── 對話框（chrome_tixcraft.py:11161-11177）─────────────────────

    /** 實名制（activity）／未結帳訂單（order） */
    function ticketplusAcceptRealnameCard() {
        return pressButton("div.v-dialog__content > div > div > div > div.row > div > button.primary");
    }

    /** 好玩其他活動 */
    function ticketplusAcceptOtherActivity() {
        return pressButton('div[role="dialog"] > div.v-dialog > button.primary-1 > span > i.v-icon');
    }

    /** 購票失敗：您選擇的票種已售完或本活動有限制購票總張數 */
    function ticketplusAcceptOrderFail() {
        return pressButton('div[role="dialog"] > div.v-dialog > div.v-card > div > div.row > div.col > button.v-btn');
    }

    /** chrome_tixcraft.py:11180 ticketplus_ticket_agree */
    function ticketplusTicketAgree() {
        const agreeCheckbox = document.querySelector('div.v-input__slot > div > input[type="checkbox"]');
        return forceCheckCheckbox(agreeCheckbox);
    }

    // ============================================================
    // 主流程（chrome_tixcraft.py:11205 ticketplus_main）
    // ============================================================

    // 對應 Python 的 global ticketplus_dict
    const ticketplusDict = {
        fail_list: [],
        is_popup_confirm: false,
    };

    // 進入確認頁後的收尾狀態
    // DONE 事件只是通知 popup，本身不會停下主迴圈；沒有這個旗標的話，
    // 使用者從確認頁返回購票頁時，主迴圈會再跑一次選票送單。
    let flowCompleted = false;
    let confirmReachedAt = 0;

    // 同意條款的 checkbox 由 Vue 掛載，進入確認頁當下不一定存在，
    // 因此保留一段寬限時間持續嘗試勾選，之後才真正結束主迴圈。
    const CONFIRM_AGREE_GRACE_MS = 3000;

    /**
     * 流程收尾：清掉 storage 的執行旗標
     * 不清的話，頁面重整時 background 的 resumePlatformRun 會重新注入腳本並送出
     * START，或 content script 自己 autoResume，等同流程從未停止。
     * popup 收到 DONE 時也會清一次，但側邊欄未開啟時沒有接收者，因此這裡必須自清。
     */
    async function finishTicketplusFlow() {
        flowCompleted = true;
        await controller.storageSet({ ticketplus_isRunning: false });
    }

    async function ticketplusMain(url, config) {
        const lowerUrl = url.toLowerCase();
        const segmentCount = url.split("/").length;

        // 首頁：Python 在此自動登入後導回 homepage；本擴充功能不移植登入，
        // 改為沿用 tixcraft 模組慣例導向使用者設定的目標網址
        if (!flowCompleted && lowerUrl === "https://ticketplus.com.tw/" && config.target_url) {
            sendLogTicketplus("跳轉至目標活動網址", "info");
            window.location.href = config.target_url;
            return;
        }

        // https://ticketplus.com.tw/activity/XXX
        // flowCompleted 之後不再自動選場次／選票：使用者返回上一頁只是想看訂單，
        // 不該被再下一單
        if (!flowCompleted && lowerUrl.includes("/activity/")) {
            if (segmentCount === 5) {
                ticketplusAcceptRealnameCard();
                ticketplusAcceptOtherActivity();

                if (config.date_auto_select_enable) {
                    await ticketplusDateAutoSelect(config);
                }
            }
        }

        // https://ticketplus.com.tw/order/XXX/OOO
        if (lowerUrl.includes("/order/")) {
            if (segmentCount === 6 && !flowCompleted) {
                ticketplusAcceptRealnameCard();
                ticketplusAcceptOrderFail();

                // Python 在啟用 chrome extension 時把這段交給擴充功能執行
                if (config.auto_reload_coming_soon) {
                    ticketplusOrderAutoReloadComingSoon(config);
                }

                await ticketplusOrder(config, ticketplusDict);
            }
        } else {
            ticketplusDict.fail_list = [];
        }

        // https://ticketplus.com.tw/confirm/xx/oo
        if (lowerUrl.includes("/confirm/") || lowerUrl.includes("/confirmseat/")) {
            if (segmentCount === 6) {
                if (!ticketplusDict.is_popup_confirm) {
                    ticketplusDict.is_popup_confirm = true;
                    confirmReachedAt = Date.now();
                    sendLogTicketplus("已進入確認頁，請前往付款", "success");
                    sendEventTicketplus("DONE");
                    notifyTicketplus();
                    await finishTicketplusFlow();
                }
                ticketplusTicketAgree();

                // 勾選同意條款的寬限時間結束後才停迴圈，讓 popup 的「停止」狀態
                // 與 content script 實際狀態一致
                if (Date.now() - confirmReachedAt >= CONFIRM_AGREE_GRACE_MS) {
                    controller.requestStop();
                }
            } else {
                ticketplusDict.is_popup_confirm = false;
            }
        } else {
            ticketplusDict.is_popup_confirm = false;
        }
    }

    // ============================================================
    // 開賣時間排程（擴充功能專屬，Python 端無對應）
    // ============================================================

    /** 把秒數格式化為 hh:mm:ss */
    function formatCountdown(totalSeconds) {
        const value = Math.max(0, Math.floor(totalSeconds));
        const hh = String(Math.floor(value / 3600)).padStart(2, "0");
        const mm = String(Math.floor((value % 3600) / 60)).padStart(2, "0");
        const ss = String(value % 60).padStart(2, "0");
        return `${hh}:${mm}:${ss}`;
    }

    /**
     * 倒數到設定的開賣啟動時間才進主迴圈
     *
     * config.sale_start_at 是「開賣時間 - 提前秒數」換算出的絕對時間戳（毫秒），
     * 由 popup 計算後透過 START payload 傳入；0 代表沒有排程、立即執行。
     * 因為是絕對時間，頁面重整後 background 重送 START 也能接續倒數。
     *
     * 等待期間完全不動作（不重整、不點擊），只回報剩餘時間；
     * 使用者按下「停止」或流程被新的 START 取代時會立即中斷。
     *
     * @returns {Promise<boolean>} 等到啟動時間回傳 true；被中斷回傳 false
     */
    async function waitUntilSaleStart(config, token) {
        const startAt = config.sale_start_at;
        if (!startAt || startAt <= Date.now()) return true;

        sendLogTicketplus(`⏰ 等待開賣，預計 ${new Date(startAt).toLocaleString("zh-TW")} 啟動`, "info");

        let lastReportedSecond = -1;
        while (Date.now() < startAt) {
            if (token !== controller.state.runToken || isStopped()) {
                sendLogTicketplus("排程等待已取消", "warn");
                return false;
            }

            const remainMs = startAt - Date.now();
            const remainSecond = Math.ceil(remainMs / 1000);

            // 播報頻率：10 秒內每秒、60 秒內每 10 秒、其餘每分鐘，避免洗版
            const reportStep = remainSecond <= 10 ? 1 : (remainSecond <= 60 ? 10 : 60);
            if (remainSecond !== lastReportedSecond && remainSecond % reportStep === 0) {
                lastReportedSecond = remainSecond;
                sendLogTicketplus(`距離啟動還有 ${formatCountdown(remainSecond)}`, "info");
            }

            // 越接近啟動時間輪詢越密，最後一輪的誤差控制在 10ms 內
            await helper.delay(Math.min(200, Math.max(10, remainMs)));
        }

        sendLogTicketplus("⏰ 已達啟動時間", "success");
        return true;
    }

    /**
     * 主迴圈：對應 chrome_tixcraft.py:11473 的 while True（每 50ms 一輪）
     * ticketplus 是 Vue SPA，URL 會在不重新載入的情況下改變，因此必須輪詢。
     */
    async function runMainLoop(config, token) {
        // 重新啟動時清掉上一輪的收尾狀態，否則同一個頁面實例按「開始」會直接空轉
        flowCompleted = false;
        ticketplusDict.is_popup_confirm = false;

        // 有設定開賣時間時，先倒數到啟動時間再開始搶票
        if (!(await waitUntilSaleStart(config, token))) return;

        sendLogTicketplus("TicketPlus 搶票流程已啟動", "info");

        while (token === controller.state.runToken && !isStopped()) {
            await helper.delay(50);

            if (token !== controller.state.runToken || isStopped()) break;

            try {
                await ticketplusMain(window.location.href, config);
            } catch (error) {
                // 與 Python 每段都有 except 相同：單輪錯誤不得中斷主迴圈
                sendLogTicketplus(`流程錯誤：${error.message}`, "error");
            }
        }

        sendLogTicketplus("TicketPlus 流程已停止", "warn");
    }

    // ============================================================
    // Discord 通知（沿用 tixcraft / kktix 模組慣例）
    // ============================================================
    const TICKETPLUS_WEBHOOK_URL = "";

    async function notifyTicketplus() {
        if (!TICKETPLUS_WEBHOOK_URL) return;

        try {
            await fetch(TICKETPLUS_WEBHOOK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    username: "TicketPlus Ticket Helper",
                    embeds: [
                        {
                            title: "TicketPlus 通知",
                            description: "流程已進入確認頁面",
                            color: 0x00ff00,
                            fields: [{ name: "時間", value: new Date().toLocaleString("zh-TW") }],
                        },
                    ],
                }),
            });
            sendLogTicketplus("Discord 通知已送出", "success");
        } catch (error) {
            sendLogTicketplus(`Discord 通知失敗：${error.message}`, "error");
        }
    }

    // ============================================================
    // 初始化
    // ============================================================
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
        controller.handleRuntimeMessage(message, sender, sendResponse)
    );

    async function onDomReady() {
        await controller.loadGlobalEnabled();
        await controller.autoResume();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", onDomReady, { once: true });
    } else {
        onDomReady();
    }
}
