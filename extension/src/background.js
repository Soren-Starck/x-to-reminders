// Relays the page's requests to the helper app (native messaging) and keeps a
// short-lived copy of which posts are already in Reminders.

const HOST = "studio.starck.x_to_reminders";
const ADD_TIMEOUT = 180_000; // the first add may wait on macOS's permission prompt
const READ_TIMEOUT = 20_000;
const SAVED_TTL = 30_000;

let addQueue = Promise.resolve();
let savedCache = null; // { at, result }
let savedPending = null;
const recentAdds = new Map(); // id -> { list, at }: covers the moment before a fresh read sees it

function classify(message = "") {
  if (/not found/i.test(message)) return "no-host";
  if (/forbidden/i.test(message)) return "forbidden";
  if (/exited/i.test(message)) return "host-exited";
  return "native";
}

function native(message, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeout);
    try {
      chrome.runtime.sendNativeMessage(HOST, message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) finish({ ok: false, error: classify(error.message), detail: error.message });
        else finish(response || { ok: false, error: "empty" });
      });
    } catch (error) {
      finish({ ok: false, error: "native", detail: String(error) });
    }
  });
}

let addsInFlight = 0;

function add({ url, id }) {
  // One add at a time, so a double click can never create two reminders.
  addsInFlight++;
  const run = addQueue.then(async () => {
    const result = await native({ op: "add", url }, ADD_TIMEOUT);
    addsInFlight--;
    if (result.ok && id) {
      recentAdds.set(id, { list: result.list || "", at: Date.now() });
      if (savedCache?.result?.ok) savedCache.result.ids[id] = result.list || "";
    }
    return result;
  });
  addQueue = run.catch(() => {});
  return run;
}

async function saved(diag) {
  if (savedCache && Date.now() - savedCache.at < SAVED_TTL && !diag) return withRecent(savedCache.result);
  if (!savedPending) {
    savedPending = native({ op: "saved", diag }, READ_TIMEOUT).then((result) => {
      savedPending = null;
      if (result.ok) savedCache = { at: Date.now(), result };
      return result;
    });
  }
  return withRecent(await savedPending);
}

function withRecent(result) {
  const ids = { ...(result.ok ? result.ids : {}) };
  for (const [id, { list, at }] of recentAdds) {
    if (Date.now() - at > 120_000) recentAdds.delete(id);
    else if (!(id in ids)) ids[id] = list;
  }
  return { ...result, ids };
}

// An unpacked copy updated on disk (git pull) reloads itself the next time X
// asks for something, at most once a minute.
let lastVersionCheck = 0;
async function reloadIfUpdated() {
  if (addsInFlight || Date.now() - lastVersionCheck < 60_000) return;
  lastVersionCheck = Date.now();
  try {
    const onDisk = (await (await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })).json()).version;
    if (onDisk && onDisk !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch {}
}

// Open X tabs get the (new) button right away, without a reload.
chrome.runtime.onInstalled.addListener(async () => {
  const { content_scripts: [script] } = chrome.runtime.getManifest();
  const tabs = await chrome.tabs.query({ url: script.matches }).catch(() => []);
  for (const tab of tabs) {
    const target = { tabId: tab.id };
    chrome.scripting.insertCSS({ target, files: script.css }).catch(() => {});
    chrome.scripting.executeScript({ target, files: script.js }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  switch (message?.type) {
    case "add":
      add(message).then(reply);
      return true;
    case "saved":
      saved(message.diag).then((result) => {
        reply(result);
        reloadIfUpdated();
      });
      return true;
    case "ping":
      native({ op: "ping" }, READ_TIMEOUT).then(reply);
      return true;
    case "openSettings":
      native({ op: "openSettings" }, READ_TIMEOUT).then(reply);
      return true;
    case "keepalive":
      reply({ ok: true });
      return false;
    default:
      return false;
  }
});
