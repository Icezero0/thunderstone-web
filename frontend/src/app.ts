import {api, ApiError} from './api.js';
import {RoomConnection} from './realtime.js';
import {configurationSummary, roomPresentation} from './room-view.js';
import type {Catalog, Room, RoomSummary, User} from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag); value.className = className; value.textContent = text; return value;
}

let user: User | null = null;
let room: Room | null = null;
let rooms: RoomSummary[] = [];
let catalog: Catalog | null = null;
let connection: RoomConnection | null = null;
let registering = false;
let busy = false;
let loadSequence = 0;

function notice(message = '', error = false): void {
  const banner = $('#notice'); banner.textContent = message; banner.hidden = !message;
  banner.className = error ? 'notice error' : 'notice';
}

function message(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '登录已失效，或邮箱和密码不正确，请重新登录。';
    if (error.message === 'Email already exists') return '这个邮箱已注册，请直接登录。';
    return error.message;
  }
  return '连接失败，请检查网络或稍后重试。';
}

async function action(task: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true; notice(); render();
  try {await task();}
  catch (error) {
    if (error instanceof ApiError && error.status === 409 && user) await refresh().catch(() => {});
    notice(message(error), true);
  } finally {busy = false; render();}
}

async function refresh(): Promise<void> {
  if (!user) return;
  const sequence = ++loadSequence;
  const [listing, current] = await Promise.all([
    api.request<{rooms: RoomSummary[]}>('/rooms'), api.request<{room: Room | null}>('/rooms/current'),
  ]);
  if (sequence !== loadSequence || !user) return;
  rooms = listing.rooms; room = current.room; render();
}

async function signedIn(value: User): Promise<void> {
  user = value; render();
  void api.request<Catalog>('/options').then(value => {catalog = value; render();}).catch(() => {});
  connection?.close();
  connection = new RoomConnection(api, () => {void refresh().catch(() => {});}, status => {
    $('#connection').textContent = {connecting: '正在连接', online: '实时连接正常', offline: '连接中断，正在重连'}[status];
    $('#connection').dataset.status = status;
  });
  void connection.connect();
  await refresh();
}

function signedOut(): void {
  connection?.close(); connection = null; loadSequence++;
  user = null; room = null; rooms = []; catalog = null; api.signOut(); render();
  $('#connection').textContent = '尚未登录'; $('#connection').dataset.status = 'offline';
}

function render(): void {
  $('#auth-view').hidden = !!user;
  $('#lobby-view').hidden = !user || !!room;
  $('#room-view').hidden = !user || !room;
  $('#account').hidden = !user;
  $('#account-name').textContent = user?.username || user?.email || '';
  $<HTMLButtonElement>('#auth-submit').disabled = busy;
  $<HTMLButtonElement>('#create-room').disabled = busy;
  $<HTMLButtonElement>('#join-code').disabled = busy;
  if (user && room) renderRoom();
  if (user && !room) renderRooms();
}

function renderRooms(): void {
  $('#room-count').textContent = `${rooms.length} 个等待中的房间`;
  const container = $('#rooms'); container.replaceChildren();
  if (!rooms.length) {
    const empty = el('div', 'empty');
    empty.append(el('span', 'empty-symbol', 'ϟ'), el('h3', '', '还没有等待中的房间'), el('p', '', '创建一个房间，邀请朋友一起准备这一局。'));
    container.append(empty); return;
  }
  for (const item of rooms) {
    const card = el('article', 'room-card');
    const info = el('div'); info.append(el('span', 'label', '等待准备'), el('h3', '', item.name), el('p', 'muted', `房主 ${item.host_name} · ${item.player_count} 位玩家`));
    const join = el('button', 'button secondary', '加入房间'); join.type = 'button'; join.disabled = busy;
    join.addEventListener('click', () => void action(async () => {
      await api.request(`/rooms/${item.id}/join`, {method: 'POST', body: JSON.stringify({expected_version: item.version})});
      await refresh();
    }));
    card.append(info, join); container.append(card);
  }
}

function renderRoom(): void {
  if (!room || !user) return;
  const view = roomPresentation(room, user.id);
  $('#room-name').textContent = room.name;
  $('#room-code').textContent = room.id;
  $('#readiness').textContent = room.all_ready ? '所有玩家已准备' : `${view.readyCount} / ${room.player_count} 位玩家已准备`;
  $('#readiness').classList.toggle('all-ready', room.all_ready);
  const list = $('#players'); list.replaceChildren();
  for (const player of room.players) {
    const item = el('li', `player${player.user_id === user.id ? ' me' : ''}`);
    const avatar = el('span', 'avatar', Array.from(player.display_name)[0]);
    const name = el('div', 'player-name', player.display_name);
    if (player.user_id === user.id) name.append(el('small', '', '你'));
    if (player.user_id === room.host_user_id) name.append(el('small', 'host', '房主'));
    item.append(avatar, name, el('span', player.ready ? 'ready-state ready' : 'ready-state', player.ready ? '已准备' : '准备中'));
    list.append(item);
  }
  const ready = $<HTMLButtonElement>('#ready'); ready.textContent = view.ready ? '取消准备' : '我准备好了'; ready.disabled = busy;
  $<HTMLButtonElement>('#leave-room').disabled = busy;
  const close = $<HTMLButtonElement>('#close-room'); close.hidden = !view.isHost; close.disabled = busy;
  const edit = $<HTMLAnchorElement>('#edit-config'); edit.hidden = !view.isHost; edit.href = `/config?room=${room.id}`;
  $('#host-note').textContent = view.isHost ? '你是房主，可以修改本局配置。离开时，房主身份交给列表中的下一位玩家。' : `由 ${room.host_name} 设置本局规则。`;
  const summary = configurationSummary(room, catalog);
  const counts = $('#config-counts'); counts.replaceChildren();
  for (const [key, title] of [['village', '村庄组'], ['hero', '英雄组'], ['monster', '怪物组']] as const) {
    const box = el('div', 'config-count'); box.append(el('strong', '', String(summary.counts[key])), el('span', '', title)); counts.append(box);
  }
  $('#feature-mode').textContent = summary.featureMode;
  $('#multipliers').textContent = summary.multipliers;
  const details = $('#config-details'); details.replaceChildren();
  for (const [title, text] of summary.details) details.append(el('dt', '', title), el('dd', '', text));
}

$('#auth-mode').addEventListener('click', () => {
  registering = !registering;
  $('#auth-title').textContent = registering ? '创建你的账号' : '欢迎回到雷霆之石';
  $('#username-field').hidden = !registering;
  $<HTMLInputElement>('#username').required = registering;
  $<HTMLInputElement>('#password').autocomplete = registering ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = registering ? '注册并进入大厅' : '登录';
  $('#auth-mode').textContent = registering ? '已有账号？登录' : '没有账号？注册'; notice();
});

$('#auth-form').addEventListener('submit', event => {
  event.preventDefault(); void action(async () => {
    const email = $<HTMLInputElement>('#email').value.trim();
    const password = $<HTMLInputElement>('#password').value;
    if (registering) await api.request('/auth/register', {method: 'POST', body: JSON.stringify({email, password, username: $<HTMLInputElement>('#username').value.trim()})});
    const account = await api.login(email, password);
    $<HTMLInputElement>('#password').value = '';
    await signedIn(account);
  });
});

$('#logout').addEventListener('click', () => {signedOut(); notice('已退出登录。');});
$('#refresh').addEventListener('click', () => void action(refresh));
$('#create-form').addEventListener('submit', event => {
  event.preventDefault(); void action(async () => {
    await api.request('/rooms', {method: 'POST', body: JSON.stringify({name: $<HTMLInputElement>('#new-room-name').value.trim()})});
    $<HTMLInputElement>('#new-room-name').value = ''; await refresh();
  });
});
$('#join-form').addEventListener('submit', event => {
  event.preventDefault(); void action(async () => {
    const id = $<HTMLInputElement>('#room-id').value.trim().toLowerCase();
    const target = await api.request<Room>(`/rooms/${encodeURIComponent(id)}`);
    await api.request(`/rooms/${target.id}/join`, {method: 'POST', body: JSON.stringify({expected_version: target.version})});
    $<HTMLInputElement>('#room-id').value = ''; await refresh();
  });
});
$('#ready').addEventListener('click', () => void action(async () => {
  if (!room || !user) return;
  await api.request(`/rooms/${room.id}/ready`, {method: 'POST', body: JSON.stringify({expected_version: room.version, ready: !roomPresentation(room, user.id).ready})});
  await refresh();
}));
$('#leave-room').addEventListener('click', () => void action(async () => {
  if (!room) return;
  await api.request(`/rooms/${room.id}/leave`, {method: 'POST', body: JSON.stringify({expected_version: room.version})}); await refresh();
}));
$('#close-room').addEventListener('click', () => {
  if (!confirm('关闭这个房间？所有玩家都会返回大厅。')) return;
  void action(async () => {
    if (!room) return;
    await api.request(`/rooms/${room.id}/close`, {method: 'POST', body: JSON.stringify({expected_version: room.version})}); await refresh();
  });
});
$('#copy-room').addEventListener('click', () => {
  if (!room) return;
  if (!navigator.clipboard) {notice('请选中房间编号复制。'); return;}
  void navigator.clipboard.writeText(room.id).then(() => notice('房间编号已复制，朋友可在大厅输入编号加入。')).catch(() => notice('请选中房间编号复制。'));
});
api.onExpired = () => {signedOut(); notice('登录已失效，请重新登录。', true);};
document.addEventListener('visibilitychange', () => {if (!document.hidden && user) void refresh().catch(() => {});});
window.addEventListener('pagehide', () => connection?.close());
window.addEventListener('pageshow', event => {
  if (event.persisted && user) void signedIn(user).catch(error => notice(message(error), true));
});

busy = true;
render();
void api.restore().then(value => value ? signedIn(value) : undefined)
  .catch(error => notice(message(error), true)).finally(() => {busy = false; render();});
