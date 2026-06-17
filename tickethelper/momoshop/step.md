目前chrome extension的位置是在左邊，幫我調整到右邊，
並且幫我調整momoshop的兩個.js，風格要比較tixcraft。
目前momo助手的流程如下：
1. 前往設定的商品頁面(https://www.momoshop.com.tw/product/15281742)
2. URL：https://www.momoshop.com.tw/product/15281742，檢查是否有 tag 為"button[aria-label='直接購買']"且內文為"直接購買"
    - 如果存在，點擊前往
    - 如果不存在，重新整理
3. URL： URL：https://cart.momoshop.com.tw/view/cart/WEB/newNormal
    - 等待 tag 為 "div#parentBlock" 有內容出現
    - 點擊按鈕 tag 為 "button#btnDetailCheckout"
4. URL： URL：https://cart.momoshop.com.tw/view/cart/WEB/newNormal
    - 等待 tag 為 "div#orderForm" 有內容出現
    - 收件人資料
        - 點擊 input radio "input#reveiver1[type=radio]" 的 父層 label "label"
        - 輸入設定的姓名內容至 "input#receiverName"
        - 輸入設定的手機前4碼至 "input#receiverHp1"
        - 輸入設定的手機後6碼至 "input#receiverHp23"
        - 輸入地址的縣市至 "select#receiverCity"
        - 輸入地址的鄉鎮市區至 "select#receiverPost", 需要等待縣市選擇完變動之後才能選擇鄉鎮市區
        - 輸入地址的完整內容至 "input#receiverAddr", 
        - 根據選擇的付款方式選擇 "ul#paymentRadioBtn li label[for=MPAY_ID]"
        - 選擇行動支付的方式 "input#Linepay_ID" 的父層 label
        - 點擊確認結帳按鈕 "a#orderSave"