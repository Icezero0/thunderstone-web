import {kinds, kindNames, extraKinds, extraNames, multiplierFields} from './constants.js';
import {$, textSpan} from './dom.js';

export function createSelectionView(page, {setDraftChanged, refresh, environmentRule, effectiveCounts, fixedThunderstoneIds, thunderstoneTarget}) {
  function renderCounts() {
    const effective = effectiveCounts();
    const rule = environmentRule();
    for (const kind of kinds) {
      const input = $("#count-" + kind);
      const base = page.state.counts[kind + "_groups"];
      const delta = rule?.count_delta?.[kind] || 0;
      const fixed = rule?.count_override?.[kind] !== undefined;
      const available = page.catalog.groups[kind].length;
      input.value = effective[kind];
      input.disabled = fixed || page.cardConfiguration === "default";
      input.min = Math.max(0, delta);
      input.max = Math.min(available, available + delta);
      const adjustment = $("#" + kind + "-adjustment");
      adjustment.textContent = fixed ? "固定" : delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : "";
      adjustment.className = "count-adjustment" + (fixed ? " active fixed"
        : delta > 0 ? " active increase" : delta < 0 ? " active decrease" : "");
      const changed = effective[kind] !== page.state.counts[kind + "_groups"];
      $("#" + kind + "-availability").textContent = changed
        ? `基础 ${base} 组 · 目录共 ${available} 组`
        : `目录共 ${available} 组`;
      input.title = fixed ? "此环境固定该类别的实际组数；切换环境可恢复基础设定"
        : delta ? "显示环境调整后的实际组数" : "";
    }
  }

  function renderTabs() {
    for (const button of document.querySelectorAll(".group-tabs .tab")) {
      const selected = button.dataset.kind === page.activeKind;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
    }
    for (const kind of kinds) {
      $("#tab-count-" + kind).textContent = page.state.selection[kind].fixed_randomizer_ids.length;
    }
    $("#tab-count-thunderstone").textContent = fixedThunderstoneIds().length;
  }

  function renderGroups() {
    const list = $("#group-list");
    list.replaceChildren();
    if (page.activeKind === "thunderstone") {
      renderThunderstoneChoices(list);
      return;
    }
    const selected = new Set(page.state.selection[page.activeKind].fixed_randomizer_ids);
    const target = effectiveCounts()[page.activeKind];
    $("#group-hint").textContent = `已指定 ${selected.size} / ${target} 组 · 未指定的组将随机抽取。${page.trimNotice}`;
    const groups = page.catalog.groups[page.activeKind].filter(group =>
      `${group.id} ${group.name}`.toLowerCase().includes(page.searchText));
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
        const ids = page.state.selection[page.activeKind].fixed_randomizer_ids;
        if (!isSelected && ids.length >= target) return;
        page.state.selection[page.activeKind].fixed_randomizer_ids = isSelected
          ? ids.filter(id => id !== group.id) : [...ids, group.id];
        page.trimNotice = "";
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
      page.state.selection.thunderstone.fixed_card_ids = [];
      setDraftChanged();
    });
    random.disabled = forced;
    list.append(random);
    for (const card of page.catalog.thunderstones.filter(card =>
      `${card.id} ${card.name}`.toLowerCase().includes(page.searchText))) {
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
          page.state.selection.thunderstone.fixed_card_ids = isSelected ? [] : [card.id];
        } else {
          page.state.selection.thunderstone.fixed_card_ids = isSelected
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
      const selected = kind === page.activeExtraKind;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      const choice = page.state.selection[kind];
      const key = kind === "trap" || kind === "treasure" ? "fixed_group_ids" : "fixed_card_ids";
      const autoGuardian = kind === "guardian" && environmentRule()?.scenario === "banishing_ritual" ? 1 : 0;
      $("#extra-count-" + kind).textContent = choice[key].length + choice.random_count + autoGuardian;
    }
  }

  function renderFeatureMode() {
    const random = page.state.selection.dungeon_features.mode === "classic_random";
    $("#feature-random").checked = random;
    $("#manual-feature-panel").hidden = random;
  }

  function renderScenarioNote() {
    const note = $("#scenario-note");
    const rule = environmentRule();
    if (rule) {
      note.textContent = rule.note;
    } else if (page.state.selection.dungeon_features.mode === "classic_random") {
      note.textContent = "随机抽出的环境可能改变村庄、英雄或怪物组数，并可能启用双地下城或放逐仪式规则。";
    } else if (page.state.selection.environment.random_count === 1) {
      note.textContent = "随机环境的组数与场景效果将在抽出具体环境后确定。";
    } else {
      note.textContent = "";
    }
    note.hidden = !note.textContent;
  }

  function renderExtraCards() {
    const kind = page.activeExtraKind;
    const choice = page.state.selection[kind];
    const grouped = kind === "trap" || kind === "treasure";
    const cards = grouped ? page.catalog.dungeon_groups[kind] : page.catalog.dungeon_cards[kind];
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
        .toLowerCase().includes(page.extraSearchText));
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
            const guardian = page.state.selection.guardian;
            guardian.fixed_card_ids = guardian.fixed_card_ids.filter(id => id !== "TS-0683");
            guardian.random_count = Math.min(guardian.random_count,
              page.catalog.dungeon_cards.guardian.length - 1 - guardian.fixed_card_ids.length);
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
    return page.state.instance_multipliers[field[1]];
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
    const multipliers = page.state.instance_multipliers;
    const effective = effectiveCounts();
    const manual = page.state.selection.dungeon_features.mode === "manual";
    const lines = [
      ["游戏模式", "经典"],
      ...kinds.map(kind => [kindNames[kind] + "组", `${page.state.selection[kind].fixed_randomizer_ids.length} 固定 / ${effective[kind]} 实际目标`]),
      ["地下城特征", manual ? "手动选择" : "经典随机"],
      ...(manual ? extraKinds.map(kind => {
        const key = kind === "trap" || kind === "treasure" ? "fixed_group_ids" : "fixed_card_ids";
        const unit = kind === "trap" || kind === "treasure" ? "组" : "种";
        const auto = kind === "guardian" && environmentRule()?.scenario === "banishing_ritual" ? 1 : 0;
        return [extraNames[kind], `${page.state.selection[kind][key].length + auto} ${unit}固定 / ${page.state.selection[kind].random_count} ${unit}随机`];
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

  return {renderCounts, renderTabs, renderGroups, renderExtraTabs, renderFeatureMode,
    renderScenarioNote, renderExtraCards, renderMultipliers, renderSummary};
}
