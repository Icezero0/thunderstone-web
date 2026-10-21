"use strict";

// Pure browser-script tests with a minimal DOM boundary. No browser/server is
// started; API payloads come from the same Python read-only projection.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {execFileSync} = require("node:child_process");

const root = path.resolve(__dirname, "..");
const python = path.join(root, ".venv", "Scripts", "python.exe");
const payload = JSON.parse(execFileSync(python, ["-X", "utf8", "-c",
  "import json; from devtools.monster_audit import monster_audit_data; print(json.dumps(monster_audit_data(),ensure_ascii=False))"], {cwd: root, encoding: "utf8", maxBuffer: 8_000_000}));
const source = fs.readFileSync(path.join(root, "web", "monster_audit.js"), "utf8");

async function fixture(saved = null) {
  const nodes = new Map();
  const scrolls = [];
  const downloads = [];
  const blobs = [];
  const storage = new Map(saved ? [["thunderstone.monster-review.v1", JSON.stringify(saved)]] : []);
  function element(id) {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set();
    const node = {id, value: "", checked: false, disabled: false, textContent: "", innerHTML: "", dataset: {},
      events: {}, classList: {contains: value => classes.has(value), toggle: (value, force) => force ? classes.add(value) : classes.delete(value)},
      addEventListener: (name, handler) => { node.events[name] = handler; },
      insertAdjacentHTML: (_, content) => { node.innerHTML += content; },
      getBoundingClientRect: () => ({top: 150}), scrollIntoView: () => scrolls.push(id), showModal: () => { node.open = true; }};
    nodes.set(id, node);
    return node;
  }
  const toolbar = ["search", "scope", "review-filter", "ambiguous-only", "next-pending", "export", "import"].map(element);
  const document = {
    getElementById: id => id.startsWith("TS-") && !element("cards").innerHTML.includes(`id="${id}"`) ? null : element(id),
    querySelectorAll: () => toolbar,
    createElement: () => { const a = {click: () => downloads.push({download: a.download, href: a.href})}; return a; },
  };
  const context = vm.createContext({document, fetch: async () => ({ok: true, json: async () => structuredClone(payload)}),
    localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
    location: {hash: ""}, window: {scrollBy() {}}, URL: {createObjectURL: blob => { blobs.push(blob); return "blob:test"; }, revokeObjectURL() {}},
    Blob, setTimeout, clearTimeout, console});
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return {context, element, scrolls, storage, downloads, blobs, evaluate: code => vm.runInContext(code, context)};
}

function change(f, ability, field, value) {
  const card = ability.split("-A")[0];
  const target = {dataset: {field}, value, closest: selector => selector === "[data-review-id]" ? {dataset: {reviewId: ability}} : f.element(card)};
  f.element(card).dataset.cardId = card;
  f.element("cards").events[field === "note" ? "input" : "change"]({target});
}

test("renders every monster, retains original text safely, and exposes raw DSL", async () => {
  const f = await fixture();
  assert.equal((f.element("cards").innerHTML.match(/class="monster"/g) || []).length, 214);
  assert.equal((f.element("cards").innerHTML.match(/class="ability /g) || []).length, 345);
  assert.match(f.element("cards").innerHTML, /TS-0582-A02/);
  assert.match(f.element("cards").innerHTML, /查看原始运行定义/);
  assert.equal(f.element("search").disabled, false);
});

test("scope filtering keeps all abilities of each matching card visible", async () => {
  const f = await fixture();
  f.element("scope").value = "hand_active";
  f.element("scope").events.change();
  assert.match(f.element("cards").innerHTML, /TS-0494-A01/);
  assert.match(f.element("cards").innerHTML, /TS-0494-A03/);
  assert.doesNotMatch(f.element("cards").innerHTML, /id="TS-0510"/);
  f.element("scope").value = "";
  f.element("search").value = "无缚者";
  f.evaluate("render()");
  assert.equal((f.element("cards").innerHTML.match(/class="monster"/g) || []).length, 1);
});

test("scope corrections stay marked as issues and survive local save/reload", async () => {
  const f = await fixture();
  change(f, "TS-0582-A02", "expected_scope", "battle");
  change(f, "TS-0582-A02", "result", "confirmed");
  assert.equal(f.evaluate("reviews['TS-0582-A02'].result"), "issue");
  change(f, "TS-0582-A02", "note", "<script>alert(1)</script>应为战斗");
  const restored = await fixture(JSON.parse(f.storage.get("thunderstone.monster-review.v1")));
  assert.equal(restored.evaluate("reviews['TS-0582-A02'].result"), "issue");
  assert.match(restored.element("cards").innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(restored.element("cards").innerHTML, /<script>alert/);
});

test("confirming a card advances to the next pending monster without overriding issues", async () => {
  const f = await fixture();
  change(f, "TS-0459-A01", "result", "issue");
  const target = {closest: selector => selector === "[data-confirm-card]" ? {dataset: {confirmCard: "TS-0459"}} : null};
  f.element("cards").events.click({target});
  assert.equal(f.evaluate("reviews['TS-0459-A01'].result"), "issue");
  assert.equal(f.scrolls.at(-1), "TS-0460");
});

test("stale confirmed records return to pending, including after editing only a note", async () => {
  const f = await fixture({"TS-0582-A02": {result: "confirmed", fingerprint: "old-version", note: "previous review"}});
  assert.equal(f.evaluate("itemStatus(reviewItems.get('TS-0582-A02'))"), "pending");
  change(f, "TS-0582-A02", "note", "review again");
  assert.equal(f.evaluate("itemStatus(reviewItems.get('TS-0582-A02'))"), "pending");
  assert.equal(f.evaluate("reviews['TS-0582-A02'].result"), "pending");
});

test("export and import preserve per-ability verdict, symbol and suggestion", async () => {
  const f = await fixture();
  change(f, "TS-0582-A02", "symbol", "present");
  change(f, "TS-0582-A02", "result", "confirmed");
  f.element("export").events.click();
  const exported = JSON.parse(await f.blobs[0].text());
  assert.equal(exported.reviews.length, 1);
  assert.equal(exported.reviews[0].ability_id, "TS-0582-A02");
  assert.equal(exported.reviews[0].symbol, "present");
  assert.equal(exported.reviews[0].result, "confirmed");
  const fresh = await fixture();
  const input = {files: [{size: 1000, text: async () => JSON.stringify(exported)}], value: "review.json"};
  await fresh.element("import").events.change({target: input});
  assert.equal(fresh.evaluate("reviews['TS-0582-A02'].symbol"), "present");
  assert.equal(fresh.evaluate("itemStatus(reviewItems.get('TS-0582-A02'))"), "confirmed");
});
