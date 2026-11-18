// Talks to the built helper over the native messaging protocol, with a JSON
// file standing in for Reminders (XTR_MOCK_STORE). Never touches real Reminders.
//   node test/host.test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "host/build/X to Reminders.app/Contents/MacOS/x-to-reminders-host");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xtr-host-"));
let failures = 0;
let count = 0;

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}

export function call(message, store, raw) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { env: { ...process.env, XTR_MOCK_STORE: store, HOME: tmp } });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", reject);
    child.on("close", () => {
      const out = Buffer.concat(chunks);
      if (out.length < 4) return resolve({ raw: out.toString() });
      const len = out.readUInt32LE(0);
      resolve(JSON.parse(out.subarray(4, 4 + len).toString()));
    });
    child.stdin.end(raw ?? frame(message));
  });
}

function check(name, cond, detail) {
  count++;
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

function newStore(state) {
  const file = path.join(tmp, `store-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(state));
  return file;
}
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

if (!fs.existsSync(bin)) {
  console.error(`Build the helper first: sh host/build.sh`);
  process.exit(1);
}

console.log("helper");
{
  const store = newStore({ access: "notDetermined", grant: true, list: "Rappels" });
  let r = await call({ op: "ping" }, store);
  check("ping answers with its version and access", r.ok && r.version && r.access === "notDetermined", r);
  check("ping does not name a list before access", !("list" in r), r);

  r = await call({ op: "saved" }, store);
  check("saved never asks for access", r.ok === false && r.error === "no-access", r);
  check("saved left access undecided", read(store).access === "notDetermined", read(store));

  r = await call({ op: "add", url: "https://example.com/a/status/123456789" }, store);
  check("add refuses a link that is not a post", r.error === "bad-url", r);
  r = await call({ op: "add", url: "https://x.com/settings/status/123" }, store);
  check("add refuses a short id", r.error === "bad-url", r);

  r = await call({ op: "add", url: "https://twitter.com/SoMe_One/status/1922807280198463986/photo/1?s=20&t=abc" }, store);
  check("first add asks for access and adds", r.ok && r.status === "added" && r.list === "Rappels", r);
  const items = read(store).items;
  check("title is the clean x.com link", items.length === 1 && items[0].title === "https://x.com/SoMe_One/status/1922807280198463986", items);
  check("access is now granted", read(store).access === "full");

  r = await call({ op: "add", url: "https://x.com/some_one/status/1922807280198463986?a=H7A5&s=20" }, store);
  check("same post again is not added twice", r.ok && r.status === "exists" && read(store).items.length === 1, r);

  r = await call({ op: "ping" }, store);
  check("ping names the list once granted", r.list === "Rappels", r);

  r = await call({ op: "saved", diag: { layout: "classic", bars: 3 } }, store);
  check("saved lists open posts with their list", r.ok && r.ids["1922807280198463986"] === "Rappels", r);
}

console.log("existing reminders");
{
  const store = newStore({
    access: "full",
    list: "Rappels",
    items: [
      { title: "Saas idea https://x.com/floriandarroman/status/2122835903324598614?a=acC&s=20", list: "IDEAS" },
      { title: "Read later", notes: "https://twitter.com/i/web/status/2122764933226197406", list: "Books" },
      { title: "https://x.com/old/status/2000000000000000001", list: "Rappels", done: true },
    ],
  });
  let r = await call({ op: "saved" }, store);
  check("finds posts in titles and notes, any list", r.ids["2122835903324598614"] === "IDEAS" && r.ids["2122764933226197406"] === "Books", r);
  check("ignores completed reminders", !("2000000000000000001" in r.ids), r);

  r = await call({ op: "add", url: "https://x.com/shadcn/status/2122764933226197406" }, store);
  check("a post already in another list is reported there", r.status === "exists" && r.list === "Books", r);

  r = await call({ op: "add", url: "https://x.com/old/status/2000000000000000001" }, store);
  check("a post whose reminder was completed can be added again", r.status === "added", r);
  check("nothing was changed or removed", read(store).items.length === 4 && read(store).items[2].done === true, read(store));
}

console.log("refusals and failures");
{
  const store = newStore({ access: "notDetermined", grant: false });
  let r = await call({ op: "add", url: "https://x.com/a/status/1234567890" }, store);
  check("declined permission reports denied", r.ok === false && r.error === "denied", r);
  r = await call({ op: "add", url: "https://x.com/a/status/1234567890" }, store);
  check("denied stays denied without asking again", r.error === "denied" && read(store).access === "denied", r);

  const failing = newStore({ access: "full", failAdd: "disk full" });
  r = await call({ op: "add", url: "https://x.com/a/status/1234567890" }, failing);
  check("a failed save is reported, not hidden", r.ok === false && r.error === "save-failed", r);

  r = await call(null, store, Buffer.from([0xff, 0xff, 0xff, 0x7f, 0x41]));
  check("a malformed message gets an error answer", r.ok === false && r.error === "bad-message", r);
  r = await call({ op: "nope" }, store);
  check("an unknown request gets an error answer", r.error === "unknown-op", r);
  r = await call({ op: "openSettings" }, store);
  check("openSettings answers (and opens nothing in tests)", r.ok === true, r);

  const log = fs.readFileSync(path.join(tmp, "Library/Logs/X to Reminders/host.log"), "utf8");
  check("every request is logged", log.split("\n").filter(Boolean).length >= 18 && /diag=bars:3,layout:classic/.test(log), log.slice(-400));
}

if (!failures) fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${count} checks failed` : `\nAll ${count} checks passed`);
process.exit(failures ? 1 : 0);
