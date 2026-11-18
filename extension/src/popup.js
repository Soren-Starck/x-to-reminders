const t = (key, sub) => chrome.i18n.getMessage(key, sub) || key;
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;

const status = document.getElementById("status");
const text = document.getElementById("text");
const action = document.getElementById("action");

function show(kind, message, label, onClick) {
  status.className = kind;
  text.textContent = message;
  action.hidden = !label;
  if (label) {
    action.textContent = label;
    action.onclick = onClick;
  }
}

chrome.runtime.sendMessage({ type: "ping" }, (r) => {
  if (chrome.runtime.lastError || !r) return show("problem", t("errGeneric"));
  if (!r.ok && (r.error === "no-host" || r.error === "forbidden")) {
    return show("problem", t("popupNoHost"), t("errNoHostAction"), () =>
      chrome.tabs.create({ url: "https://github.com/Soren-Starck/x-to-reminders#install" }),
    );
  }
  if (!r.ok) return show("problem", t("errGeneric"));
  if (r.access === "full") return show("ready", t("popupReady", r.list || "Reminders"));
  if (r.access === "notDetermined") return show("first", t("popupFirst"));
  show("problem", t("popupDenied"), t("errDeniedAction"), () => chrome.runtime.sendMessage({ type: "openSettings" }));
});
