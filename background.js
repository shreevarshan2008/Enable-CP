// Shows an ON/OFF badge on the toolbar icon.
function updateBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#16a34a' : '#6b7280' });
}
function init() {
  chrome.storage.local.get({ enabled: true }, ({ enabled }) => updateBadge(enabled));
}
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) updateBadge(changes.enabled.newValue);
});
init();
