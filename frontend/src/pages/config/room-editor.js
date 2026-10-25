import {$} from './dom.js';

export function createRoomEditor(page, {enginePayload, refresh}) {
  async function loadRoomEditor() {
    if (!/^[a-f0-9]{32}$/.test(page.editingRoomId || "")) throw new Error("房间编号无效");
    const { api } = await import("../../app/session.ts");
    const {loginLink} = await import("../../app/navigation.ts");
    const login = () => location.replace(loginLink(`/config?room=${page.editingRoomId}`));
    api.onExpired = login;
    const user = await api.restore();
    if (!user) {login(); return null;}
    const room = await api.request(`/rooms/${page.editingRoomId}`);
    if (room.host_user_id !== user.id) throw new Error("只有房主可以编辑房间配置。");
    if (room.status !== "waiting") throw new Error("本局已经开始，不能修改配置。请返回大厅进入对局。");
    page.roomEditor = { api, room, user, dirty: false };
    document.body.classList.add("room-mode");
    $("#room-editor").hidden = false;
    $("#room-editor-name").textContent = room.name + " · 规则配置";
    $(".hero-copy h1").textContent = "游戏配置";
    $(".hero-copy p:last-child").textContent = "调整卡组与地下城特征后，点击“保存至房间”。其他玩家会同步看到新的配置，并重新确认准备状态。";
    $("#draft-note").textContent = "当前显示的是房间配置。页面修改需点击“保存至房间”后才会生效。";
    $("#output-note").textContent = "预检检查参数结构与卡牌目录。保存时服务器会再次校验。";
    $("#reload-room").addEventListener("click", () => location.reload());
    $("#save-room").addEventListener("click", saveRoomConfig);
    window.addEventListener("beforeunload", event => {
      if (page.roomEditor.dirty) { event.preventDefault(); event.returnValue = ""; }
    });
    return structuredClone(room.config);
  }

  async function saveRoomConfig() {
    if (!page.roomEditor) return;
    const button = $("#save-room");
    button.disabled = true;
    const status = $("#room-editor-status");
    try {
      const latest = await page.roomEditor.api.request(`/rooms/${page.editingRoomId}`);
      if (latest.status !== "waiting") throw new Error("本局已经开始，不能修改配置。请返回大厅进入对局。");
      if (latest.config_version !== page.roomEditor.room.config_version) {
        $("#reload-room").hidden = false;
        throw new Error("配置已在其他页面更新。请保留需要的修改，再重新载入配置。");
      }
      const saved = await page.roomEditor.api.request(`/rooms/${page.editingRoomId}/config`, {
        method: "PATCH", body: JSON.stringify({ expected_version: latest.version, config: enginePayload() }),
      });
      page.roomEditor.room = saved;
      page.roomEditor.dirty = false;
      page.state = structuredClone(saved.config);
      refresh();
      status.textContent = "已保存至房间。其他玩家会同步看到此配置。";
      $("#reload-room").hidden = true;
    } catch (error) {
      const issues = (error.details?.errors || []).map(item => `${item.path}：${item.message}`);
      status.textContent = [error.message || "保存失败，请重试。", ...issues].join("；");
    } finally { button.disabled = false; }
  }

  return {loadRoomEditor, saveRoomConfig};
}
