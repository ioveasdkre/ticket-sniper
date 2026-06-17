// ============================================================
// momoshop-alert-override.js - Momoshop MAIN world dialog hook
// ============================================================
// Native dialogs block content scripts. Forward their messages to
// the isolated world and auto-confirm so the checkout flow can proceed.
// ============================================================

if (!window.__momoshopDialogPatched) {
    window.__momoshopDialogPatched = true;

    window.alert = function patchedMomoshopAlert(message) {
        window.dispatchEvent(new CustomEvent("__momoshop_alert", {
            detail: message ?? "",
        }));
    };

    window.confirm = function patchedMomoshopConfirm(message) {
        window.dispatchEvent(new CustomEvent("__momoshop_confirm", {
            detail: message ?? "",
        }));
        return true;
    };
}
