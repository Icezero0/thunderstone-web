import {$, textSpan} from './dom.js';

export function createSetupPreview(page, {enginePayload, setupItem, setupTile, renderSetupResult}) {
  function clearSetupPreview(message = "填写参数后生成，即可查看选中的牌组和初始牌区。") {
    page.setupRunToken += 1;
    page.setupResult = null;
    page.pendingSetupRequest = null;
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
      catalog_version: page.catalog.catalog_hash, config: enginePayload(),
    };
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
      if (groupA.length !== 2 || !page.pendingSetupRequest) return;
      runSetup({ ...page.pendingSetupRequest, scenario_choices: { two_dungeons: {
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

  async function runSetup(request) {
    const token = ++page.setupRunToken;
    const status = $("#setup-status");
    status.textContent = "正在生成本局…";
    status.className = "setup-status";
    page.setupResult = null;
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
      if (token !== page.setupRunToken) return;
      if (data.status === "choice_required") {
        page.pendingSetupRequest = { ...request, scenario_choices: undefined };
        page.setupResult = null;
        $("#setup-result").hidden = true;
        $("#download-setup").hidden = true;
        renderSetupChoice(data.choice);
        status.textContent = "已抽到飞龙尖塔。请分配怪物组与地下城特征后完成组局。";
      } else if (response.ok && data.status === "ready") {
        page.pendingSetupRequest = null;
        page.setupResult = { state: data.state, events: data.events };
        $("#setup-choice").hidden = true;
        renderSetupResult(page.setupResult);
        $("#download-setup").hidden = false;
        status.textContent = `组局完成：${Object.keys(data.state.instances).length} 张实例牌，${data.events.length} 条设置记录。`;
        status.className = "setup-status success";
      } else {
        const issues = (data.issues || []).map(item => `${item.path}：${item.message}`);
        status.textContent = [data.message || data.error || "组局失败", ...issues].join("；");
        status.className = "setup-status error";
      }
    } catch (_) {
      if (token !== page.setupRunToken) return;
      status.textContent = "组局请求失败，请确认本地面板服务仍在运行。";
      status.className = "setup-status error";
    } finally {
      if (token === page.setupRunToken) $("#generate-setup").disabled = false;
    }
  }

  function bindSetupEvents() {
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
      if (!page.setupResult) return;
      const blob = new Blob([JSON.stringify(page.setupResult, null, 2) + "\n"],
        { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "thunderstone-setup-result.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  return {clearSetupPreview, renderFirstPlayerChoices, bindSetupEvents, runSetup};
}
