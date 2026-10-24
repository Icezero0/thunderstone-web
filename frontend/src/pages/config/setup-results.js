import {kinds, kindNames, extraKinds, extraNames} from './constants.js';
import {$, textSpan} from './dom.js';

export function createSetupResults(page) {
  function setupItem(cardId) {
    for (const kind of kinds) {
      const group = page.catalog.groups[kind].find(item => item.id === cardId);
      if (group) return { name: group.name, image: group.image,
        detail: `${cardId} · ${group.members.length} 种牌` };
    }
    for (const kind of extraKinds) {
      const items = kind === "trap" || kind === "treasure"
        ? page.catalog.dungeon_groups[kind] : page.catalog.dungeon_cards[kind];
      const item = items.find(option => option.id === cardId);
      if (item) return { name: item.name, image: item.image || item.images?.[0],
        detail: `${cardId} · ${extraNames[kind]}` };
    }
    return { name: page.catalog.card_names[cardId] || cardId,
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
      const group = page.catalog.groups.village.find(item => item.id === id);
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
        image.alt = page.catalog.card_names[cardId] || cardId;
        const label = document.createElement("small");
        label.textContent = `阶层 ${index + 1} · ${page.catalog.card_names[cardId] || cardId}`;
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

  return {setupItem, setupTile, renderSetupResult};
}
