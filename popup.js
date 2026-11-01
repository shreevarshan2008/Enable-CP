const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const hint = document.getElementById('hint');

function render(enabled, changed = false) {
  toggle.checked = enabled;
  status.textContent = enabled ? 'ON' : 'OFF';
  status.classList.toggle('off', !enabled);
  hint.textContent = changed
    ? 'Reload the page for a full reset.'
    : (enabled ? 'Copy, paste, shortcuts & right-click unlocked.' : 'Sites behave as normal.');
}

chrome.storage.local.get({ enabled: true }, ({ enabled }) => render(enabled));

toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  chrome.storage.local.set({ enabled }, () => render(enabled, true));
});

// On-screen messages switch
const toastToggle = document.getElementById('toastToggle');
const toastStatus = document.getElementById('toastStatus');
function renderToast(on) {
  toastToggle.checked = on;
  toastStatus.textContent = on ? 'ON' : 'OFF';
  toastStatus.classList.toggle('off', !on);
}
chrome.storage.local.get({ toasts: true }, ({ toasts }) => renderToast(toasts));
toastToggle.addEventListener('change', () => {
  chrome.storage.local.set({ toasts: toastToggle.checked }, () => renderToast(toastToggle.checked));
});

// Hide any social link that still has the placeholder username
document.querySelectorAll('.social a').forEach((a) => {
  if (a.getAttribute('href').includes('YOUR_USERNAME')) a.style.display = 'none';
});
