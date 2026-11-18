// Checks the extension on the real x.com (signed out), with a JSON file standing
// in for Reminders. Needs the network; not part of CI.
//   node test/live.mjs https://x.com/<user>/status/<id>     SHOTS=<dir> also saves screenshots
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "./cdp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2] || "https://x.com/shadcn/status/2122764933226197406";
const shots = process.env.SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xtr-live-"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
const extId = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join("");
const pw = path.join(os.homedir(), ".playwright-browsers");
const chrome =
  process.env.CHROME ||
  fs
    .readdirSync(pw)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
    .reverse()
    .map((d) => path.join(pw, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))[0];

const profile = path.join(tmp, "profile");
fs.mkdirSync(path.join(profile, "NativeMessagingHosts"), { recursive: true });
fs.writeFileSync(
  path.join(profile, "NativeMessagingHosts/studio.starck.x_to_reminders.json"),
  JSON.stringify({
    name: "studio.starck.x_to_reminders",
    description: "live test",
    path: path.join(root, "host/build/X to Reminders.app/Contents/MacOS/x-to-reminders-host"),
    type: "stdio",
    allowed_origins: [`chrome-extension://${extId}/`],
  }),
);
const store = path.join(tmp, "store.json");
fs.writeFileSync(store, JSON.stringify({ access: "full", list: "Reminders", items: [] }));
const port = await new Promise((r) => {
  const s = net.createServer().listen(0, () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const proc = spawn(
  chrome,
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${path.join(root, "extension")}`,
    `--disable-extensions-except=${path.join(root, "extension")}`,
    "--no-first-run",
    "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "about:blank",
  ],
  { stdio: "ignore", env: { ...process.env, XTR_MOCK_STORE: store, XTR_LOG_DIR: path.join(tmp, "logs") } },
);

let browser;
for (let i = 0; i < 200 && !browser; i++) {
  try {
    browser = await Session.connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  } catch {
    await sleep(200);
  }
}
const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
const send = (m, p) => browser.send(m, p, sessionId);
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
await send("Page.enable");
await send("Page.bringToFront");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 2, mobile: false });

async function setStyle(style) {
  const t = await browser.send("Target.createTarget", { url: `chrome-extension://${extId}/src/popup.html` });
  const s = (await browser.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
  await sleep(500);
  await browser.send("Runtime.evaluate", { expression: `chrome.storage.local.set({ style: ${JSON.stringify(style)} })`, awaitPromise: true }, s);
  await browser.send("Target.closeTarget", { targetId: t.targetId });
}

async function load() {
  await send("Page.navigate", { url });
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    if (await evaluate(`document.querySelectorAll(".xtr-wrap").length > 0`).catch(() => false)) break;
  }
  await sleep(800);
}

async function shot(name, pad = 10) {
  const r = await evaluate(`(() => { const b = document.querySelector("article [role=group]").getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
  const clip = { x: r.x - pad, y: r.y - pad - 4, width: r.w + pad * 2, height: r.h + pad * 2 + 30, scale: 1 };
  const out = await send("Page.captureScreenshot", { format: "png", clip });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(out.data, "base64"));
}

async function hover(selector) {
  const c = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
  return c;
}

await load();
const report = await evaluate(`(() => {
  const wraps = [...document.querySelectorAll(".xtr-wrap")];
  const first = wraps[0];
  const bar = first.closest("[role=group]");
  const r = (el) => el.getBoundingClientRect();
  const mine = r(first.querySelector("svg"));
  const bm = r(bar.querySelector('[data-engagement-action="bookmark"] svg, [data-testid="bookmark"] svg'));
  const share = r(bar.querySelector('[data-engagement-action="share"] svg') || bar.querySelectorAll("svg")[bar.querySelectorAll("svg").length - 1]);
  return {
    title: document.title.slice(0, 60),
    bars: document.querySelectorAll("article [role=group]").length,
    buttons: wraps.length,
    posts: wraps.map((w) => w.dataset.xtrHandle + "/" + w.dataset.xtrId),
    size: [mine.width, bm.width],
    gaps: [bm.left - mine.right, share.left - bm.right],
    centers: [(mine.top + mine.bottom) / 2, (bm.top + bm.bottom) / 2],
  };
})()`);
console.log(JSON.stringify(report, null, 1));

// Does X replace the button after the page loads (hydration)? Watch the first one for 1.6 s.
{
  const seen = [];
  for (let i = 0; i < 8; i++) {
    seen.push(await evaluate(`(() => { const w = document.querySelector("article .xtr-wrap"); if (!w) return "none"; if (w.__probe) return "same"; w.__probe = 1; return "new"; })()`));
    await sleep(200);
  }
  console.log("button identity over 1.6 s:", seen.join(" "));
}

// A real click on the first post's button.
{
  await evaluate(`window.__toasts = []; new MutationObserver(() => { const t = document.querySelector(".xtr-toast.xtr-show"); if (t) window.__toasts.push(t.textContent); }).observe(document.body, { subtree: true, childList: true, attributes: true })`);
  const before = await evaluate("location.href");
  const c = await hover("article .xtr-btn");
  const hit = await evaluate(`document.elementFromPoint(${c.x}, ${c.y})?.closest(".xtr-btn") ? "button" : document.elementFromPoint(${c.x}, ${c.y})?.outerHTML.slice(0, 160)`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await sleep(2500);
  const result = await evaluate(`({ state: document.querySelector("article .xtr-btn").dataset.state, toasts: window.__toasts, href: location.href })`);
  const added = JSON.parse(fs.readFileSync(store, "utf8")).items.map((i) => i.title);
  const log = fs.existsSync(path.join(tmp, "logs/host.log")) ? fs.readFileSync(path.join(tmp, "logs/host.log"), "utf8") : "(no helper log)";
  console.log({ hit, ...result, stayed: result.href === before, added });
  console.log(log.trim());
}

if (shots) {
  // Normal, hover and added, in X's light and dark themes, cropped to the action bar's right end.
  fs.mkdirSync(shots, { recursive: true });
  for (const [i, theme] of ["light", "dark"].entries()) {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await load();
    await evaluate(`for (const el of document.querySelectorAll("body *")) { const cs = getComputedStyle(el); if (cs.position === "fixed" || cs.position === "sticky") el.style.setProperty("display", "none", "important"); }`);
    await evaluate(`(() => { const bars = [...document.querySelectorAll("article [role=group]")].filter((b) => b.querySelector(".xtr-wrap")); window.__bar = bars[i + 1] || bars[0]; window.__bar.scrollIntoView({ block: "center" }); })()`.replace("i + 1", String(i + 1)));
    await sleep(700);
    const clip = await evaluate(`(() => { const b = window.__bar.getBoundingClientRect(), x = b.right - 200; return { x: x + scrollX, y: b.y + scrollY - 12, width: 214, height: b.height + 24, scale: 1 }; })()`);
    const center = await evaluate(`(() => { const r = window.__bar.querySelector(".xtr-btn").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const snap = async (name) => {
      const out = await send("Page.captureScreenshot", { format: "png", clip });
      fs.writeFileSync(path.join(shots, `${theme}-${name}.png`), Buffer.from(out.data, "base64"));
    };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
    await sleep(300);
    await snap("1-normal");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y });
    await sleep(500);
    await snap("2-hover");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: center.x, y: center.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: center.x, y: center.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
    await sleep(800);
    await snap("3-added");
  }
}

await new Promise((r) => (proc.once("exit", r), proc.kill()));
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(0);
