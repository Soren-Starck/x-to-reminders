// Puts an "Add to Reminders" button in the action bar of every post on X,
// beside Bookmark. Works with both of X's web clients (the classic one with
// data-testid attributes and the newer one without).

(() => {
  "use strict";
  // After an update the extension injects a fresh copy into open X tabs. The
  // newest copy owns the page; an older one stops as soon as it notices.
  const me = {};
  const owner = Math.random().toString(36).slice(2);
  window.__xToReminders = me;
  for (const old of document.querySelectorAll(".xtr-wrap")) old.remove();

  const POST_PATH = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})(?:[/?#]|$)/;
  const BAR_MARKS =
    '[data-testid="reply"],[data-testid="like"],[data-testid="unlike"],[data-testid="bookmark"],' +
    '[data-testid="removeBookmark"],[data-engagement-action]';
  const BOOKMARK =
    '[data-testid="bookmark"],[data-testid="removeBookmark"],[data-engagement-action="bookmark"]';
  const CONTROLS = 'button,a[href],[role="button"]';

  const ids = new Map(); // post id -> list name, for posts already in Reminders
  const stats = { bars: 0, buttons: 0, missed: 0, gap: 0, fit: "" };
  let alive = true;
  let lastSync = 0;
  let synced = false;

  // Once the extension is updated or removed, this copy can no longer read its
  // translations; it only ever needs these two then.
  const FALLBACK = { errReload: "X to Reminders was updated. Reload this page.", errReloadAction: "Reload" };
  const t = (key, sub) => {
    try {
      return chrome.i18n.getMessage(key, sub) || FALLBACK[key] || key;
    } catch {
      return FALLBACK[key] || key;
    }
  };

  // ---- Finding the post behind an action bar ----

  function parse(href) {
    if (!href) return null;
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return null;
    }
    // Relative links belong to the page; absolute ones must point at X.
    if (/^[a-z]+:/i.test(href) && !/(^|\.)(x|twitter)\.com$/i.test(url.hostname)) return null;
    const m = url.pathname.match(POST_PATH);
    return m ? { handle: m[1], id: m[2] } : null;
  }

  // True when node belongs to a post quoted inside article, not to article itself.
  function inQuote(node, article) {
    for (let n = node.parentElement; n && n !== article; n = n.parentElement) {
      if (n.tagName === "ARTICLE") return true;
      if (n.getAttribute("data-slot") === "embedded-tweet-frame") return true;
      if (n.getAttribute("role") === "link" && n.tagName !== "A") return true;
    }
    return false;
  }

  function postOf(article, bar) {
    // The bar itself often names its post: the views link (classic) or the reply link (new client).
    const hints = new Set();
    for (const a of bar.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      const reply = /[?&]in_reply_to=(\d{5,25})/.exec(href);
      if (reply) hints.add(reply[1]);
      const p = parse(href);
      if (p) hints.add(p.id);
    }
    const found = [];
    const card = article.parentElement;
    if (card && card.getAttribute("data-slot") !== "embedded-tweet-frame") {
      const p = parse(card.getAttribute("data-href"));
      if (p) found.push({ ...p, rank: 3 });
    }
    for (const a of article.querySelectorAll('a[href*="/status/"]')) {
      if (inQuote(a, article)) continue;
      const p = parse(a.getAttribute("href"));
      if (p) found.push({ ...p, rank: bar.contains(a) ? 0 : a.querySelector("time") ? 2 : 1 });
    }
    found.sort((a, b) => b.rank - a.rank);
    if (hints.size) return found.find((p) => hints.has(p.id)) || { handle: "i", id: [...hints][0] };
    return found[0] || null;
  }

  // ---- The button ----

  const GLYPH = {
    idle:
      '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.9"/>' +
      '<path d="M12 8.1v7.8M8.1 12h7.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    saved:
      '<circle cx="12" cy="12" r="9.55" fill="currentColor"/>' +
      '<path class="xtr-check" d="M7.9 12.3l2.75 2.75 5.45-5.8" fill="none" stroke="var(--xtr-bg)" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
  };

  function paint(button, state, list) {
    const prev = button.dataset.state;
    button.dataset.state = state;
    const label =
      state === "saved" ? (list ? t("already", list) : t("inReminders")) : state === "pending" ? t("adding") : t("add");
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", state === "saved" ? "true" : "false");
    const wantsSaved = state === "saved";
    if (button.dataset.glyph !== String(wantsSaved)) {
      button.dataset.glyph = String(wantsSaved);
      button.querySelector("svg").innerHTML = wantsSaved ? GLYPH.saved : GLYPH.idle;
    }
    if (prev === "pending" && state === "saved") {
      button.classList.remove("xtr-pop");
      void button.offsetWidth;
      button.classList.add("xtr-pop");
    }
  }

  function make(post) {
    const wrap = document.createElement("div");
    wrap.className = "xtr-wrap";
    wrap.dataset.xtrOwner = owner;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "xtr-btn";
    button.innerHTML =
      '<svg class="xtr-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"></svg>';
    wrap.append(button);
    bind(wrap, post);
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "touchstart"]) {
      button.addEventListener(type, (e) => e.stopPropagation());
    }
    button.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") e.stopPropagation();
    });
    button.addEventListener("click", onClick);
    return wrap;
  }

  function bind(wrap, post) {
    wrap.dataset.xtrId = post.id;
    wrap.dataset.xtrHandle = post.handle;
    const button = wrap.firstElementChild;
    if (button.dataset.state !== "pending") {
      paint(button, ids.has(post.id) ? "saved" : "idle", ids.get(post.id));
    }
  }

  // Where the button goes: just before Bookmark, at the level where Bookmark sits beside Share.
  function anchorOf(bar) {
    const mark = bar.querySelector(BOOKMARK) || bar.querySelector('[data-engagement-action="share"]');
    let box = mark;
    if (!box) {
      const all = [...bar.querySelectorAll(CONTROLS)];
      box = all[all.length - 1];
    }
    if (!box) return null;
    while (box.parentElement && box.parentElement !== bar && box.parentElement.querySelectorAll(CONTROLS).length <= 1) {
      box = box.parentElement;
    }
    return box;
  }

  // Match the neighbouring icons: size, colour, and the gap between Bookmark and Share.
  function fit(wrap, bar) {
    const icons = [...bar.querySelectorAll("svg")].filter((s) => !wrap.contains(s) && s.getBoundingClientRect().width > 0);
    const next = wrap.nextElementSibling;
    const ref = (next && next.querySelector("svg")) || icons[icons.length - 1];
    if (!ref) return false;
    const r = ref.getBoundingClientRect();
    if (!r.width) return false;
    wrap.style.setProperty("--xtr-icon", `${r.width.toFixed(2)}px`);
    wrap.style.setProperty("--xtr-color", getComputedStyle(ref).color);
    // The spacing X uses between two icons with no count in between. Newer X draws
    // each control as a padded pill (icon, padding, padding, icon); classic X spaces
    // bare icons, so measure Bookmark to Share there.
    let gap = 12;
    const last = icons[icons.length - 1];
    const control = last?.closest(CONTROLS);
    const pad = control ? last.getBoundingClientRect().left - control.getBoundingClientRect().left : 0;
    const after = icons[icons.indexOf(ref) + 1];
    if (pad >= 6 && pad <= 24) gap = pad * 2;
    else if (after) {
      const a = after.getBoundingClientRect();
      const measured = Math.abs(a.left - r.right) < Math.abs(r.left - a.right) ? a.left - r.right : r.left - a.right;
      if (measured >= 2 && measured <= 48) gap = measured;
    }
    stats.gap = Math.round(gap);
    const mine = wrap.querySelector("svg").getBoundingClientRect();
    if (mine.width) {
      const rtl = getComputedStyle(bar).direction === "rtl";
      const current = rtl ? mine.left - r.right : r.left - mine.right;
      const margin = parseFloat(wrap.style.marginInlineEnd || "0") + (gap - current);
      wrap.style.marginInlineEnd = `${Math.max(-8, Math.min(48, margin)).toFixed(2)}px`;
      const shift = parseFloat(wrap.style.top || "0") + (r.top + r.bottom - mine.top - mine.bottom) / 2;
      wrap.style.top = `${Math.max(-12, Math.min(12, shift)).toFixed(2)}px`;
      const now = wrap.querySelector("svg").getBoundingClientRect();
      stats.fit = [
        Math.round(now.width - r.width),
        Math.round((rtl ? now.left - r.right : r.left - now.right) - gap),
        Math.round((now.top + now.bottom - r.top - r.bottom) / 2),
      ].join("/");
    }
    wrap.dataset.fit = "1";
    return true;
  }

  // ---- Scanning the page ----

  let observer = null;
  let timer = 0;

  // An updated (or removed) extension cuts this copy off. It then takes its own
  // buttons away; the new copy, if any, puts live ones back.
  function retired() {
    if (alive && chrome.runtime?.id && window.__xToReminders === me) return false;
    if (observer) {
      observer.disconnect();
      observer = null;
      clearInterval(timer);
      for (const wrap of document.querySelectorAll(".xtr-wrap")) if (wrap.dataset.xtrOwner === owner) wrap.remove();
    }
    alive = false;
    return true;
  }

  function scan() {
    if (retired()) return;
    let bars = 0;
    let missed = 0;
    for (const bar of document.querySelectorAll('article [role="group"]')) {
      if (!bar.querySelector(BAR_MARKS)) continue;
      const article = bar.closest("article");
      if (!article || inQuote(bar, article)) continue;
      bars++;
      const post = postOf(article, bar);
      let wrap = bar.querySelector(":scope .xtr-wrap");
      if (wrap && wrap.dataset.xtrOwner !== owner) {
        // Left by an older copy of this script (before an update): replace it.
        wrap.remove();
        wrap = null;
      }
      if (!post) {
        missed++;
        wrap?.remove();
        continue;
      }
      if (wrap) {
        if (wrap.dataset.xtrId !== post.id) bind(wrap, post);
        if (wrap.dataset.fit !== "1") fit(wrap, bar);
        continue;
      }
      const box = anchorOf(bar);
      if (!box) {
        missed++;
        continue;
      }
      wrap = make(post);
      box.parentElement.insertBefore(wrap, box);
      fit(wrap, bar);
    }
    stats.bars = bars;
    stats.missed = missed;
    stats.buttons = document.querySelectorAll(".xtr-wrap").length;
    if (!synced && bars) {
      synced = true;
      sync(true);
    }
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    const run = () => {
      queued = false;
      scan();
    };
    if (document.hidden) setTimeout(run, 120);
    else requestAnimationFrame(run);
  }

  // ---- Talking to the extension ----

  function sendOnce(message) {
    return new Promise((resolve) => {
      if (!alive) return resolve({ ok: false, error: "reload" });
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) resolve({ ok: false, error: /context invalidated/i.test(error.message) ? "reload" : "background" });
          else resolve(response || { ok: false, error: "empty" });
        });
      } catch {
        alive = false;
        resolve({ ok: false, error: "reload" });
      }
    });
  }

  // The extension's background worker can still be starting (just installed,
  // updated or woken up): give it a moment instead of failing the click.
  async function send(message) {
    let result;
    for (const wait of [0, 150, 400, 1000, 2000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      result = await sendOnce(message);
      if (result.error !== "background") break;
    }
    return result;
  }

  function repaint() {
    for (const wrap of document.querySelectorAll(".xtr-wrap")) {
      const button = wrap.firstElementChild;
      if (button.dataset.state === "pending") continue;
      const id = wrap.dataset.xtrId;
      paint(button, ids.has(id) ? "saved" : "idle", ids.get(id));
    }
  }

  async function sync(withDiag) {
    lastSync = Date.now();
    const diag = withDiag
      ? {
          v: chrome.runtime.getManifest().version,
          layout: document.querySelector('article[data-testid="tweet"]')
            ? "classic"
            : document.querySelector("[data-engagement-action]")
              ? "new"
              : "unknown",
          bars: stats.bars,
          buttons: stats.buttons,
          missed: stats.missed,
          gap: stats.gap,
          fit: stats.fit,
          page: location.pathname.split("/")[2] === "status" ? "post" : location.pathname.split("/")[1] || "home",
        }
      : undefined;
    const result = await send({ type: "saved", diag });
    if (!result.ids) return;
    ids.clear();
    for (const [id, list] of Object.entries(result.ids)) ids.set(id, list);
    repaint();
  }

  async function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    const wrap = button.parentElement;
    const id = wrap.dataset.xtrId;
    const state = button.dataset.state;
    if (state === "pending") return;
    if (state === "saved") {
      button.classList.remove("xtr-nudge");
      void button.offsetWidth;
      button.classList.add("xtr-nudge");
      return;
    }
    paint(button, "pending");
    const keepAlive = setInterval(() => send({ type: "keepalive" }), 20_000);
    const result = await send({ type: "add", url: `https://x.com/${wrap.dataset.xtrHandle}/status/${id}`, id });
    clearInterval(keepAlive);
    if (result.ok) {
      ids.set(id, result.list || "");
      paint(button, "saved", result.list);
      repaint();
      // Already saved from elsewhere (another device, another list): say where.
      if (result.status === "exists") toast(t("already", result.list || ""));
      return;
    }
    paint(button, "idle");
    button.classList.remove("xtr-shake");
    void button.offsetWidth;
    button.classList.add("xtr-shake");
    explain(result);
  }

  function explain(result) {
    switch (result.error) {
      case "no-host":
      case "forbidden":
        return toast(t("errNoHost"), t("errNoHostAction"), () =>
          window.open("https://github.com/Soren-Starck/x-to-reminders#install", "_blank", "noopener"),
        );
      case "denied":
      case "restricted":
        return toast(t("errDenied"), t("errDeniedAction"), () => send({ type: "openSettings" }));
      case "timeout":
        return toast(t("errTimeout"));
      case "reload":
        return toast(t("errReload"), t("errReloadAction"), () => location.reload());
      default:
        return toast(t("errGeneric"));
    }
  }

  // ---- Toast ----

  let toastTimer = 0;
  function toast(text, action, onAction) {
    let el = document.querySelector(".xtr-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "xtr-toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.append(el);
    }
    el.replaceChildren();
    const span = document.createElement("span");
    span.textContent = text;
    el.append(span);
    if (action) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = action;
      b.addEventListener("click", () => {
        el.classList.remove("xtr-show");
        onAction();
      });
      el.append(b);
    }
    void el.offsetWidth; // start the transition from the hidden state
    el.classList.add("xtr-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("xtr-show"), action ? 7000 : 3200);
  }

  // ---- Theme ----

  function theme() {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/\d+(\.\d+)?/g);
    const opaque = m && m.length >= 3 && (m[3] === undefined || +m[3] > 0);
    const dark = opaque
      ? 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2] < 128
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const root = document.documentElement;
    if (root.dataset.xtrDark !== String(dark) || root.style.getPropertyValue("--xtr-bg") !== bg) {
      root.dataset.xtrDark = String(dark);
      root.style.setProperty("--xtr-bg", opaque ? bg : dark ? "#000" : "#fff");
      for (const wrap of document.querySelectorAll(".xtr-wrap")) wrap.dataset.fit = "";
      schedule();
    }
  }

  // ---- Start ----

  function start() {
    if (!document.body) return setTimeout(start, 50);
    theme();
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "data-href"],
    });
    timer = setInterval(() => retired() || theme(), 2000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && Date.now() - lastSync > 45_000) sync(false);
      schedule();
    });
    schedule();
    setTimeout(() => synced || ((synced = true), sync(true)), 4000);
  }

  start();
})();
