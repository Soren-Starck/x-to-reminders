// End-to-end test: a headless Chrome with the extension, the real helper app
// and a JSON file standing in for Reminders, on stand-in pages shaped like
// both of X's web clients. Never touches real Reminders.
//   sh host/build.sh && node test/e2e.mjs        (CHROME=/path to pick a browser)
// Chrome 137+ ignores --load-extension, so use Chromium or Chrome for Testing.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "./cdp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "studio.starck.x_to_reminders";
const hostBin = path.join(root, "host/build/X to Reminders.app/Contents/MacOS/x-to-reminders-host");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xtr-e2e-"));
let failures = 0;
let count = 0;

function check(name, cond, detail) {
  count++;
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600));
  }
}

function chromePath() {
  const home = os.homedir();
  const pw = path.join(home, ".playwright-browsers");
  const cft = fs.existsSync(pw)
    ? fs
        .readdirSync(pw)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort()
        .reverse()
        .map((d) => path.join(pw, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))
    : [];
  const found = [process.env.CHROME, ...cft, "/Applications/Chromium.app/Contents/MacOS/Chromium"].find(
    (p) => p && fs.existsSync(p),
  );
  if (!found) throw new Error("No Chromium found: set CHROME=/path/to/chromium (Chrome for Testing works)");
  return found;
}

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${what} (${JSON.stringify(last)})`);
}

// The extension, plus a match for the local stand-in pages. Same key, so same id.
const ext = path.join(tmp, "extension");
fs.cpSync(path.join(root, "extension"), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.content_scripts[0].matches.push("http://127.0.0.1/*");
manifest.host_permissions.push("http://127.0.0.1/*");
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));

const server = http
  .createServer((req, res) => {
    const file = path.join(root, "test/fixtures", path.basename(new URL(req.url, "http://x").pathname));
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": file.endsWith(".css") ? "text/css" : "text/html" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const site = `http://127.0.0.1:${server.address().port}`;

const browsers = [];
async function launch(name, store, { host = true } = {}) {
  const profile = path.join(tmp, `profile-${name}`);
  const logs = path.join(tmp, `logs-${name}`);
  fs.mkdirSync(path.join(profile, "NativeMessagingHosts"), { recursive: true });
  if (host) {
    fs.writeFileSync(
      path.join(profile, "NativeMessagingHosts", `${HOST}.json`),
      JSON.stringify({ name: HOST, description: "test", path: hostBin, type: "stdio", allowed_origins: [`chrome-extension://${extId}/`] }),
    );
  }
  const storeFile = path.join(tmp, `store-${name}.json`);
  fs.writeFileSync(storeFile, JSON.stringify(store));
  const port = await freePort();
  const proc = spawn(
    chromePath(),
    [
      process.env.HEADED ? "" : "--headless=new",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--lang=en-US",
      "--window-size=1200,900",
      "about:blank",
    ].filter(Boolean),
    { stdio: "ignore", env: { ...process.env, XTR_MOCK_STORE: storeFile, XTR_LOG_DIR: logs } },
  );
  browsers.push(proc);
  const ws = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl, "Chrome", 45000);
  const browser = await Session.connect(ws);
  return {
    browser,
    store: () => JSON.parse(fs.readFileSync(storeFile, "utf8")),
    log: () => (fs.existsSync(path.join(logs, "host.log")) ? fs.readFileSync(path.join(logs, "host.log"), "utf8") : ""),
    async open(url) {
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
      const page = {
        send: (m, p) => browser.send(m, p, sessionId),
        async eval(expression) {
          const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
          return r.result.value;
        },
        async click(selector) {
          const box = await this.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
            await this.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
          }
        },
      };
      await page.send("Page.enable");
      await page.send("Runtime.enable");
      await page.send("Page.bringToFront");
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `window.__toasts = [];
          new MutationObserver(() => {
            const t = document.querySelector(".xtr-toast.xtr-show");
            if (t && window.__toasts.at(-1) !== t.textContent) window.__toasts.push(t.textContent);
          }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });`,
      });
      await page.send("Page.navigate", { url });
      return page;
    },
  };
}

// Extension id from the manifest key (same rule Chrome uses).
const { createHash } = await import("node:crypto");
const extId = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join("");

if (!fs.existsSync(hostBin)) {
  console.error("Build the helper first: sh host/build.sh");
  process.exit(1);
}

// The browser picks the extension's language from the system, so accept any of ours.
const locales = Object.fromEntries(
  fs.readdirSync(path.join(root, "extension/_locales")).map((l) => [l, JSON.parse(fs.readFileSync(path.join(root, "extension/_locales", l, "messages.json"), "utf8"))]),
);
const says = (text, key, sub = "") =>
  typeof text === "string" && Object.values(locales).some((m) => text.includes(m[key].message.replace(/\$[A-Z]+\$/g, sub)));

const btn = (cell) => `#${cell} .xtr-wrap .xtr-btn`;
const stateOf = (cell) => `document.querySelector(${JSON.stringify(btn(cell))})?.dataset.state`;

try {
  console.log("classic client");
  const a = await launch("main", {
    access: "notDetermined",
    grant: true,
    list: "Rappels",
    items: [{ id: "seed", title: "Later https://x.com/carol/status/3333333333333333333?s=20", list: "Ideas" }],
  });
  let page = await a.open(`${site}/classic.html`);
  await waitFor(() => page.eval(`document.querySelectorAll(".xtr-wrap").length === 2`), "two buttons");
  const placed = await page.eval(`(() => {
    const w = document.querySelector("#c1 .xtr-wrap");
    return { next: w.nextElementSibling?.querySelector("[data-testid]")?.dataset.testid, inRight: w.parentElement.classList.contains("right"),
      id: w.dataset.xtrId, handle: w.dataset.xtrHandle, id2: document.querySelector("#c2 .xtr-wrap").dataset.xtrId,
      handle2: document.querySelector("#c2 .xtr-wrap").dataset.xtrHandle, none3: !document.querySelector("#c3 .xtr-wrap") };
  })()`);
  check("one button per post, none on a post without a link", placed.none3, placed);
  check("sits just before Bookmark, beside Share", placed.next === "bookmark" && placed.inRight, placed);
  check("names the post, not the one it quotes", placed.handle === "alice" && placed.id === "1111111111111111111", placed);
  check("a repost saves the original post", placed.handle2 === "carol" && placed.id2 === "3333333333333333333", placed);

  const geo = await page.eval(`(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const mine = r("#c1 .xtr-ico"), bm = r('#c1 [data-testid="bookmark"] svg'), share = r('#c1 [aria-label="Share post"] svg');
    return { size: mine.width, ref: bm.width, gapMine: bm.left - mine.right, gapRef: share.left - bm.right, dy: Math.abs((mine.top + mine.bottom) - (bm.top + bm.bottom)) / 2 };
  })()`);
  check("same icon size as its neighbours", Math.abs(geo.size - geo.ref) < 0.5, geo);
  check("same spacing as Bookmark and Share", Math.abs(geo.gapMine - geo.gapRef) < 1.5, geo);
  check("lined up with them", geo.dy < 1, geo);

  await sleep(1200);
  check("nothing is read from Reminders before access is granted",
    (await page.eval(stateOf("c2"))) === "idle" && a.store().access === "notDetermined", await page.eval(stateOf("c2")));

  await page.click(btn("c1"));
  await waitFor(() => page.eval(`${stateOf("c1")} === "saved"`), "first add");
  let store = a.store();
  check("first click asks for access, then adds", store.access === "full" && store.items.length === 2, store);
  check("the reminder is the post's clean link, in the default list",
    store.items[1]?.title === "https://x.com/alice/status/1111111111111111111" && store.items[1]?.list === "Rappels", store.items[1]);
  check("the click did not open the post", (await page.eval(`window.__opened.length`)) === 0, await page.eval(`window.__opened`));
  const label1 = await page.eval(`document.querySelector(${JSON.stringify(btn("c1"))}).getAttribute("aria-label")`);
  check("label says where it went", says(label1, "already", "Rappels"), label1);

  await page.click(btn("c1"));
  await sleep(400);
  check("a second click adds nothing", a.store().items.length === 2);

  // Reload: now that access is granted, saved posts come back from Reminders.
  page = await a.open(`${site}/classic.html`);
  await waitFor(() => page.eval(`${stateOf("c2")} === "saved" && ${stateOf("c1")} === "saved"`), "saved states after reload");
  check("posts already in Reminders (any list) show as saved", true);
  const label2 = await page.eval(`document.querySelector(${JSON.stringify(btn("c2"))}).getAttribute("aria-label")`);
  check("their label names the list", says(label2, "already", "Ideas"), label2);

  await page.eval(`addPost("c4", "hank", "7777777777777777777")`);
  await waitFor(() => page.eval(`document.querySelector("#c4 .xtr-wrap")?.dataset.xtrId === "7777777777777777777"`), "button on a new post");
  check("posts loaded later get a button", true);

  await page.eval(`(() => { const w = document.querySelector("#c1 .xtr-wrap"); const stale = w.cloneNode(true); stale.dataset.xtrOwner = "old"; w.replaceWith(stale); })()`);
  await waitFor(() => page.eval(`document.querySelector("#c1 .xtr-wrap").dataset.xtrOwner !== "old" && document.querySelectorAll("#c1 .xtr-wrap").length === 1`), "stale button replaced");
  check("a button left by an older copy is replaced, not doubled", true);

  await page.eval(`document.querySelector("#c1 .xtr-wrap").remove()`);
  await waitFor(() => page.eval(`${stateOf("c1")} === "saved"`), "button put back");
  check("a button removed by a re-render comes back", true);

  await page.eval(`document.querySelector('#c4 a[href*="/status/"]').setAttribute("href", "/ivan/status/8888888888888888888")`);
  await waitFor(() => page.eval(`document.querySelector("#c4 .xtr-wrap").dataset.xtrId === "8888888888888888888"`), "rebind");
  check("a reused post card follows its new post", (await page.eval(stateOf("c4"))) === "idle");

  await page.eval(`document.querySelector(${JSON.stringify(btn("c4"))}).focus()`);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitFor(() => page.eval(`${stateOf("c4")} === "saved"`), "keyboard add");
  check("works from the keyboard", a.store().items.at(-1).title === "https://x.com/ivan/status/8888888888888888888");
  check("the keyboard did not open the post", (await page.eval(`window.__opened.length`)) === 0);

  await page.eval(`document.body.classList.add("dark")`);
  await waitFor(() => page.eval(`document.documentElement.dataset.xtrDark === "true"`), "dark theme", 4000);
  check("follows X's dark theme", (await page.eval(`getComputedStyle(document.documentElement).getPropertyValue("--xtr-bg").trim()`)) === "rgb(0, 0, 0)");
  check("icon colour follows the theme", await waitFor(() => page.eval(`getComputedStyle(document.querySelector("#c3 .bar svg")).color === document.querySelector("#c2 .xtr-wrap").style.getPropertyValue("--xtr-color")`), "colour", 4000).catch(() => false));

  console.log("new client");
  page = await a.open(`${site}/new.html`);
  await waitFor(() => page.eval(`document.querySelectorAll(".xtr-wrap").length === 2`), "two buttons");
  const n = await page.eval(`(() => {
    const f = document.querySelector("#focused .xtr-wrap"), c = document.querySelector("#card .xtr-wrap");
    return { f: f.dataset.xtrHandle + "/" + f.dataset.xtrId, c: c.dataset.xtrHandle + "/" + c.dataset.xtrId,
      next: f.nextElementSibling?.querySelector("[data-engagement-action]")?.dataset.engagementAction, inRight: f.parentElement.classList.contains("right"),
      quote: !document.querySelector("#q .xtr-wrap") };
  })()`);
  check("focused post found from its reply link, not the quote", n.f === "erin/4444444444444444444", n);
  check("list post found from its card", n.c === "gina/6666666666666666666", n);
  check("sits just before Bookmark", n.next === "bookmark" && n.inRight, n);
  check("no button inside a quoted post", n.quote, n);
  await page.click("#card .xtr-wrap .xtr-btn");
  await waitFor(() => page.eval(`document.querySelector("#card .xtr-btn").dataset.state === "saved"`), "add on new client").catch(async (e) => {
    console.log(await page.eval(`JSON.stringify({ s: document.querySelector("#card .xtr-btn").dataset.state, toast: document.querySelector(".xtr-toast")?.textContent, hit: (() => { const r = document.querySelector("#card .xtr-btn").getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el?.outerHTML.slice(0, 200) + " rect " + JSON.stringify(r); })() })`));
    throw e;
  });
  check("adds on the new client", a.store().items.at(-1).title === "https://x.com/gina/status/6666666666666666666");
  check("the click did not open the card", (await page.eval(`window.__opened.length`)) === 0, await page.eval(`window.__opened`));

  const log = a.log();
  check("the helper logs what the page saw", /saved ok .*diag=bars:3,buttons:2,fit:0\/0\/0,gap:12,layout:classic,missed:1/.test(log), log);

  console.log("popup");
  page = await a.open(`chrome-extension://${extId}/src/popup.html`);
  await waitFor(() => page.eval(`document.getElementById("status").className === "ready"`), "popup ready");
  const ready = await page.eval(`document.getElementById("text").textContent`);
  check("popup says it is ready and names the list", says(ready, "popupReady", "Rappels"), ready);

  console.log("problems");
  const b = await launch("nohost", { access: "full" }, { host: false });
  page = await b.open(`${site}/classic.html`);
  await waitFor(() => page.eval(`document.querySelectorAll(".xtr-wrap").length === 2`), "buttons");
  await page.click(btn("c1"));
  const toastNoHost = await waitFor(() => page.eval(`window.__toasts.at(-1)`), "toast", 15000);
  check("without the helper, says so and links the setup guide", says(toastNoHost, "errNoHost") && says(toastNoHost, "errNoHostAction"), toastNoHost);
  check("and the button goes back to normal", (await page.eval(stateOf("c1"))) === "idle");
  page = await b.open(`chrome-extension://${extId}/src/popup.html`);
  await waitFor(() => page.eval(`document.getElementById("status").className === "problem"`), "popup problem");
  check("popup explains the missing helper", says(await page.eval(`document.getElementById("text").textContent`), "popupNoHost"));

  console.log("update");
  const c = await launch("denied", { access: "notDetermined", grant: false });
  // Developer mode on, as for anyone running an unpacked extension (without it Chrome disables one on reload).
  const settings = await c.open("chrome://extensions");
  await waitFor(() => settings.eval(`!!chrome.developerPrivate`), "extensions page");
  await settings.eval(`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })`);
  // A newer version lands on disk (git pull) while the browser runs.
  const bumped = { ...manifest, version: "9.9.9" };
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(bumped));
  page = await c.open(`${site}/classic.html`);
  await waitFor(() => page.eval(`document.querySelectorAll(".xtr-wrap").length === 2`), "buttons");
  const version = await waitFor(async () => {
    const popup = await c.open(`chrome-extension://${extId}/src/popup.html`);
    await sleep(400);
    return popup.eval(`chrome.runtime.getManifest().version`).then((v) => v === "9.9.9" && v);
  }, "self-update", 20000).catch(() => null);
  check("an unpacked copy updated on disk reloads itself", version === "9.9.9", version);
  await page.send("Page.bringToFront");
  await waitFor(() => page.eval(`document.querySelectorAll(".xtr-wrap").length === 2`), "buttons after update");
  check("the open page keeps one button per post, without a reload", (await page.eval(`document.querySelectorAll(".xtr-wrap").length`)) === 2);
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  await page.click(btn("c1"));
  const toastDenied = await waitFor(() => page.eval(`window.__toasts.at(-1)`), "toast", 15000);
  check("declined access is explained, with a way to fix it", says(toastDenied, "errDenied") && says(toastDenied, "errDeniedAction"), toastDenied);
  check("nothing was added", !(c.store().items || []).length);
} catch (error) {
  failures++;
  console.log(`  FAIL ${error.message}`);
} finally {
  await Promise.all(browsers.map((p) => new Promise((r) => (p.exitCode !== null ? r() : (p.once("exit", r), p.kill())))));
  server.close();
  if (!failures) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else console.log(`  (kept ${tmp})`);
}

console.log(failures ? `\n${failures} of ${count} checks failed` : `\nAll ${count} checks passed`);
process.exit(failures ? 1 : 0);
