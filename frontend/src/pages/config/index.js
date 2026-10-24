import {STORAGE_KEY, kinds, kindNames, multiplierFields} from './constants.js';
import {$} from './dom.js';
import {createPageState} from './state.js';
import {createConfigModel} from './model.js';
import {createDraftStorage} from './draft-storage.js';
import {createSelectionView} from './selection.js';
import {createSetupResults} from './setup-results.js';
import {createSetupPreview} from './setup-preview.js';
import {createRoomEditor} from './room-editor.js';

const page = createPageState(new URLSearchParams(location.search).get('room'));
const {
  defaultState, environmentRule, effectiveCounts, fixedThunderstoneIds,
  thunderstoneTarget, enginePayload,
} = createConfigModel(page);
const {restoreState} = createDraftStorage(page, {defaultState, effectiveCounts});
const results = createSetupResults(page);
const {clearSetupPreview, renderFirstPlayerChoices, bindSetupEvents} = createSetupPreview(page, {enginePayload, ...results});
const {loadRoomEditor} = createRoomEditor(page, {enginePayload, refresh});
const {
  renderCounts, renderTabs, renderGroups, renderExtraTabs, renderFeatureMode,
  renderScenarioNote, renderExtraCards, renderMultipliers, renderSummary,
} = createSelectionView(page, {
  setDraftChanged, refresh, environmentRule, effectiveCounts, fixedThunderstoneIds, thunderstoneTarget,
});

function setDraftChanged() {
  if (page.roomEditor) {
    page.roomEditor.dirty = true;
    $("#room-editor-status").textContent = "有未保存的修改。保存后，所有玩家需要重新准备。";
  }
  clearSetupPreview("规则配置已修改，请重新生成本局。");
  const badge = $("#validation-badge");
  badge.textContent = "待预检";
  badge.className = "validation-badge";
  $("#validation-errors").replaceChildren();
  refresh();
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
  try { if (!page.roomEditor) localStorage.setItem(STORAGE_KEY, JSON.stringify({ catalog_hash: page.catalog.catalog_hash, state: page.state })); }
  catch (_) { /* Local storage is optional. */ }
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

function bindEvents() {
  bindSetupEvents();
  for (const kind of kinds) {
    $("#count-" + kind).addEventListener("change", event => {
      if (event.target.disabled) return;
      const old = page.state.selection[kind].fixed_randomizer_ids;
      const entered = Number(event.target.value);
      if (event.target.value === "" || !Number.isInteger(entered)) {
        event.target.value = effectiveCounts()[kind];
        return;
      }
      const target = Math.max(Number(event.target.min), Math.min(entered, Number(event.target.max)));
      const delta = environmentRule()?.count_delta?.[kind] || 0;
      page.state.counts[kind + "_groups"] = target - delta;
      const effectiveTarget = Math.max(0, effectiveCounts()[kind]);
      page.state.selection[kind].fixed_randomizer_ids = old.slice(0, effectiveTarget);
      page.trimNotice = old.length > effectiveTarget ? `已移除 ${old.length - effectiveTarget} 个超出目标的${kindNames[kind]}固定组。` : "";
      setDraftChanged();
    });
  }
  for (const button of document.querySelectorAll(".group-tabs .tab")) {
    button.addEventListener("click", () => {
      page.activeKind = button.dataset.kind;
      page.searchText = "";
      page.trimNotice = "";
      $("#group-search").value = "";
      refresh();
    });
  }
  $("#group-search").addEventListener("input", event => {
    page.searchText = event.target.value.trim().toLowerCase();
    renderGroups();
  });
  for (const button of document.querySelectorAll(".extra-tab")) {
    button.addEventListener("click", () => {
      page.activeExtraKind = button.dataset.extraKind;
      page.extraSearchText = "";
      $("#extra-search").value = "";
      refresh();
    });
  }
  $("#extra-search").addEventListener("input", event => {
    page.extraSearchText = event.target.value.trim().toLowerCase();
    renderExtraCards();
  });
  $("#feature-random").addEventListener("change", event => {
    page.state.selection.dungeon_features.mode = event.target.checked ? "classic_random" : "manual";
    setDraftChanged();
  });
  for (const field of multiplierFields) {
    $("#" + field[0]).addEventListener("change", event => {
      const value = Number(event.target.value);
      page.state.instance_multipliers[field[1]] = value;
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
  $("#reset").addEventListener("click", () => { page.state = defaultState(); page.trimNotice = ""; setDraftChanged(); });
}

async function main() {
  try {
    const response = await fetch("/api/v1/options");
    if (!response.ok) throw new Error("catalog response failed");
    page.catalog = await response.json();
    page.state = page.editingRoomId ? await loadRoomEditor() : restoreState();
    bindEvents();
    renderFirstPlayerChoices();
    refresh();
    $("#loading").hidden = true;
    $("#app").hidden = false;
  } catch (error) {
    $("#loading").textContent = page.editingRoomId ? error.message : "卡牌目录读取失败。请从仓库根目录使用 Python 启动配置面板。";
    if (page.editingRoomId) {
      const link = document.createElement("a"); link.href = "/play"; link.textContent = " 返回联机大厅";
      $("#loading").append(link);
    }
  }
}

main();
