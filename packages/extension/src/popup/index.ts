export {};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
};

const statusPill = $<HTMLSpanElement>("status");
const killBtn = $<HTMLButtonElement>("kill");
const optionsLink = $<HTMLAnchorElement>("options");

function renderStatus(connected: boolean): void {
  statusPill.textContent = connected ? "connected" : "disconnected";
  statusPill.classList.toggle("on", connected);
  statusPill.classList.toggle("off", !connected);
  killBtn.disabled = !connected;
}

async function refresh(): Promise<void> {
  const s = await chrome.storage.local.get("connected");
  renderStatus(s["connected"] === true);
}

killBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "kill_switch" }).catch(() => {});
  renderStatus(false);
});

optionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

void refresh();
window.setInterval(() => {
  void refresh();
}, 1000);
