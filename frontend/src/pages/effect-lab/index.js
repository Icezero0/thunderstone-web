"use strict";

const ui = {
  list: document.querySelector("#case-list"), count: document.querySelector("#case-count"),
  status: document.querySelector("#status"), content: document.querySelector("#case-content"),
  title: document.querySelector("#case-title"), kind: document.querySelector("#case-kind"),
  focus: document.querySelector("#case-focus"), seed: document.querySelector("#case-seed"),
  result: document.querySelector("#case-result"), stepTitle: document.querySelector("#step-title"),
  stepCounter: document.querySelector("#step-counter"), range: document.querySelector("#step-range"),
  timeline: document.querySelector("#timeline"), body: document.querySelector("#step-body"),
  previous: document.querySelector("#previous"), next: document.querySelector("#next"),
  checks: document.querySelector("#checks"), checkCount: document.querySelector("#check-count"),
  dsl: document.querySelector("#dsl"), version: document.querySelector("#rule-version"),
  rerun: document.querySelector("#rerun"),
  coverageSummary: document.querySelector("#coverage-summary"), coverageSearch: document.querySelector("#coverage-search"),
  coverageRows: document.querySelector("#coverage-rows"),
};

let cases = [];
let currentCase = null;
let trace = null;
let stepIndex = 0;
let requestNumber = 0;
let coverageCards = [];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function json(value) { return JSON.stringify(value, null, 2); }

function setStatus(message, error = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle("error", error);
}

function cardChip(card, className = "") {
  const art = /^TS-\d{4}$/.test(card.card_id || "") ?
    `<img src="/cards/${escapeHtml(card.card_id)}.png" alt="" loading="lazy">` : "";
  return `<span class="chip ${className}">${art}<span>${escapeHtml(card.name)}<small>${escapeHtml(card.card_id)} · ${escapeHtml(card.instance_id)}</small></span></span>`;
}

function chips(cards, otherCards = [], differenceClass = "added") {
  if (!cards.length) return '<span class="empty">无</span>';
  const other = new Set(otherCards.map(card => card.instance_id));
  return cards.map(card => cardChip(card, other.has(card.instance_id) ? "" : differenceClass)).join("");
}

function snapshot(view, other, heading, differenceClass) {
  const choice = view.choice;
  return `<section class="snapshot">
    <h4>${escapeHtml(heading)} · ${escapeHtml(view.phase)} / ${escapeHtml(view.subphase)}</h4>
    <dl><div><dt>回合 / 玩家</dt><dd>${view.turn} · ${escapeHtml(view.player)}</dd></div>
    <div><dt>经验</dt><dd>${view.xp}</dd></div><div><dt>临时金币</dt><dd>${view.gold}</dd></div>
    <div><dt>手牌</dt><dd>${view.hand.length}</dd></div><div><dt>牌库</dt><dd>${view.draw_count}</dd></div>
    <div><dt>弃牌堆</dt><dd>${view.discard.length}</dd></div></dl>
    <div class="plain">状态版本 ${view.version} · 行动 ${escapeHtml(view.action ?? "未选")}
    · 战斗修正 ${escapeHtml(json(view.battle_modifiers))}</div>
    <h5>玩家状态</h5><div class="plain">${(view.players || []).map(player => `<span class="${player.eliminated ? "reject" : ""}">${escapeHtml(player.player_id)}：${player.eliminated ? "已淘汰" : "参与中"}</span>`).join(" · ")}</div>
    <details><summary>各玩家手牌与弃牌（实验数据）</summary>${(view.players || []).map(player => `<h5>${escapeHtml(player.player_id)} · 牌库 ${player.draw_count} 张</h5><div class="chips">${chips(player.hand || [])}</div><div class="plain">弃牌</div><div class="chips">${chips(player.discard || [])}</div>`).join("")}</details>
    ${view.end_condition ? `<h5>游戏结算</h5><pre>${escapeHtml(json({condition: view.end_condition, winners: view.result?.winner_ids}))}</pre>` : ""}
    <h5>手牌</h5><div class="chips">${chips(view.hand, other.hand, differenceClass)}</div>
    <h5>弃牌堆</h5><div class="chips">${chips(view.discard, other.discard, differenceClass)}</div>
    <h5>地下城大厅</h5>${(view.halls || []).map(hall => `<div class="plain">${escapeHtml(hall.zone)}</div><div class="chips">${chips(hall.cards, (other.halls || []).find(item => item.zone === hall.zone)?.cards || [], differenceClass)}</div>`).join("")}
    <details><summary>地下城牌顶（实验数据）</summary>${(view.dungeons || []).map(deck => `<div class="plain">${escapeHtml(deck.zone)} · ${deck.count} 张</div><div class="chips">${chips(deck.top, (other.dungeons || []).find(item => item.zone === deck.zone)?.top || [], differenceClass)}</div>`).join("")}</details>
    <h5>已摧毁</h5><div class="chips">${chips(view.destroyed, other.destroyed, differenceClass)}</div>
    <h5>英雄保护与待摧毁状态</h5><div class="plain">${(view.hero_statuses || []).map(card =>
      `${escapeHtml(card.name)} · ${escapeHtml(card.instance_id)}：${[
        ...(card.buffs.length ? ["摧毁改为弃牌（本回合）"] : []),
        ...(card.after_battle ? ["战后处理摧毁"] : []),
        ...(card.turn_end ? ["回合末处理摧毁"] : [])].join("、")}`).join("；") || "无"}</div>
    <h5>待选目标 / 延迟效果</h5><div class="plain">${choice ? choice.candidates.map(card => escapeHtml(card.name) + " " + escapeHtml(card.instance_id)).join("、") : "无"}
    · 排程 ${view.scheduled.length}</div>
    <h5>复制 / 借用 / 附着</h5><div class="plain">${(view.copied_heroes || []).map(card => `${escapeHtml(card.name)}：复制 ${escapeHtml(card.card_ids.join("、"))}，${card.preserve_attack ? "保留原攻击" : "替换原攻击"}`).join("；") || "无复制"}</div>
    <div class="plain">${(view.borrowed_cards || []).map(card => `${escapeHtml(card.name)}：来自 ${escapeHtml(card.owner_player_id)}，${card.when === "after_battle" ? "战后" : "回合末"}归还（摧毁不归还）`).join("；") || "无借用"}</div>
    ${(view.attachments || []).map(record => `<div class="plain">附着于 ${escapeHtml(record.anchor.name)}</div><div class="chips">${chips(record.cards)}</div>`).join("")}
    <details><summary>持续规则与事件监听（${(view.continuous_effects || []).length + (view.listeners || []).length}）</summary><pre>${escapeHtml(json({rules: view.continuous_effects, listeners: view.listeners}))}</pre></details>
    <details><summary>村庄供应牌顶（${view.supply.length} 组）</summary><div class="chips">${view.supply.map(item => cardChip(item.top)).join("") || "无"}</div></details>
  </section>`;
}

function eventText(event) {
  const names = {
    ability_activated: "发动效果", ability_resolved: "效果完成",
    ability_triggered: "时点触发", effect_choice_requested: "等待选择",
    effect_choice_resolved: "已选择", effect_draw: "效果抽牌",
    effect_card_removed: "移除卡牌", effect_card_gained: "获得卡牌",
    effect_resource_changed: "数值变化", effect_scheduled: "延迟执行",
    card_moved: "卡牌移动", cards_drawn: "抽牌", battle_resolved: "战斗结算",
    rule_timing: "规则时点", cards_revealed: "揭示卡牌", card_destroyed: "摧毁卡牌",
    effect_purchase_requested: "效果购买选择", effect_purchase_completed: "效果购买完成",
    turn_passed: "移交回合",
    hero_turn_buff_granted: "英雄获得回合保护", hero_turn_buffs_expired: "回合保护到期",
    card_destruction_replaced: "摧毁改为弃牌",
    effect_value_chosen: "已选择数值或玩家", cards_reordered: "重排牌顶",
    player_eliminated: "玩家淘汰", game_end_triggered: "游戏结束", game_scored: "完成计分",
    hero_abilities_copied: "复制英雄能力", card_borrowed: "借用卡牌", borrowed_card_returned: "归还借用牌",
    response_requested: "等待反应", response_used: "使用反应", response_resolved: "反应结算",
    hero_destruction_prevented: "防止英雄摧毁", card_attached: "卡牌附着", attachment_released: "释放附着卡牌",
    disease_replacement_applied: "疾病获得替代", disease_redirected: "转交疾病",
  };
  return names[event.kind] || event.kind;
}

function renderStep() {
  if (!trace) return;
  const step = trace.steps[stepIndex];
  ui.stepTitle.textContent = step.type === "fixture" ? `测试准备：${step.title}` :
    step.type === "rejected" ? `预期拒绝：${step.title}` : step.title;
  ui.stepCounter.textContent = `${stepIndex + 1} / ${trace.steps.length}`;
  ui.range.max = String(trace.steps.length - 1);
  ui.range.value = String(stepIndex);
  ui.previous.disabled = stepIndex === 0;
  ui.next.disabled = stepIndex === trace.steps.length - 1;
  ui.timeline.innerHTML = trace.steps.map((item, index) =>
    `<button type="button" data-step="${index}" class="${index === stepIndex ? "active" : ""}">${index + 1}. ${escapeHtml(item.title)}</button>`).join("");
  const command = step.command ? `<div class="command-line"><code>${escapeHtml(json(step.command))}</code></div>` :
    '<p class="step-summary">此步建立测试夹具；新增卡牌和数值仅存在于当前内存对局。</p>';
  const choice = step.after.choice;
  const choiceHtml = choice ? `<div class="choice-box"><p>等待 ${escapeHtml(choice.player_id)} 选择 ${escapeHtml(choice.ability_id)}。${step.replay_choice_count ? "点击候选项可重放此选择。" : "本例按预设命令继续；候选项仅供查看。"}</p>${choice.candidates.map((card, index) =>
    step.replay_choice_count ? `<button type="button" data-choice="${index}">${escapeHtml(card.name)} · ${escapeHtml(card.instance_id)}</button>` : `<span class="plain">${escapeHtml(card.name)} · ${escapeHtml(card.instance_id)} </span>`).join("")}</div>` : "";
  const events = step.events.length ? `<ol class="events">${step.events.map(event =>
    `<li><strong>#${event.sequence} ${escapeHtml(eventText(event))}</strong><pre>${escapeHtml(json(event))}</pre></li>`).join("")}</ol>` :
    '<p class="empty">此步没有引擎事件。</p>';
  const nodes = step.effect_trace || [];
  const nodeHtml = nodes.length ? `<ol class="node-trace">${nodes.map(node => {
    const decisions = [
      node.branch ? `分支 ${node.branch}（${node.condition_result}）` : "",
      node.candidate_instance_ids ? `候选 ${node.candidate_instance_ids.length} 张` : "",
      node.repeat_count !== undefined ? `重复 ${node.repeat_count} 次` : "",
      node.payable !== undefined ? `可支付：${node.payable}` : "",
      node.scheduled_event ? `时点 ${node.scheduled_event}` : "",
      node.value_options ? `可选值 ${node.value_options.join("、")}` : "",
    ].filter(Boolean).join(" · ");
    return `<li><strong>${node.index}. ${escapeHtml(node.op)}</strong><span>${escapeHtml(decisions)}</span>
      <details><summary>节点与变量绑定</summary><pre>${escapeHtml(json({node: node.node, bindings: node.bindings}))}</pre></details></li>`;
  }).join("")}</ol>` : '<p class="empty">此命令没有进入效果 DSL。</p>';
  ui.body.innerHTML = `${command}${step.error ? `<p class="reject">拒绝原因：${escapeHtml(step.error)}</p>` : ""}
    ${choiceHtml}<div class="snap-grid">${snapshot(step.before, step.after, "命令前", "removed")}${snapshot(step.after, step.before, "命令后", "added")}</div>
    <h4>效果节点路径（${nodes.length}）</h4>${nodeHtml}
    <h4>引擎事件（${step.events.length}）</h4>${events}
    ${step.legal_commands ? `<details><summary>完成后可提交的命令</summary><pre class="json-block">${escapeHtml(json(step.legal_commands))}</pre></details>` : ""}`;
  for (const button of ui.timeline.querySelectorAll("[data-step]")) {
    button.addEventListener("click", () => { stepIndex = Number(button.dataset.step); renderStep(); });
  }
  for (const button of ui.body.querySelectorAll("[data-choice]")) {
    button.addEventListener("click", () => runCurrent(Number(button.dataset.choice), stepIndex + 1));
  }
}

function renderCaseList() {
  ui.count.textContent = `${cases.length} 个`;
  ui.list.innerHTML = cases.map(item => `<button type="button" role="option" aria-selected="${item.id === currentCase}"
    class="case-item ${item.id === currentCase ? "active" : ""}" data-case="${escapeHtml(item.id)}">
    <strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.kind)} · ${escapeHtml(item.focus)}</small></button>`).join("");
  for (const button of ui.list.querySelectorAll("[data-case]")) {
    button.addEventListener("click", () => { currentCase = button.dataset.case; renderCaseList(); runCurrent(); });
  }
}

function renderCase() {
  ui.content.hidden = false;
  ui.title.textContent = trace.case.title;
  ui.kind.textContent = trace.case.kind;
  ui.kind.classList.toggle("synthetic", trace.case.kind !== "真实卡牌");
  ui.focus.textContent = trace.case.focus;
  ui.seed.textContent = `种子：${trace.seed}`;
  ui.result.textContent = trace.passed ? "全部断言通过" : "存在未通过的断言";
  ui.result.classList.toggle("fail", !trace.passed);
  ui.checkCount.textContent = `${trace.checks.filter(item => item.passed).length} / ${trace.checks.length} 通过`;
  ui.checks.innerHTML = trace.checks.map(item => `<div class="check"><span class="${item.passed ? "ok" : "bad"}">${item.passed ? "✓" : "✕"}</span>
    <span>${escapeHtml(item.title)}${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}</span></div>`).join("");
  ui.version.textContent = trace.ruleset_version.slice(0, 10);
  ui.dsl.textContent = json(trace.abilities);
  renderStep();
}

async function runCurrent(choiceIndex = 0, targetStep = 0) {
  if (!currentCase) return;
  const ownRequest = ++requestNumber;
  setStatus("正在建立对局并运行效果…");
  ui.rerun.disabled = true;
  try {
    const response = await fetch(`/effect-lab/cases/${encodeURIComponent(currentCase)}/run?choice_index=${choiceIndex}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
    if (ownRequest !== requestNumber) return;
    trace = data;
    stepIndex = Math.min(targetStep, trace.steps.length - 1);
    setStatus("");
    renderCase();
  } catch (error) {
    if (ownRequest === requestNumber) setStatus(`案例运行失败：${error.message}`, true);
  } finally {
    if (ownRequest === requestNumber) ui.rerun.disabled = false;
  }
}

ui.previous.addEventListener("click", () => { stepIndex--; renderStep(); });
ui.next.addEventListener("click", () => { stepIndex++; renderStep(); });
ui.range.addEventListener("input", () => { stepIndex = Number(ui.range.value); renderStep(); });
ui.rerun.addEventListener("click", () => runCurrent());

function renderCoverage() {
  const query = ui.coverageSearch.value.trim().toLowerCase();
  ui.coverageRows.innerHTML = coverageCards.filter(card => `${card.card_id} ${card.name} ${card.card_type}`.toLowerCase().includes(query)).map(card =>
    `<tr><td>${escapeHtml(card.card_id)}<br>${escapeHtml(card.name)}</td><td>${escapeHtml(card.card_type)}</td><td>${card.covered_count} / ${card.ability_count}<details><summary>能力 ID</summary>${escapeHtml(card.covered_ability_ids)}${card.pending_ability_ids ? `<p class="reject">待实现：${escapeHtml(card.pending_ability_ids)}</p>` : ""}</details></td><td>${card.status === "COMPLETE" ? "完整覆盖" : escapeHtml(card.status)}<br><code>${escapeHtml(card.test_name)}</code></td></tr>`).join("");
}
ui.coverageSearch.addEventListener("input", renderCoverage);

async function loadCoverage() {
  try {
    const response = await fetch("/effect-lab/coverage");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    coverageCards = data.cards;
    ui.coverageSummary.textContent = `${data.complete} / ${data.total} 张完整覆盖`;
    renderCoverage();
  } catch (error) { ui.coverageSummary.textContent = `读取失败：${error.message}`; }
}

async function initialize() {
  try {
    const response = await fetch("/effect-lab/cases");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    cases = (await response.json()).cases;
    currentCase = cases[0]?.id;
    renderCaseList();
    await runCurrent();
  } catch (error) { setStatus(`无法读取案例：${error.message}`, true); }
}

initialize();
loadCoverage();
