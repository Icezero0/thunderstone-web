"use strict";

const $ = id => document.getElementById(id);
const storageKey = "thunderstone.monster-review.v1";
const statusLabels = {pending: "待审核", confirmed: "已确认", issue: "有问题"};
const scopeColors = {hand_passive: "hand", hand_active: "hand", battle: "battle", hall: "hall"};
let data;
let reviews = {};
let reviewItems = new Map();
let currentCard = null;
let visible = [];
const controls = [...document.querySelectorAll(".toolbar button, .toolbar input, .toolbar select")];
controls.forEach(control => { control.disabled = true; });

function html(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
}

function message(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}

function readSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) reviews = saved;
  } catch (error) { message("本地记录读取失败；请导入之前导出的 JSON 备份。", true); }
}

function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(reviews));
    message("审核记录已保存在本浏览器。可导出 JSON 备份。 ");
    return true;
  } catch (error) {
    message("浏览器无法保存记录；请使用“导出审核记录”备份当前标记。", true);
    return false;
  }
}

function savedFor(item) {
  const value = reviews[item.review_id];
  const applied = item.symbol_review;
  if (applied?.applied_fingerprint === item.fingerprint &&
      (!value?.updated_at || value.updated_at <= applied.applied_at)) {
    return {...(value || {}), result: "confirmed", symbol: applied.symbol, expected_scope: "current",
      fingerprint: item.fingerprint, note: value?.note || applied.note || ""};
  }
  return value && typeof value === "object" ? value : {};
}

function stale(item) {
  const saved = savedFor(item);
  return Boolean(saved.fingerprint && saved.fingerprint !== item.fingerprint);
}

function itemStatus(item) {
  const saved = savedFor(item);
  return !stale(item) && Object.hasOwn(statusLabels, saved.result) ? saved.result : "pending";
}

function itemsFor(card) {
  return card.abilities.length ? card.abilities.map(a => reviewItems.get(a.ability_id)) : [reviewItems.get("card:" + card.card_id)];
}

function cardStatus(card) {
  const states = itemsFor(card).map(itemStatus);
  return states.includes("issue") ? "issue" : states.every(s => s === "confirmed") ? "confirmed" : "pending";
}

function filtered() {
  const search = $("search").value.trim().toLowerCase();
  const scope = $("scope").value;
  const reviewFilter = $("review-filter").value;
  return data.cards.filter(card =>
    (!search || `${card.card_id} ${card.source_card_id} ${card.name} ${card.english_name} ${card.tags.join(" ")} ${card.effect_text}`.toLowerCase().includes(search)) &&
    (!scope || card.abilities.some(a => a.scope_ids.includes(scope))) &&
    (!reviewFilter || cardStatus(card) === reviewFilter) &&
    (!$("ambiguous-only").checked || card.abilities.some(a => a.needs_symbol_check)));
}

function totals() {
  const complete = data.cards.filter(c => cardStatus(c) === "confirmed").length;
  const issues = data.cards.filter(c => cardStatus(c) === "issue").length;
  $("totals").innerHTML = `<span>${data.summary.monsters} 种怪物 · ${data.summary.abilities} 条能力</span><span>${data.summary.symbol_checks} 条无前缀，需核对符号</span><span>人工已确认 ${complete} 种 · 有问题 ${issues} 种 · 待审核 ${data.summary.monsters - complete - issues} 种</span>`;
}

function steps(nodes) {
  return `<ul class="steps">${nodes.map(node => `<li>${html(node.text)}${node.children.length ? steps(node.children) : ""}</li>`).join("")}</ul>`;
}

function options(values, selected) {
  return Object.entries(values).map(([value, label]) => `<option value="${html(value)}" ${value === selected ? "selected" : ""}>${html(label)}</option>`).join("");
}

function reviewForm(item) {
  const saved = savedFor(item);
  const state = itemStatus(item);
  return `<div class="review" data-review-id="${html(item.review_id)}">
    <label>审核结论<select data-field="result" aria-label="${html(item.review_id)} 审核结论">${options(statusLabels, state)}</select></label>
    <label>卡面战利品符号<select data-field="symbol" aria-label="${html(item.review_id)} 战利品符号">${options({unknown: "尚未核对／不确定", present: "有战利品符号", absent: "无战利品符号"}, saved.symbol || "unknown")}</select></label>
    <label>建议生效范围<select data-field="expected_scope" aria-label="${html(item.review_id)} 建议生效范围">${options({current: "沿用当前实现", ...data.scope_options, other: "其他（请备注）"}, saved.expected_scope || "current")}</select></label>
    ${stale(item) ? '<span class="stale">此词条的运行规则已变化，请重新核对。</span>' : ""}
    <label class="note">备注<textarea data-field="note" maxlength="4000" placeholder="例如：左侧有符号，应只在手牌中生效；或记录漏录的词条。">${html(saved.note || "")}</textarea></label>
  </div>`;
}

function abilityView(ability) {
  const item = reviewItems.get(ability.ability_id);
  return `<section class="ability ${ability.needs_symbol_check ? "symbol-check" : ""} is-${itemStatus(item)}">
    <h4>${html(ability.ability_id)}</h4>
    <p class="source-line">${html(ability.source_line || "未关联原文")}</p>
    <div class="badges">${ability.scope_ids.map(scope => `<span class="badge ${scopeColors[scope] || ""}">${html(data.scope_options[scope])}</span>`).join("")}</div>
    <p class="timing">${html(ability.timing)}</p><p class="usage">${html(ability.usage)}</p>
    ${ability.warnings.length ? `<div class="warnings">${ability.warnings.map(w => `<p>△ ${html(w)}</p>`).join("")}</div>` : ""}
    ${steps(ability.steps)}
    ${ability.symbol_review?.resolution ? `<p class="timing">审核处理：${html(ability.symbol_review.resolution)}</p>` : ""}
    <details class="technical"><summary>查看原始运行定义 · ${html(ability.implementation)}</summary><p>绑定状态：${html(ability.binding_status)}。这是当前代码的绑定状态，人工审核结论请在下方记录。</p><pre>${html(JSON.stringify(ability.binding, null, 2))}</pre></details>
    ${reviewForm(item)}
  </section>`;
}

function cardView(card) {
  return `<article class="monster" id="${html(card.card_id)}" data-card-id="${html(card.card_id)}">
    <div class="monster-heading"><div><h3><small>${html(card.card_id)}</small>${html(card.name)}</h3><p class="english-name">${html(card.english_name)}</p></div><span class="badge">${statusLabels[cardStatus(card)]}</span></div>
    <div class="tags">${card.tags.map(tag => `<span class="tag">${html(tag)}</span>`).join("")}</div>
    <div class="card-grid">
      <div class="art"><button class="art-button" type="button" data-zoom="${html(card.card_id)}" aria-label="放大 ${html(card.name)} 卡图"><img src="${html(card.image_url)}" loading="lazy" width="500" height="700" alt="${html(card.card_id)} ${html(card.name)} 卡面"></button><small>点击卡图放大，核对词条左侧的符号。</small>
        <div class="stats">${Object.entries(card.stats).map(([label, value]) => `<div>${html(label)}<strong>${html(value || "—")}</strong></div>`).join("")}</div>
        <div class="source-id">原图编号：${html(card.source_card_id)}</div>
      </div>
      <div>${card.unmapped_lines.length ? `<div class="warnings">原文还有未关联能力的行：${card.unmapped_lines.map(html).join("；")}</div>` : ""}
        ${card.abilities.length ? card.abilities.map(abilityView).join("") : `<div class="no-effects">没有转录的文字能力，请对照卡图确认是否漏录。卡面数值列在图片下方。</div>${reviewForm(reviewItems.get("card:" + card.card_id))}`}
        <div class="card-actions"><span>${card.abilities.length} 条能力 · 当前人工状态：${statusLabels[cardStatus(card)]}</span><button type="button" data-confirm-card="${html(card.card_id)}">确认剩余词条，下一张</button></div>
      </div>
    </div>
  </article>`;
}

function render() {
  visible = filtered();
  totals();
  $("visible-count").textContent = `${visible.length} / ${data.cards.length}`;
  $("index").innerHTML = visible.map(card => `<a href="#${html(card.card_id)}" class="${cardStatus(card)}" data-jump="${html(card.card_id)}">${html(card.card_id)} · ${html(card.name)}<small>${html(card.tags.join(" · "))}</small></a>`).join("");
  $("cards").innerHTML = visible.map(cardView).join("") || '<p class="empty">没有符合筛选条件的怪物。</p>';
}

function jump(id) {
  const target = $(id);
  if (target) { currentCard = id; target.scrollIntoView({block: "start", behavior: "auto"}); }
}

function nextPending(afterId) {
  const start = visible.findIndex(c => c.card_id === afterId);
  const ordered = [...visible.slice(start + 1), ...visible.slice(0, start + 1)];
  return ordered.find(card => card.card_id !== afterId && cardStatus(card) === "pending");
}

function updateRecord(item, values) {
  const previous = savedFor(item);
  const result = stale(item) ? "pending" : previous.result || "pending";
  reviews[item.review_id] = {...previous, result, ...values, fingerprint: item.fingerprint, updated_at: new Date().toISOString()};
}

$("cards").addEventListener("input", event => {
  if (event.target.dataset.field !== "note") return;
  const item = reviewItems.get(event.target.closest("[data-review-id]").dataset.reviewId);
  updateRecord(item, {note: event.target.value});
  persist();
});

$("cards").addEventListener("change", event => {
  const field = event.target.dataset.field;
  if (!field || field === "note") return;
  const item = reviewItems.get(event.target.closest("[data-review-id]").dataset.reviewId);
  const values = {[field]: event.target.value};
  if (field === "expected_scope" && values[field] !== "current") values.result = "issue";
  if (field === "result" && values.result === "confirmed" && (savedFor(item).expected_scope || "current") !== "current") values.result = "issue";
  const article = event.target.closest("[data-card-id]");
  currentCard = article.dataset.cardId;
  const oldTop = article.getBoundingClientRect().top;
  updateRecord(item, values);
  persist();
  render();
  const fresh = $(currentCard);
  if (fresh) window.scrollBy(0, fresh.getBoundingClientRect().top - oldTop);
});

$("cards").addEventListener("click", event => {
  const zoom = event.target.closest("[data-zoom]");
  if (zoom) {
    const card = data.cards.find(c => c.card_id === zoom.dataset.zoom);
    $("large-image").src = card.image_url;
    $("large-image").alt = card.card_id + " " + card.name;
    $("image-caption").textContent = card.card_id + " · " + card.name;
    $("image-dialog").showModal();
    return;
  }
  const confirm = event.target.closest("[data-confirm-card]");
  if (!confirm) return;
  const card = data.cards.find(c => c.card_id === confirm.dataset.confirmCard);
  const next = nextPending(card.card_id);
  for (const item of itemsFor(card)) {
    if (itemStatus(item) === "pending") {
      const expected = savedFor(item).expected_scope || "current";
      updateRecord(item, {result: expected === "current" ? "confirmed" : "issue"});
    }
  }
  persist();
  render();
  if (next) jump(next.card_id);
});

$("index").addEventListener("click", event => {
  const link = event.target.closest("[data-jump]");
  if (link) currentCard = link.dataset.jump;
});

$("cards").addEventListener("focusin", event => { currentCard = event.target.closest("[data-card-id]")?.dataset.cardId || currentCard; });
$("next-pending").addEventListener("click", () => {
  const next = nextPending(currentCard);
  if (next) jump(next.card_id);
  else message("当前筛选范围内没有其他待审核怪物。");
});
for (const id of ["scope", "review-filter", "ambiguous-only"]) $(id).addEventListener("change", render);
let searchTimer;
$("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 180); });

$("export").addEventListener("click", () => {
  const rows = [...reviewItems.values()].filter(item => reviews[item.review_id]).map(item => ({
    review_id: item.review_id, card_id: item.card.card_id, card_name: item.card.name,
    ability_id: item.ability_id || null, source_line: item.source_line || "",
    current_scope_ids: item.scope_ids || [], ...savedFor(item),
  }));
  const output = {schema_version: "thunderstone.monster-review/1", catalog_version: data.catalog_version,
    effects_version: data.effects_version, exported_at: new Date().toISOString(), reviews: rows};
  const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], {type: "application/json;charset=utf-8"}));
  const link = document.createElement("a");
  link.href = url;
  link.download = `monster-review-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("import").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 10_000_000) throw new Error("记录文件超过 10 MB");
    const imported = JSON.parse(await file.text());
    if (imported.schema_version !== "thunderstone.monster-review/1" || !Array.isArray(imported.reviews)) throw new Error("不是怪物审核记录文件");
    const incoming = {};
    let count = 0;
    for (const row of imported.reviews) {
      if (!reviewItems.has(row.review_id)) continue;
      if (!Object.hasOwn(statusLabels, row.result || "pending") || typeof row.fingerprint !== "string") throw new Error("存在无效审核结论或版本标记");
      incoming[row.review_id] = {result: row.result || "pending", fingerprint: row.fingerprint,
        symbol: ["unknown", "present", "absent"].includes(row.symbol) ? row.symbol : "unknown",
        expected_scope: ["current", "other", ...Object.keys(data.scope_options)].includes(row.expected_scope) ? row.expected_scope : "current",
        note: String(row.note || "").slice(0, 4000), updated_at: row.updated_at};
      count++;
    }
    reviews = {...reviews, ...incoming};
    const saved = persist();
    render();
    if (saved) message(`已导入 ${count} 条审核记录；绑定版本不同的词条已恢复为待审核。`);
  } catch (error) { message(`导入失败：${error.message}`, true); }
  finally { event.target.value = ""; }
});

async function initialize() {
  try {
    const response = await fetch("/monster-audit/data");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
    for (const card of data.cards) {
      for (const ability of card.abilities) reviewItems.set(ability.ability_id, {...ability, review_id: ability.ability_id, card});
      if (!card.abilities.length) reviewItems.set("card:" + card.card_id, {review_id: "card:" + card.card_id, card,
        fingerprint: card.fingerprint, symbol_review: card.symbol_review});
    }
    $("scope").insertAdjacentHTML("beforeend", options(data.scope_options, ""));
    readSaved();
    render();
    controls.forEach(control => { control.disabled = false; });
    if (!$("status").classList.contains("error")) message(data.summary.symbol_checks
      ? "卡面符号尚需人工核对；可从无前缀词条开始。"
      : "本轮战利品符号审核已应用；原备注和处理结果可在词条中查看。");
    if (location.hash) jump(decodeURIComponent(location.hash.slice(1)));
  } catch (error) { message(`读取失败：${error.message}。更新代码后请重新启动现有面板。`, true); }
}

initialize();
