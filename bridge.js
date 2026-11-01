// Runs in the extension's isolated world (can use chrome.storage).
// Passes settings to the page-world script via attributes on <html>.
const root = document.documentElement;
const applyOn = (on) => root.setAttribute('data-ecp', on ? 'on' : 'off');
const applyToast = (on) => root.setAttribute('data-ecp-toast', on ? 'on' : 'off');

applyOn(true); applyToast(true);
chrome.storage.local.get({ enabled: true, toasts: true }, ({ enabled, toasts }) => {
  applyOn(enabled); applyToast(toasts);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) applyOn(changes.enabled.newValue);
  if (changes.toasts) applyToast(changes.toasts.newValue);
});
