"use strict";

const STORAGE_KEY = "thunderstone-rules-draft-v7";
const LEGACY_STORAGE_KEYS = ["thunderstone-rules-draft-v6", "thunderstone-rules-draft-v5", "thunderstone-rules-draft-v4", "thunderstone-rules-draft-v3"];
const kinds = ["village", "hero", "monster"];
const kindNames = { village: "村庄", hero: "英雄", monster: "怪物" };
const extraKinds = ["guardian", "environment", "trap", "treasure"];
const extraNames = { guardian: "守护者", environment: "环境", trap: "陷阱", treasure: "宝藏" };
const multiplierFields = [
  ["multiplier-village", "village"],
  ["multiplier-hero", "hero"],
  ["multiplier-monster", "monster"],
];
let catalog;
let state;
let activeKind = "village";
let searchText = "";
let trimNotice = "";
let activeExtraKind = "guardian";
let extraSearchText = "";
let setupResult = null;
let pendingSetupRequest = null;
let setupRunToken = 0;

const $ = selector => document.querySelector(selector);

function defaultState() {
  return {
    mode: "classic",
    counts: { village_groups: 8, hero_groups: 4, monster_groups: 3 },
    selection: {
      village: { fixed_randomizer_ids: [] },
      hero: { fixed_randomizer_ids: [] },
      monster: { fixed_randomizer_ids: [] },
      dungeon_features: { mode: "classic_random" },
      guardian: { random_count: 0, fixed_card_ids: [] },
      environment: { random_count: 0, fixed_card_ids: [] },
      trap: { random_count: 0, fixed_group_ids: [] },
      treasure: { random_count: 0, fixed_group_ids: [] },
      thunderstone: { fixed_card_ids: [] },
    },
    instance_multipliers: { village: 1, hero: 1, monster: 1 },
  };
}

function restoreState() {
  try {
    const stored = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]
      .map(key => localStorage.getItem(key)).find(value => value);
    const saved = JSON.parse(stored);
    const draft = saved?.state;
    if (draft?.selection && !draft.selection.guardian) {
      const oldEnvironment = draft.selection.environment?.fixed_card_id;
      for (const kind of ["guardian", "environment"]) {
        draft.selection[kind] = { random_count: 0, fixed_card_ids: [] };
      }
      for (const kind of ["trap", "treasure"]) {
        draft.selection[kind] = { random_count: 0, fixed_group_ids: [] };
      }
      if (typeof oldEnvironment === "string") {
        draft.selection.environment.fixed_card_ids = [oldEnvironment];
      }
      delete draft.selection.dungeon_features;
    }
    for (const kind of ["trap", "treasure"]) {
      const choice = draft?.selection?.[kind];
      if (Array.isArray(choice?.fixed_card_ids) && !choice.fixed_group_ids) {
        choice.fixed_group_ids = [...new Set(choice.fixed_card_ids.map(id =>
          catalog.dungeon_groups[kind].find(group => group.members.includes(id))?.id)
          .filter(Boolean))];
        delete choice.fixed_card_ids;
      }
    }
    if (draft?.selection && !draft.selection.dungeon_features) {
      const hasManualChoices = extraKinds.some(kind => {
        const choice = draft.selection[kind];
        const key = kind === "trap" || kind === "treasure" ? "fixed_group_ids" : "fixed_card_ids";
        return choice?.random_count > 0 || choice?.[key]?.length > 0;
      });
      draft.selection.dungeon_features = { mode: hasManualChoices ? "manual" : "classic_random" };
    }
    if (draft?.selection?.thunderstone && !Array.isArray(draft.selection.thunderstone.fixed_card_ids)) {
      const oldStone = draft.selection.thunderstone.fixed_card_id;
      draft.selection.thunderstone = { fixed_card_ids: typeof oldStone === "string" ? [oldStone] : [] };
    }
    if (saved?.catalog_hash === catalog.catalog_hash && draft?.mode === "classic"
        && draft.counts && draft.selection && draft.instance_multipliers
        && ["classic_random", "manual"].includes(draft.selection.dungeon_features?.mode)
        && kinds.every(kind => Array.isArray(draft.selection[kind]?.fixed_randomizer_ids))
        && ["guardian", "environment"].every(kind => Number.isInteger(draft.selection[kind]?.random_count)
          && Array.isArray(draft.selection[kind]?.fixed_card_ids))
        && ["trap", "treasure"].every(kind => Number.isInteger(draft.selection[kind]?.random_count)
          && Array.isArray(draft.selection[kind]?.fixed_group_ids))
        && Array.isArray(draft.selection.thunderstone?.fixed_card_ids)) {
      for (const kind of kinds) {
        const max = catalog.groups[kind].length;
        const value = draft.counts[kind + "_groups"];
        draft.counts[kind + "_groups"] = Number.isInteger(value) ? Math.max(0, Math.min(value, max)) : 0;
        draft.selection[kind].fixed_randomizer_ids = draft.selection[kind].fixed_randomizer_ids
          .slice(0, Math.max(0, Math.min(max, effectiveCounts(draft)[kind])));
      }
      for (const kind of extraKinds) {
        const grouped = kind === "trap" || kind === "treasure";
        const options = grouped ? catalog.dungeon_groups[kind] : catalog.dungeon_cards[kind];
        const key = grouped ? "fixed_group_ids" : "fixed_card_ids";
        const available = new Set(options.map(option => option.id));
        const fixed = [...new Set(draft.selection[kind][key])]
          .filter(id => available.has(id));
        draft.selection[kind][key] = kind === "environment" ? fixed.slice(0, 1) : fixed;
        const limit = kind === "environment" ? 1 : available.size;
        draft.selection[kind].random_count = Math.max(0, Math.min(
          draft.selection[kind].random_count, limit - draft.selection[kind][key].length));
      }
      if (draft.selection.dungeon_features.mode === "manual"
          && draft.selection.environment.fixed_card_ids[0] === "TS-0199") {
        draft.selection.guardian.fixed_card_ids = draft.selection.guardian.fixed_card_ids
          .filter(id => id !== "TS-0683");
        draft.selection.guardian.random_count = Math.min(
          draft.selection.guardian.random_count,
          catalog.dungeon_cards.guardian.length - 1 - draft.selection.guardian.fixed_card_ids.length);
      }
      const stoneIds = new Set(catalog.thunderstones.map(card => card.id));
      draft.selection.thunderstone.fixed_card_ids = [...new Set(
        draft.selection.thunderstone.fixed_card_ids)].filter(id => stoneIds.has(id)).slice(0, 2);
      return draft;
    }
  } catch (_) { /* A broken browser-local draft is discarded. */ }
  return defaultState();
}

function textSpan(parent, className, content) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = content;
  parent.append(element);
  return element;
}

function setDraftChanged() {
  clearSetupPreview("规则配置已修改，请重新生成本局。");
  const badge = $("#validation-badge");
  badge.textContent = "待预检";
  badge.className = "validation-badge";
  $("#validation-errors").replaceChildren();
  refresh();
}

function environmentRule(config = state) {
  const environmentId = config.selection.dungeon_features.mode === "manual"
    ? config.selection.environment.fixed_card_ids[0] : null;
  return catalog.environment_rules[environmentId] || null;
}

function thunderstoneTarget() {
  return environmentRule()?.thunderstone_target || 1;
}

function fixedThunderstoneIds() {
  if (environmentRule()?.scenario === "banishing_ritual") {
    return catalog.thunderstones.map(card => card.id);
  }
  return state.selection.thunderstone.fixed_card_ids.slice(0, thunderstoneTarget());
}

function effectiveCounts(config = state) {
  const result = Object.fromEntries(kinds.map(kind => [kind, config.counts[kind + "_groups"]]));
  const rule = environmentRule(config);
  for (const [kind, delta] of Object.entries(rule?.count_delta || {})) result[kind] += delta;
  Object.assign(result, rule?.count_override || {});
  return result;
}

function enginePayload() {
  const payload = JSON.parse(JSON.stringify(state));
  if (payload.selection.dungeon_features.mode === "classic_random") {
    for (const kind of extraKinds) {
      const key = kind === "trap" || kind === "treasure" ? "fixed_group_ids" : "fixed_card_ids";
      payload.selection[kind] = { random_count: 0, [key]: [] };
    }
  }
  payload.selection.thunderstone.fixed_card_ids = fixedThunderstoneIds();
  if (environmentRule()?.scenario === "banishing_ritual") {
    payload.selection.guardian.fixed_card_ids = [...new Set([
      ...payload.selection.guardian.fixed_card_ids, "TS-0683",
    ])];
  }
  return payload;
}

function refresh() {
  renderCounts();
  renderTabs();
  renderGroups();
  renderFeatureMode();
  renderExtraTabs();
  renderExtraCards();
  renderScenarioNote();
  renderMultipliers();
  renderSummary();
  $("#json-output").value = JSON.stringify(enginePayload(), null, 2);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ catalog_hash: catalog.catalog_hash, state })); }
  catch (_) { /* Local storage is optional. */ }
}

function renderCounts() {
  const effective = effectiveCounts();
  const rule = environmentRule();
  for (const kind of kinds) {
    const input = $("#count-" + kind);
    const base = state.counts[kind + "_groups"];
    const delta = rule?.count_delta?.[kind] || 0;
    const fixed = rule?.count_override?.[kind] !== undefined;
    const available = catalog.groups[kind].length;
    input.value = effective[kind];
    input.disabled = fixed;
    input.min = Math.max(0, delta);
    input.max = Math.min(available, available + delta);
    const adjustment = $("#" + kind + "-adjustment");
    adjustment.textContent = fixed ? "固定" : delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : "";
    adjustment.className = "count-adjustment" + (fixed ? " active fixed"
      : delta > 0 ? " active increase" : delta < 0 ? " active decrease" : "");
    const changed = effective[kind] !== state.counts[kind + "_groups"];
    $("#" + kind + "-availability").textContent = changed
      ? `基础 ${base} 组 · 目录共 ${available} 组`
      : `目录共 ${available} 组`;
    input.title = fixed ? "此环境固定该类别的实际组数；切换环境可恢复基础设定"
      : delta ? "显示环境调整后的实际组数" : "";
  }
}

function renderTabs() {
  for (const button of document.querySelectorAll(".group-tabs .tab")) {
    const selected = button.dataset.kind === activeKind;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  }
  for (const kind of kinds) {
    $("#tab-count-" + kind).textContent = state.selection[kind].fixed_randomizer_ids.length;
  }
  $("#tab-count-thunderstone").textContent = fixedThunderstoneIds().length;
}

function renderGroups() {
  const list = $("#group-list");
  list.replaceChildren();
  if (activeKind === "thunderstone") {
    renderThunderstoneChoices(list);
    return;
  }
  const selected = new Set(state.selection[activeKind].fixed_randomizer_ids);
  const target = effectiveCounts()[activeKind];
  $("#group-hint").textContent = `已指定 ${selected.size} / ${target} 组 · 未指定的组将随机抽取。${trimNotice}`;
  const groups = catalog.groups[activeKind].filter(group =>
    `${group.id} ${group.name}`.toLowerCase().includes(searchText));
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "没有符合搜索条件的卡组。";
    list.append(empty);
    return;
  }
  for (const group of groups) {
    const isSelected = selected.has(group.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "group-option" + (isSelected ? " selected" : "");
    button.disabled = !isSelected && selected.size >= target;
    button.setAttribute("aria-pressed", String(isSelected));
    const image = document.createElement("img");
    image.src = group.image;
    image.alt = "";
    image.loading = "lazy";
    const copy = document.createElement("span");
    copy.className = "group-text";
    textSpan(copy, "group-name", group.name);
    textSpan(copy, "group-meta", `${group.id} · ${group.members.length} 种牌`);
    button.append(image, copy);
    textSpan(button, "checkmark", "✓");
    button.addEventListener("click", () => {
      const ids = state.selection[activeKind].fixed_randomizer_ids;
      if (!isSelected && ids.length >= target) return;
      state.selection[activeKind].fixed_randomizer_ids = isSelected
        ? ids.filter(id => id !== group.id) : [...ids, group.id];
      trimNotice = "";
      setDraftChanged();
    });
    list.append(button);
  }
}

function makeRandomChoice(label, detail, selected, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "group-option random-choice" + (selected ? " selected" : "");
  button.setAttribute("aria-pressed", String(selected));
  const symbol = textSpan(button, "random-symbol", "?");
  symbol.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "group-text";
  textSpan(copy, "group-name", label);
  textSpan(copy, "group-meta", detail);
  button.append(copy);
  textSpan(button, "checkmark", "✓");
  button.addEventListener("click", onClick);
  return button;
}

function renderThunderstoneChoices(list) {
  const fixed = fixedThunderstoneIds();
  const target = thunderstoneTarget();
  const forced = environmentRule()?.scenario === "banishing_ritual";
  $("#group-hint").textContent = forced
    ? "放逐仪式强制选入全部 7 张雷霆之石。"
    : `已固定 ${fixed.length} / ${target} 张 · 其余 ${target - fixed.length} 张随机抽取。`;
  const random = makeRandomChoice("随机雷霆之石", forced
    ? "放逐仪式已固定全部雷霆之石"
    : `随机补足剩余 ${target - fixed.length} 张`, !forced && fixed.length < target, () => {
    state.selection.thunderstone.fixed_card_ids = [];
    setDraftChanged();
  });
  random.disabled = forced;
  list.append(random);
  for (const card of catalog.thunderstones.filter(card =>
    `${card.id} ${card.name}`.toLowerCase().includes(searchText))) {
    const isSelected = fixed.includes(card.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "group-option" + (isSelected ? " selected" : "");
    button.disabled = forced || (!isSelected && target > 1 && fixed.length >= target);
    button.setAttribute("aria-pressed", String(isSelected));
    const image = document.createElement("img");
    image.src = card.image;
    image.alt = "";
    image.loading = "lazy";
    const copy = document.createElement("span");
    copy.className = "group-text";
    textSpan(copy, "group-name", card.name);
    textSpan(copy, "group-meta", card.id);
    button.append(image, copy);
    textSpan(button, "checkmark", "✓");
    button.addEventListener("click", () => {
      if (target === 1) {
        state.selection.thunderstone.fixed_card_ids = isSelected ? [] : [card.id];
      } else {
        state.selection.thunderstone.fixed_card_ids = isSelected
          ? fixed.filter(id => id !== card.id) : [...fixed, card.id];
      }
      setDraftChanged();
    });
    list.append(button);
  }
}

function renderExtraTabs() {
  for (const button of document.querySelectorAll(".extra-tab")) {
    const kind = button.dataset.extraKind;
    const selected = kind === activeExtraKind;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    const choice = state.selection[kind];
    const key = kind === "trap" || kind === "treasure" ? "fixed_group_ids" : "fixed_card_ids";
    const autoGuardian = kind === "guardian" && environmentRule()?.scenario === "banishing_ritual" ? 1 : 0;
    $("#extra-count-" + kind).textContent = choice[key].length + choice.random_count + autoGuardian;
  }
}

function renderFeatureMode() {
  const random = state.selection.dungeon_features.mode === "classic_random";
  $("#feature-random").checked = random;
  $("#manual-feature-panel").hidden = random;
}

function renderScenarioNote() {
  const note = $("#scenario-note");
  const rule = environmentRule();
  if (rule) {
    note.textContent = rule.note;
  } else if (state.selection.dungeon_features.mode === "classic_random") {
    note.textContent = "随机抽出的环境可能改变村庄、英雄或怪物组数，并可能启用双地下城或放逐仪式规则。";
  } else if (state.selection.environment.random_count === 1) {
    note.textContent = "随机环境的组数与场景效果将在抽出具体环境后确定。";
  } else {
    note.textContent = "";
  }
  note.hidden = !note.textContent;
}

function renderExtraCards() {
  const kind = activeExtraKind;
  const choice = state.selection[kind];
  const grouped = kind === "trap" || kind === "treasure";
  const cards = grouped ? catalog.dungeon_groups[kind] : catalog.dungeon_cards[kind];
  const autoGuardian = kind === "guardian" && environmentRule()?.scenario === "banishing_ritual";
  const key = grouped ? "fixed_group_ids" : "fixed_card_ids";
  const selected = new Set([...choice[key], ...(autoGuardian ? ["TS-0683"] : [])]);
  const limit = kind === "environment" ? 1 : cards.length;
  const unit = grouped ? "组" : "种";
  const list = $("#extra-list");
  list.replaceChildren();
  $("#extra-hint").textContent = `随机 ${choice.random_count} ${unit} · 固定 ${selected.size} ${unit} · 可选 ${cards.length} ${unit}${kind === "environment" ? " · 环境最多一种" : ""}${autoGuardian ? " · 末日之心由场景强制加入" : ""}。手动模式不抽取特征设置牌。`;

  if (kind === "environment") {
    list.append(makeRandomChoice("随机环境", "额外随机抽取一种环境", choice.random_count === 1, () => {
      choice.random_count = choice.random_count ? 0 : 1;
      if (choice.random_count) choice.fixed_card_ids = [];
      setDraftChanged();
    }));
  } else {
    const randomTile = document.createElement("div");
    randomTile.className = "random-option" + (choice.random_count ? " selected" : "");
    const randomButton = document.createElement("button");
    randomButton.type = "button";
    randomButton.className = "random-trigger";
    randomButton.disabled = !choice.random_count && limit - selected.size === 0;
    randomButton.setAttribute("aria-pressed", String(choice.random_count > 0));
    const symbol = textSpan(randomButton, "random-symbol", "?");
    symbol.setAttribute("aria-hidden", "true");
    const randomText = document.createElement("span");
    randomText.className = "group-text";
    textSpan(randomText, "group-name", `随机${extraNames[kind]}${grouped ? "组" : ""}`);
    textSpan(randomText, "group-meta", `额外抽取${unit}数`);
    randomButton.append(randomText);
    randomButton.addEventListener("click", () => {
      choice.random_count = choice.random_count ? 0 : 1;
      setDraftChanged();
    });
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = String(limit - selected.size);
    input.step = "1";
    input.inputMode = "numeric";
    input.value = String(choice.random_count);
    input.setAttribute("aria-label", `额外随机${extraNames[kind]}${unit}数`);
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (!Number.isInteger(value)) { input.value = String(choice.random_count); return; }
      choice.random_count = Math.max(0, Math.min(value, limit - selected.size));
      setDraftChanged();
    });
    randomTile.append(randomButton, input);
    list.append(randomTile);
  }

  const visible = cards.filter(card =>
    `${card.id} ${card.name} ${card.tags || ""} ${(card.member_names || []).join(" ")}`
      .toLowerCase().includes(extraSearchText));
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "没有符合搜索条件的卡牌。";
    list.append(empty);
  }
  for (const card of visible) {
    const isSelected = selected.has(card.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "group-option" + (isSelected ? " selected" : "");
    button.disabled = (autoGuardian && card.id === "TS-0683")
      || (kind !== "environment" && !isSelected
        && selected.size + choice.random_count >= limit);
    button.setAttribute("aria-pressed", String(isSelected));
    const preview = document.createElement("span");
    preview.className = grouped ? "group-preview" : "single-preview";
    for (const [index, source] of (grouped ? card.images : [card.image]).entries()) {
      const image = document.createElement("img");
      image.src = source;
      image.alt = "";
      image.loading = "lazy";
      if (grouped) image.style.left = `${index * 7}px`;
      preview.append(image);
    }
    const copy = document.createElement("span");
    copy.className = "group-text";
    textSpan(copy, "group-name", card.name);
    textSpan(copy, "group-meta", autoGuardian && card.id === "TS-0683"
      ? "场景强制选中"
      : grouped ? `${card.members.length} 种牌 · ${card.member_names.join("、")}`
        : `${card.id} · 默认 ${card.copy_count} 张`);
    if (grouped) button.title = card.member_names.join("、");
    button.append(preview, copy);
    textSpan(button, "checkmark", "✓");
    button.addEventListener("click", () => {
      const ids = choice[key];
      if (kind === "environment") {
        choice[key] = isSelected ? [] : [card.id];
        choice.random_count = 0;
        if (card.id === "TS-0199" && !isSelected) {
          const guardian = state.selection.guardian;
          guardian.fixed_card_ids = guardian.fixed_card_ids.filter(id => id !== "TS-0683");
          guardian.random_count = Math.min(guardian.random_count,
            catalog.dungeon_cards.guardian.length - 1 - guardian.fixed_card_ids.length);
        }
      } else {
        if (!isSelected && selected.size + choice.random_count >= limit) return;
        choice[key] = isSelected ? ids.filter(id => id !== card.id) : [...ids, card.id];
      }
      setDraftChanged();
    });
    list.append(button);
  }
}

function multiplierValue(field) {
  return state.instance_multipliers[field[1]];
}

function renderMultipliers() {
  for (const field of multiplierFields) {
    const select = $("#" + field[0]);
    select.replaceChildren();
    for (let value = 1; value <= 5; value++) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `×${value}`;
      select.append(option);
    }
    select.value = String(multiplierValue(field));
  }
}

function renderSummary() {
  const summary = $("#summary");
  summary.replaceChildren();
  const multipliers = state.instance_multipliers;
  const effective = effectiveCounts();
  const manual = state.selection.dungeon_features.mode === "manual";
  const lines = [
    ["游戏模式", "经典"],
    ...kinds.map(kind => [kindNames[kind] + "组", `${state.selection[kind].fixed_randomizer_ids.length} 固定 / ${effective[kind]} 实际目标`]),
    ["地下城特征", manual ? "手动选择" : "经典随机"],
    ...(manual ? extraKinds.map(kind => {
      const key = kind === "trap" || kind === "treasure" ? "fixed_group_ids" : "fixed_card_ids";
      const unit = kind === "trap" || kind === "treasure" ? "组" : "种";
      const auto = kind === "guardian" && environmentRule()?.scenario === "banishing_ritual" ? 1 : 0;
      return [extraNames[kind], `${state.selection[kind][key].length + auto} ${unit}固定 / ${state.selection[kind].random_count} ${unit}随机`];
    }) : []),
    ["雷霆之石", `${fixedThunderstoneIds().length} 固定 / ${thunderstoneTarget()} 目标`],
    ["村庄 / 英雄 / 怪物倍率", `×${multipliers.village} / ×${multipliers.hero} / ×${multipliers.monster}`],
  ];
  for (const [name, value] of lines) {
    const row = document.createElement("div");
    row.className = "summary-line";
    textSpan(row, "", name);
    const strong = document.createElement("strong");
    strong.textContent = value;
    row.append(strong);
    summary.append(row);
  }
}

async function validate() {
  const badge = $("#validation-badge");
  badge.textContent = "预检中";
  const submitted = JSON.stringify(enginePayload());
  try {
    const response = await fetch("/api/v1/validate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: submitted,
    });
    const result = await response.json();
    if (JSON.stringify(enginePayload()) !== submitted) return;
    badge.textContent = result.valid ? "参数有效" : `${result.errors.length} 项待修改`;
    badge.className = "validation-badge " + (result.valid ? "ok" : "bad");
    const box = $("#validation-errors");
    box.replaceChildren();
    if (!result.valid) {
      const list = document.createElement("ul");
      for (const error of result.errors) {
        const item = document.createElement("li");
        item.textContent = `${error.path}：${error.message}`;
        list.append(item);
      }
      box.append(list);
    }
  } catch (_) {
    badge.textContent = "预检失败";
    badge.className = "validation-badge bad";
    $("#validation-errors").textContent = "无法连接本地配置服务。";
  }
}

function clearSetupPreview(message = "填写参数后生成，即可查看选中的牌组和初始牌区。") {
  setupRunToken += 1;
  setupResult = null;
  pendingSetupRequest = null;
  $("#setup-choice").hidden = true;
  $("#setup-choice").replaceChildren();
  $("#setup-result").hidden = true;
  $("#setup-result").replaceChildren();
  $("#download-setup").hidden = true;
  $("#generate-setup").disabled = false;
  const status = $("#setup-status");
  status.textContent = message;
  status.className = "setup-status";
}

function previewPlayers() {
  return $("#setup-players").value.split(/[,，\n]+/).map(value => value.trim()).filter(Boolean);
}

function renderFirstPlayerChoices() {
  const select = $("#setup-first-player");
  const previous = select.value;
  select.replaceChildren();
  select.append(new Option("随机", ""));
  for (const player of previewPlayers()) select.append(new Option(player, player));
  select.value = previewPlayers().includes(previous) ? previous : "";
}

function previewRequest() {
  const players = previewPlayers();
  const seed = $("#setup-seed").value.trim();
  if (!players.length || new Set(players).size !== players.length
      || players.some(player => player.includes(":"))) {
    throw new Error("请填写不重复的玩家 ID，用逗号分隔；ID 中不能包含冒号。");
  }
  if (!seed) throw new Error("请填写随机种子。");
  const first = $("#setup-first-player").value;
  return {
    match_id: "local-preview", player_ids: players, rng_seed: seed,
    first_player: first ? { mode: "fixed", player_id: first } : { mode: "random" },
    catalog_version: catalog.catalog_hash, config: enginePayload(),
  };
}

function setupItem(cardId) {
  for (const kind of kinds) {
    const group = catalog.groups[kind].find(item => item.id === cardId);
    if (group) return { name: group.name, image: group.image,
      detail: `${cardId} · ${group.members.length} 种牌` };
  }
  for (const kind of extraKinds) {
    const items = kind === "trap" || kind === "treasure"
      ? catalog.dungeon_groups[kind] : catalog.dungeon_cards[kind];
    const item = items.find(option => option.id === cardId);
    if (item) return { name: item.name, image: item.image || item.images?.[0],
      detail: `${cardId} · ${extraNames[kind]}` };
  }
  return { name: catalog.card_names[cardId] || cardId,
    image: `/cards/${cardId}.png`, detail: cardId };
}

function setupTile(cardId, detail = "") {
  const item = setupItem(cardId);
  const tile = document.createElement("div");
  tile.className = "result-tile";
  const image = document.createElement("img");
  image.src = item.image;
  image.alt = "";
  image.loading = "lazy";
  const copy = document.createElement("span");
  copy.className = "group-text";
  textSpan(copy, "group-name", item.name);
  textSpan(copy, "group-meta", detail || item.detail);
  tile.append(image, copy);
  return tile;
}

function resultBlock(parent, heading, note = "") {
  const block = document.createElement("section");
  block.className = "result-block";
  const title = document.createElement("h3");
  title.textContent = heading;
  block.append(title);
  if (note) {
    const description = document.createElement("p");
    description.textContent = note;
    block.append(description);
  }
  parent.append(block);
  return block;
}

function resultCards(parent, heading, ids, note = "", detailFor = null) {
  const block = resultBlock(parent, heading, note);
  const grid = document.createElement("div");
  grid.className = "result-card-grid";
  for (const id of ids) grid.append(setupTile(id, detailFor ? detailFor(id) : ""));
  if (!ids.length) textSpan(grid, "empty-state", "本局没有选中此类卡牌。");
  block.append(grid);
}

function renderSetupChoice(choice) {
  const box = $("#setup-choice");
  box.replaceChildren();
  box.hidden = false;
  const title = document.createElement("h3");
  title.textContent = "飞龙尖塔：分配两座地下城";
  const description = document.createElement("p");
  description.textContent = "每座地下城放入 2 个怪物组。你也可以决定守护者、陷阱和宝藏进入哪一座地下城。";
  box.append(title, description);
  const list = document.createElement("div");
  list.className = "allocation-list";
  function row(id, kind, initialSide) {
    const item = setupItem(id);
    const element = document.createElement("label");
    element.className = "allocation-row";
    const image = document.createElement("img");
    image.src = item.image;
    image.alt = "";
    const copy = document.createElement("span");
    copy.className = "group-text";
    textSpan(copy, "group-name", item.name);
    textSpan(copy, "group-meta", kind === "group" ? "怪物组 · " + id : item.detail);
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${item.name}分配到的地下城`);
    select.dataset.allocationId = id;
    select.dataset.allocationKind = kind;
    select.append(new Option("地下城 A", "a"), new Option("地下城 B", "b"));
    select.value = initialSide;
    select.addEventListener("change", updateAllocationCount);
    element.append(image, copy, select);
    list.append(element);
  }
  choice.group_ids.forEach((id, index) => row(id, "group", index < 2 ? "a" : "b"));
  choice.feature_ids.forEach(id => row(id, "feature", "b"));
  box.append(list);
  const counter = document.createElement("p");
  counter.id = "allocation-counter";
  counter.className = "allocation-counter";
  const actions = document.createElement("div");
  actions.className = "choice-actions";
  const submit = document.createElement("button");
  submit.type = "button";
  submit.id = "submit-allocation";
  submit.className = "button primary";
  submit.textContent = "按此分配完成组局";
  submit.addEventListener("click", () => {
    const selects = [...box.querySelectorAll("select[data-allocation-id]")];
    const groupA = selects.filter(item => item.dataset.allocationKind === "group" && item.value === "a")
      .map(item => item.dataset.allocationId);
    const featureA = selects.filter(item => item.dataset.allocationKind === "feature" && item.value === "a")
      .map(item => item.dataset.allocationId);
    if (groupA.length !== 2 || !pendingSetupRequest) return;
    runSetup({ ...pendingSetupRequest, scenario_choices: { two_dungeons: {
      group_a_ids: groupA, group_a_feature_ids: featureA,
    } } });
  });
  actions.append(submit);
  box.append(counter, actions);
  updateAllocationCount();
}

function updateAllocationCount() {
  const box = $("#setup-choice");
  const groupA = [...box.querySelectorAll('select[data-allocation-kind="group"]')]
    .filter(item => item.value === "a").length;
  const counter = $("#allocation-counter");
  counter.textContent = `地下城 A：${groupA} / 2 个怪物组；地下城 B：${4 - groupA} / 2 个怪物组`;
  counter.classList.toggle("invalid", groupA !== 2);
  $("#submit-allocation").disabled = groupA !== 2;
}

function renderSetupResult(result) {
  const box = $("#setup-result");
  box.replaceChildren();
  box.hidden = false;
  const state = result.state;
  const allocation = result.events.find(event => event.kind === "scenario_allocation");
  const metrics = document.createElement("div");
  metrics.className = "result-metrics";
  const environment = state.selected_features.environment[0];
  for (const [label, value] of [
    ["先手玩家", state.first_player_id],
    ["本局环境", environment ? setupItem(environment).name : "无"],
    ["实际牌组", `${state.selected_groups.village.length} 村庄 / ${state.selected_groups.hero.length} 英雄 / ${state.selected_groups.monster.length} 怪物`],
  ]) {
    const metric = document.createElement("div");
    metric.className = "result-metric";
    const small = document.createElement("small");
    small.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    metric.append(small, strong);
    metrics.append(metric);
  }
  box.append(metrics);
  const removed = result.events.filter(event => event.kind === "group_removed_by_environment");
  for (const event of removed) {
    const note = document.createElement("p");
    note.className = "result-note removed";
    note.textContent = `随机环境使${kindNames[event.category]}组目标下降，随机丢弃了「${setupItem(event.removed).name}」。`;
    box.append(note);
  }
  const villageCopies = id => {
    const group = catalog.groups.village.find(item => item.id === id);
    const count = group.members.reduce((total, member) =>
      total + (state.zones[`village_supply:${member}`]?.length || 0), 0);
    return `${id} · 供应剩余 ${count} 张`;
  };
  const heroCopies = id => `${id} · 供应 ${state.zones[`hero_supply:${id}`]?.length || 0} 张`;
  const monsterCopies = id => `${id} · 实例 ${Object.values(state.instances)
    .filter(instance => instance.origin === id).length} 张`;
  resultCards(box, "村庄牌组", state.selected_groups.village, "", villageCopies);
  resultCards(box, "英雄系列", state.selected_groups.hero, "", heroCopies);
  if (allocation) {
    const groupA = new Set(allocation.group_a_ids);
    resultCards(box, "地下城 A · 怪物组", state.selected_groups.monster.filter(id => groupA.has(id)), "", monsterCopies);
    resultCards(box, "地下城 B · 怪物组", state.selected_groups.monster.filter(id => !groupA.has(id)), "", monsterCopies);
  } else {
    resultCards(box, "怪物组", state.selected_groups.monster, "", monsterCopies);
  }
  const featureIds = extraKinds.flatMap(kind => state.selected_features[kind]);
  const allocatedFeatures = new Set(["guardian", "trap", "treasure"]
    .flatMap(kind => state.selected_features[kind]));
  if (featureIds.length) {
    const block = resultBlock(box, "地下城特征", allocation
      ? "飞龙尖塔的地下城分配见下方每座地下城。" : "本局实际加入的环境、守护者、陷阱组与宝藏组。");
    const grid = document.createElement("div");
    grid.className = "result-card-grid";
    for (const id of featureIds) {
      const side = allocation && allocatedFeatures.has(id)
        ? (allocation.group_a_feature_ids.includes(id) ? "地下城 A" : "地下城 B") : "";
      grid.append(setupTile(id, side ? `${setupItem(id).detail} · ${side}` : ""));
    }
    block.append(grid);
  }
  resultCards(box, "雷霆之石", state.selected_thunderstones);
  const diseaseSupply = state.supply_rules;
  const diseaseWeightTotal = Object.values(diseaseSupply.disease_weights)
    .reduce((total, weight) => total + weight, 0);
  resultCards(box,
    diseaseSupply.disease_mode === "special" ? "特殊疾病供应" : "普通疾病供应",
    diseaseSupply.disease_card_ids,
    "无限供应；取得疾病时才按权重生成一张新牌。",
    id => `${id} · 抽取权重 ${diseaseSupply.disease_weights[id]} / ${diseaseWeightTotal}`);
  const dungeonBlock = resultBlock(box, "初始地下城大厅", "仅展示大厅明牌与剩余牌堆张数；牌堆内部顺序不在页面公开。");
  for (const [zone, deck] of Object.entries(state.zones).filter(([name]) => name.startsWith("dungeon:"))) {
    const suffix = zone.split(":")[1];
    const hall = state.zones[`hall:${suffix}`] || [];
    const area = document.createElement("div");
    area.className = "dungeon-preview";
    const heading = document.createElement("h4");
    heading.textContent = `${suffix === "main" ? "地下城" : `地下城 ${suffix.toUpperCase()}`} · 牌堆剩余 ${deck.length} 张`;
    const cards = document.createElement("div");
    cards.className = "hall-cards";
    hall.forEach((instanceId, index) => {
      const cardId = state.instances[instanceId].card_id;
      const item = document.createElement("div");
      item.className = "hall-card";
      const image = document.createElement("img");
      image.src = `/cards/${cardId}.png`;
      image.alt = catalog.card_names[cardId] || cardId;
      const label = document.createElement("small");
      label.textContent = `阶层 ${index + 1} · ${catalog.card_names[cardId] || cardId}`;
      item.append(image, label);
      cards.append(item);
    });
    area.append(heading, cards);
    dungeonBlock.append(area);
  }
  const playerBlock = resultBlock(box, "玩家起始状态");
  const players = document.createElement("div");
  players.className = "result-inline";
  for (const player of state.player_order) {
    const note = document.createElement("p");
    note.className = "result-note";
    note.textContent = `${player}：手牌 ${state.zones[`player:${player}:hand`].length} 张，抽牌堆 ${state.zones[`player:${player}:draw`].length} 张，经验值 ${state.players[player].xp}。`;
    players.append(note);
  }
  playerBlock.append(players);
  const details = document.createElement("details");
  details.className = "setup-events";
  const summary = document.createElement("summary");
  summary.textContent = `设置记录（共 ${result.events.length} 条，显示选组与特殊处理）`;
  const list = document.createElement("ol");
  for (const event of result.events) {
    let description = "";
    if (event.kind === "fixed_group" || event.kind === "group_selected") {
      description = `${event.kind === "fixed_group" ? "固定" : "随机抽到"}${kindNames[event.category]}组：${setupItem(event.chosen).name}`;
    } else if (event.kind === "feature") {
      description = `抽到地下城特征：${setupItem(event.feature_id).name}`;
    } else if (event.kind === "group_removed_by_environment") {
      description = `环境调整后随机丢弃${kindNames[event.category]}组：${setupItem(event.removed).name}`;
    } else if (event.kind === "scenario_allocation") {
      description = `飞龙尖塔分配完成：地下城 A 有 ${event.group_a_ids.map(id => setupItem(id).name).join("、")}`;
    } else if (event.kind === "stormhold_supply_destroyed") {
      description = `风暴要塞：${event.zone} 顶部 ${event.instance_ids.length} 张移入摧毁区`;
    }
    if (description) {
      const item = document.createElement("li");
      item.textContent = description;
      list.append(item);
    }
  }
  details.append(summary, list);
  box.append(details);
}

async function runSetup(request) {
  const token = ++setupRunToken;
  const status = $("#setup-status");
  status.textContent = "正在生成本局…";
  status.className = "setup-status";
  setupResult = null;
  $("#setup-result").hidden = true;
  $("#setup-result").replaceChildren();
  $("#download-setup").hidden = true;
  $("#generate-setup").disabled = true;
  try {
    const response = await fetch("/api/v1/setup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const data = await response.json();
    if (token !== setupRunToken) return;
    if (data.status === "choice_required") {
      pendingSetupRequest = { ...request, scenario_choices: undefined };
      setupResult = null;
      $("#setup-result").hidden = true;
      $("#download-setup").hidden = true;
      renderSetupChoice(data.choice);
      status.textContent = "已抽到飞龙尖塔。请分配怪物组与地下城特征后完成组局。";
    } else if (response.ok && data.status === "ready") {
      pendingSetupRequest = null;
      setupResult = { state: data.state, events: data.events };
      $("#setup-choice").hidden = true;
      renderSetupResult(setupResult);
      $("#download-setup").hidden = false;
      status.textContent = `组局完成：${Object.keys(data.state.instances).length} 张实例牌，${data.events.length} 条设置记录。`;
      status.className = "setup-status success";
    } else {
      const issues = (data.issues || []).map(item => `${item.path}：${item.message}`);
      status.textContent = [data.message || data.error || "组局失败", ...issues].join("；");
      status.className = "setup-status error";
    }
  } catch (_) {
    if (token !== setupRunToken) return;
    status.textContent = "组局请求失败，请确认本地面板服务仍在运行。";
    status.className = "setup-status error";
  } finally {
    if (token === setupRunToken) $("#generate-setup").disabled = false;
  }
}

function bindEvents() {
  $("#setup-players").addEventListener("input", () => {
    renderFirstPlayerChoices();
    clearSetupPreview("玩家列表已修改，请重新生成本局。");
  });
  $("#setup-seed").addEventListener("input", () =>
    clearSetupPreview("随机种子已修改，请重新生成本局。"));
  $("#setup-first-player").addEventListener("change", () =>
    clearSetupPreview("先手选择已修改，请重新生成本局。"));
  $("#new-seed").addEventListener("click", () => {
    const values = new Uint32Array(2);
    crypto.getRandomValues(values);
    $("#setup-seed").value = [...values].map(value => value.toString(16).padStart(8, "0")).join("");
    clearSetupPreview("已生成新随机种子，请重新生成本局。");
  });
  $("#generate-setup").addEventListener("click", () => {
    try {
      const request = previewRequest();
      clearSetupPreview();
      runSetup(request);
    }
    catch (error) {
      const status = $("#setup-status");
      status.textContent = error.message;
      status.className = "setup-status error";
    }
  });
  $("#download-setup").addEventListener("click", () => {
    if (!setupResult) return;
    const blob = new Blob([JSON.stringify(setupResult, null, 2) + "\n"],
      { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "thunderstone-setup-result.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  for (const kind of kinds) {
    $("#count-" + kind).addEventListener("change", event => {
      if (event.target.disabled) return;
      const old = state.selection[kind].fixed_randomizer_ids;
      const entered = Number(event.target.value);
      if (event.target.value === "" || !Number.isInteger(entered)) {
        event.target.value = effectiveCounts()[kind];
        return;
      }
      const target = Math.max(Number(event.target.min), Math.min(entered, Number(event.target.max)));
      const delta = environmentRule()?.count_delta?.[kind] || 0;
      state.counts[kind + "_groups"] = target - delta;
      const effectiveTarget = Math.max(0, effectiveCounts()[kind]);
      state.selection[kind].fixed_randomizer_ids = old.slice(0, effectiveTarget);
      trimNotice = old.length > effectiveTarget ? `已移除 ${old.length - effectiveTarget} 个超出目标的${kindNames[kind]}固定组。` : "";
      setDraftChanged();
    });
  }
  for (const button of document.querySelectorAll(".group-tabs .tab")) {
    button.addEventListener("click", () => {
      activeKind = button.dataset.kind;
      searchText = "";
      trimNotice = "";
      $("#group-search").value = "";
      refresh();
    });
  }
  $("#group-search").addEventListener("input", event => {
    searchText = event.target.value.trim().toLowerCase();
    renderGroups();
  });
  for (const button of document.querySelectorAll(".extra-tab")) {
    button.addEventListener("click", () => {
      activeExtraKind = button.dataset.extraKind;
      extraSearchText = "";
      $("#extra-search").value = "";
      refresh();
    });
  }
  $("#extra-search").addEventListener("input", event => {
    extraSearchText = event.target.value.trim().toLowerCase();
    renderExtraCards();
  });
  $("#feature-random").addEventListener("change", event => {
    state.selection.dungeon_features.mode = event.target.checked ? "classic_random" : "manual";
    setDraftChanged();
  });
  for (const field of multiplierFields) {
    $("#" + field[0]).addEventListener("change", event => {
      const value = Number(event.target.value);
      state.instance_multipliers[field[1]] = value;
      setDraftChanged();
    });
  }
  $("#validate").addEventListener("click", validate);
  $("#copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#json-output").value); $("#copy").textContent = "已复制"; }
    catch (_) { $("#copy").textContent = "复制失败"; }
    setTimeout(() => { $("#copy").textContent = "复制 JSON"; }, 1800);
  });
  $("#download").addEventListener("click", () => {
    const blob = new Blob([$("#json-output").value + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "thunderstone-rules.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("#reset").addEventListener("click", () => { state = defaultState(); trimNotice = ""; setDraftChanged(); });
}

async function main() {
  try {
    const response = await fetch("/api/v1/options");
    if (!response.ok) throw new Error("catalog response failed");
    catalog = await response.json();
    state = restoreState();
    bindEvents();
    renderFirstPlayerChoices();
    refresh();
    $("#loading").hidden = true;
    $("#app").hidden = false;
  } catch (_) {
    $("#loading").textContent = "卡牌目录读取失败。请从仓库根目录使用 Python 启动配置面板。";
  }
}

main();
