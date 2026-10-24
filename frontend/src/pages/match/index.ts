import {api} from '../../app/session.js';
import {matchLink, matchLoginLink} from '../../app/navigation.js';
import {ApiError} from '../../shared/api/client.js';
import {RoomConnection} from '../../shared/realtime/room-connection.js';
import type {GameCommand, MatchView, User} from '../../shared/api/types.js';
import {allocation, setupSelection, type SetupSelection} from './model.js';
import {MatchPage} from './view.js';
import {MatchActions} from './actions.js';
import {mayCommand} from './commands.js';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
let matchId = new URLSearchParams(location.search).get('id');
let view: MatchView | null = null, user: User | null = null;
let selection: SetupSelection = {groupA: [], featureA: []};
let connection: RoomConnection | null = null, busy = false, starting = false, sequence = 0;
let setupAttempt: {key: string; command_id: string} | null = null;
let cancelAttempt: {version: number; command_id: string} | null = null;
let commandAttempt: {key: string; command_id: string} | null = null;
const page = new MatchPage(id => {if (view?.cards[id]) page.detail(view.cards[id]);}, (kind, id, checked) => {
  if (!view?.can_resolve_setup || busy) return;
  selection[kind] = selection[kind].filter(value => value !== id);
  if (checked) selection[kind].push(id);
  page.renderSetup(view, selection, busy);
}, command => {void sendCommand(command);}, ids => actions.selectHand(ids), id => actions.selectTarget(id),
  () => actions.completeBattle(), () => actions.openResponse());
const actions = new MatchActions(command => {void sendCommand(command);}, (view, id, caption) => page.tile(view, id, caption),
  message => notice(message, !!message), ids => page.setSelected(ids), () => page.closeBrowsers());

function notice(text = '', error = false): void {
  const node = $('#notice'); node.textContent = text; node.hidden = !text; node.classList.toggle('error', error);
}
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return '无法访问这场对局。请返回房间，确认你是本局玩家。';
    if (error.code === 'match_version_conflict') return '牌桌状态已更新，请核对最新分配后重试。';
    return error.message;
  }
  return '连接失败。请检查网络，然后点击“刷新牌桌”。';
}
function login(): void {
  page.closeBrowsers(); actions.finish();
  sequence++; view = null; user = null; connection?.close();
  $('#match-content').hidden = true; $<HTMLDialogElement>('#card-dialog').close();
  location.replace(matchLoginLink(matchId));
}
function accept(value: MatchView): void {
  if (view?.id === value.id && value.version < view.version) return;
  const same = view?.id === value.id && view?.version === value.version;
  view = value; selection = setupSelection(value, same ? selection : undefined);
  if (value.status === 'cancelled') {page.closeBrowsers(); $<HTMLDialogElement>('#card-dialog').close();}
  matchId = value.id; history.replaceState(null, '', matchLink(value.id));
  page.render(value, selection, busy);
  renderControls();
}
function renderControls(): void {
  if (!view) return;
  $('#cancel-match-bar').hidden = !['active', 'setup_pending'].includes(view.status) || user?.id !== view.host_user_id;
  $<HTMLButtonElement>('#cancel-match').disabled = busy;
  actions.receive(view, busy);
  page.controls(view, busy);
}
async function sendCommand(command: GameCommand): Promise<void> {
  if (!view || busy || !mayCommand(view, command)) return;
  const current = view, key = JSON.stringify([current.id, current.version, command]);
  if (commandAttempt?.key !== key) commandAttempt = {key, command_id: crypto.randomUUID()};
  busy = true; renderControls(); notice();
  try {
    const result = await api.request<MatchView>(`/matches/${current.id}/commands`, {method: 'POST', body: JSON.stringify({
      expected_version: current.version, command_id: commandAttempt.command_id, command,
    })});
    accept(result);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {login(); return;}
    if (error instanceof ApiError && [403, 409].includes(error.status)) await safeRefresh();
    notice(errorMessage(error), true);
  } finally {busy = false; renderControls();}
}
async function refresh(): Promise<void> {
  if (!user) return;
  const request = ++sequence;
  const current = matchId ? await api.request<MatchView>(`/matches/${encodeURIComponent(matchId)}`)
    : (await api.request<{match: MatchView | null}>('/matches/current')).match;
  if (request !== sequence || !user) return;
  if (current) {accept(current); notice();}
  else {
    page.closeBrowsers(); actions.finish();
    view = null; $('#match-content').hidden = true; $('#empty-view').hidden = false;
    $('#match-title').textContent = '冒险尚未开始'; $('#match-subtitle').textContent = '先回到房间，与伙伴一起准备。';
    $('#page-state').textContent = '没有进行中的对局。';
  }
}
async function safeRefresh(): Promise<void> {
  try {await refresh();}
  catch (error) {
    console.error('Failed to refresh match', error);
    if (error instanceof ApiError && error.status === 401) {login(); return;}
    if (error instanceof ApiError && [403, 404].includes(error.status)) {
      page.closeBrowsers(); actions.finish();
      view = null; $('#match-content').hidden = true; $('#empty-view').hidden = false;
      $<HTMLDialogElement>('#card-dialog').close();
      $('#empty-title').textContent = '这场对局暂不可访问'; $('#empty-description').textContent = '返回房间，确认当前参与的对局。';
    }
    $('#page-state').textContent = '牌桌尚未同步。'; notice(errorMessage(error), true);
  }
}
function connect(): void {
  connection?.close();
  connection = new RoomConnection(api, () => {void safeRefresh();}, status => {
    $('#connection').textContent = {connecting: '正在连接', online: '实时连接正常', offline: '连接中断，正在重连'}[status];
    $('#connection').dataset.status = status;
  });
  void connection.connect();
}
$('#confirm-setup').addEventListener('click', () => {
  if (!view?.can_resolve_setup || busy) return;
  const selected = allocation(view, selection); if (!selected.valid) return;
  const body = {expected_version: view.version, group_a_ids: selected.groupA, group_a_feature_ids: selected.featureA};
  const key = JSON.stringify([view.id, body]);
  if (setupAttempt?.key !== key) setupAttempt = {key, command_id: crypto.randomUUID()};
  busy = true; renderControls(); page.renderSetup(view, selection, busy); notice();
  void api.request<MatchView>(`/matches/${view.id}/setup-choice`, {method: 'POST', body: JSON.stringify({...body, command_id: setupAttempt.command_id})})
    .then(result => {accept(result);})
    .catch(async error => {
      if (error instanceof ApiError && error.status === 401) {login(); return;}
      if (error instanceof ApiError && error.status === 409) await safeRefresh();
      notice(errorMessage(error), true);
    }).finally(() => {
      busy = false; renderControls();
      if (view?.status === 'setup_pending') page.renderSetup(view, selection, busy);
    });
});
$('#refresh-match').addEventListener('click', () => {void (user ? safeRefresh() : start());});
$('#cancel-match').addEventListener('click', () => {
  if (!view || user?.id !== view.host_user_id || view.status === 'cancelled' || busy) return;
  if (!confirm('取消本局并返回房间？所有玩家将重新准备，当前开局不再继续。')) return;
  const current = view;
  if (cancelAttempt?.version !== current.version) cancelAttempt = {version: current.version, command_id: crypto.randomUUID()};
  busy = true; renderControls();
  if (current.status === 'setup_pending') page.renderSetup(current, selection, busy);
  void api.request<MatchView>(`/matches/${current.id}/cancel`, {method: 'POST', body: JSON.stringify({
    expected_version: current.version, command_id: cancelAttempt.command_id,
  })}).then(() => location.assign('/play?view=room')).catch(async error => {
    if (error instanceof ApiError && error.status === 409) await safeRefresh();
    notice(errorMessage(error), true);
  }).finally(() => {
    busy = false; renderControls();
    if (view?.status === 'setup_pending') page.renderSetup(view, selection, busy);
  });
});
$('#close-card-dialog').addEventListener('click', () => $<HTMLDialogElement>('#card-dialog').close());
$('#card-dialog').addEventListener('click', event => {if (event.target === event.currentTarget) $<HTMLDialogElement>('#card-dialog').close();});
api.onExpired = login;
document.addEventListener('visibilitychange', () => {if (!document.hidden && user) void safeRefresh();});
window.addEventListener('pagehide', event => {
  connection?.close(); page.finish(); actions.finish();
  if (!event.persisted) {actions.dispose(); page.dispose();}
});
window.addEventListener('pageshow', event => {if (event.persisted && user) {connect(); void safeRefresh();}});

async function start(): Promise<void> {
  if (starting) return;
  if (matchId && !/^[a-zA-Z0-9_-]{1,80}$/.test(matchId)) {
    notice('对局编号无效。请通过房间的“进入对局”打开牌桌。', true); $('#page-state').textContent = '对局编号无效。'; return;
  }
  starting = true; $('#page-state').textContent = '正在验证登录状态…';
  try {
    user = await api.restore(); if (!user) {login(); return;}
    $('#account-name').textContent = user.username || user.email;
    connect(); await safeRefresh();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) login();
    else {$('#page-state').textContent = '登录状态暂未同步，请刷新重试。'; notice(errorMessage(error), true);}
  } finally {starting = false;}
}
void start();
