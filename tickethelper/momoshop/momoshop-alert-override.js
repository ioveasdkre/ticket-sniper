// ============================================================
// momoshop-alert-override.js — Override alert/confirm on Momoshop pages
// Injected in the MAIN world (via manifest) to capture native dialogs
// and forward them as CustomEvents to the isolated content script.
// ============================================================

const _originalAlert = window.alert;
const _originalConfirm = window.confirm;

window.alert = function (msg) {
  window.dispatchEvent(
    new CustomEvent("__momoshop_alert", { detail: msg ?? "" })
  );
};

window.confirm = function (msg) {
  window.dispatchEvent(
    new CustomEvent("__momoshop_confirm", { detail: msg ?? "" })
  );
  return true; // auto‑confirm
};
