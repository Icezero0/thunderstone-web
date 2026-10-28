import {api} from '../../app/session.js';
import {matchLink, matchLoginLink} from '../../app/navigation.js';
import {ApiError} from '../../shared/api/client.js';
import {RoomConnection} from '../../shared/realtime/room-connection.js';
import type {GameCommand, MatchView, User} from '../../shared/api/types.js';
import {allocation, setupSelection, type SetupSelection} from './model.js';
import {MatchPage} from './view.js';
import {mayCommand} from './commands.js';
import {HandSortPreference} from '../../app/hand-sort-preference.js';
import {MatchHistoryPanel} from './history-panel.js';
import {downloadMatchFile, type MatchExport} from './match-export.js';
import {MatchSync} from './match-sync.js';
import {viewCursor, viewQuery, mergeMatchView} from './match-protocol.js';
import {predictMatchAction, predictionMatches} from './action-prediction.js';
import {MatchCommandQueue} from './command-queue.js';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
let matchId = new URLSearchParams(location.search).get('id');
let view: MatchView | null = null, user: User | null = null;
let selection: SetupSelection = {groupA: [], featureA: []};
let connection: RoomConnection | null = null, busy = false, starting = false, sequence = 0;
let setupAttempt: {key: string; command_id: string} | null = null;
let cancelAttempt: {version: number; command_id: string} | null = null;
let pendingCommandType: string | null = null;
let recoveryError = '';
let transportAttempt: {id: string; body: string} | null = null;
const page = new MatchPage(id => {if (view?.cards[id]) page.detail(view.cards[id]);}, (kind, id, checked) => {
  if (!view?.can_resolve_setup || busy) return;
  selection[kind] = selection[kind].filter(value => value !== id);
  if (checked) selection[kind].push(id);
  page.renderSetup(view, selection, busy);
}, command => {void sendCommand(command);}, enabled => preference.change(enabled));
const preference = new HandSortPreference(enabled => page.setAutoSort(enabled), message => page.setCommandError(message));
const historyPanel = new MatchHistoryPanel(step => {void restoreHistory(step);}, () => {void downloadMatch();}, () => {void loadHistory();});
let historyLoading = false;
async function loadHistory(): Promise<void> {
  if (!view?.sync || view.sync.history_loaded || historyLoading) return;
  const id = view.id; historyLoading = true;
  try {
    const result = await api.request<{entries: NonNullable<MatchView['history']>['entries']}>(`/matches/${id}/history`);
    if (view?.id === id && view.history && view.sync) {
      const entries = new Map([...result.entries, ...view.history.entries].map(row => [row.step, row]));
      view = {...view, history: {...view.history, entries: [...entries.values()].sort((a, b) => a.step - b.step)},
        sync: {...view.sync, history_loaded: true, history_after: Math.max(0, ...entries.keys())}};
      renderControls();
      sync.invalidate({type: 'connected'}); // Catch commands committed during the history request.
    }
  } catch (error) {page.setCommandError(errorMessage(error));}
  finally {historyLoading = false;}
}
let downloading = false;
let restoreAttempt: {key: string; command_id: string} | null = null;
const commandQueue = new MatchCommandQueue({
  predict: predictMatchAction, matches: predictionMatches,
  corrected: () => {recoveryError = '已按服务器结果更新牌桌，后续尚未提交的操作已取消。';},
  show: (value, reset) => accept(value, reset), changed: renderControls,
  send: async (current, command, commandId) => {
    current = mergeMatchView(view, current);
    pendingCommandType = command.type;
    if (transportAttempt?.id !== commandId) transportAttempt = {id: commandId,
      body: JSON.stringify({expected_version: current.version, command_id: commandId, command, ...viewCursor(current)})};
    // Manual retry after a lost response reuses the exact receipt key AND payload.
    return await api.request<MatchView>(`/matches/${current.id}/commands`, {method: 'POST', body: transportAttempt.body});
  },
  recover: async error => {
    if (error instanceof ApiError && error.status === 401) {login(); return null;}
    recoveryError = errorMessage(error); page.setCommandError(recoveryError);
    try {return await api.request<MatchView>(`/matches/${matchId}?compact=true`);}
    catch {recoveryError = '尚未确认操作结果，请恢复网络后刷新牌桌。'; page.setCommandError(recoveryError); return null;}
  },
});
const sync = new MatchSync(() => commandQueue.baseline ?? view, () => busy || commandQueue.synchronizing || commandQueue.blocked || !user, safeRefresh);

async function downloadMatch(): Promise<void> {
  if (!view || !user || busy || commandQueue.synchronizing || commandQueue.blocked || downloading || view.status === 'cancelled') return;
  const currentId = view.id, currentUser = user.id;
  downloading = true; page.setCommandError(); renderControls();
  try {
    const data = await api.request<MatchExport>(`/matches/${currentId}/export`);
    if (user?.id === currentUser && view?.id === currentId) downloadMatchFile(data);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {login(); return;}
    if (user?.id === currentUser && view?.id === currentId) page.setCommandError(errorMessage(error));
  } finally {downloading = false; renderControls();}
}

async function restoreHistory(step?: number): Promise<void> {
  if (!view || busy || commandQueue.synchronizing || commandQueue.blocked || (step === undefined ? !view.history?.can_undo : !view.history?.can_jump)) return;
  const current = view, key = `${current.id}:${current.version}:${step ?? 'undo'}`;
  if (restoreAttempt?.key !== key) restoreAttempt = {key, command_id: crypto.randomUUID()};
  busy = true; page.finish(); page.setCommandError(); renderControls();
  try {
    const result = await api.request<MatchView>(`/matches/${current.id}/history/restore`, {method: 'POST', body: JSON.stringify({
      expected_version: current.version, command_id: restoreAttempt.command_id, ...viewCursor(current), ...(step !== undefined ? {target_step: step} : {}),
    })});
    commandQueue.receive(result);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {login(); return;}
    if (error instanceof ApiError && [403, 409].includes(error.status)) await safeRefresh();
    page.setCommandError(errorMessage(error));
  } finally {busy = false; renderControls();}
}

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
  preference.receive(null);
  page.closeBrowsers();
  sequence++; view = null; user = null; connection?.close(); sync.dispose();
  commandQueue.dispose();
  $('#match-content').hidden = true; $<HTMLDialogElement>('#card-dialog').close();
  location.replace(matchLoginLink(matchId));
}
function accept(value: MatchView, reset = false): void {
  if (!reset && view?.id === value.id && value.version < view.version) return;
  value = mergeMatchView(view, value);
  const same = view?.id === value.id && view?.version === value.version;
  if (view && (view.history?.epoch ?? 0) !== (value.history?.epoch ?? 0)) {
    page.closeBrowsers(); $<HTMLDialogElement>('#card-dialog').close();
  }
  view = value; selection = setupSelection(value, same ? selection : undefined);
  if (value.status === 'cancelled') {page.closeBrowsers(); $<HTMLDialogElement>('#card-dialog').close();}
  matchId = value.id; history.replaceState(null, '', matchLink(value.id));
  page.render(value, selection, busy || commandQueue.blocked, reset);
  renderControls();
}
function renderControls(): void {
  if (!view) return;
  $('#cancel-match-bar').hidden = !['active', 'setup_pending'].includes(view.status) || user?.id !== view.host_user_id;
  const blocked = busy || commandQueue.blocked;
  $<HTMLButtonElement>('#cancel-match').disabled = blocked || commandQueue.synchronizing;
  page.controls(view, blocked, commandQueue.blocked && ['ActivateAbility', 'EquipWeapon', 'UpdatePreparationEquipment', 'AssignDiseasePenalty', 'AssignStrengthPenalty'].includes(pendingCommandType ?? ''));
  if (recoveryError) page.setCommandError(recoveryError);
  historyPanel.render(view, blocked || commandQueue.synchronizing, downloading);
  if (view.status === 'active') $('#page-state').textContent = `鼠标悬停卡牌时，按住空格检视大图。${commandQueue.pending ? ` · 正在同步 ${commandQueue.pending} 步` : ''}`;
  if (!busy) sync.resume();
}
async function sendCommand(command: GameCommand): Promise<void> {
  if (!view || busy || commandQueue.blocked || !mayCommand(view, command)) return;
  pendingCommandType = command.type; recoveryError = ''; page.setCommandError(); notice();
  if (!commandQueue.enqueue(command)) page.setCommandError('待同步操作较多，请稍候再继续。');
}
async function refresh(): Promise<void> {
  if (!user) return;
  if (commandQueue.synchronizing) {sync.invalidate({type: 'connected'}); return;}
  const request = ++sequence;
  const current = matchId ? await api.request<MatchView>(`/matches/${encodeURIComponent(matchId)}${viewQuery(view)}`)
    : (await api.request<{match: MatchView | null}>('/matches/current')).match;
  if (request !== sequence || !user) return;
  if (current) {if (commandQueue.blocked) commandQueue.recovered(current); else commandQueue.receive(current); notice();}
  else {
    page.closeBrowsers();
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
      page.closeBrowsers();
      view = null; $('#match-content').hidden = true; $('#empty-view').hidden = false;
      $<HTMLDialogElement>('#card-dialog').close();
      $('#empty-title').textContent = '这场对局暂不可访问'; $('#empty-description').textContent = '返回房间，确认当前参与的对局。';
    }
    $('#page-state').textContent = '牌桌尚未同步。'; notice(errorMessage(error), true);
  }
}
function connect(): void {
  connection?.close();
  connection = new RoomConnection(api, change => sync.invalidate(change), status => {
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
    .then(result => {commandQueue.receive(result);})
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
  if (!view || user?.id !== view.host_user_id || view.status === 'cancelled' || busy || commandQueue.synchronizing || commandQueue.blocked) return;
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
  connection?.close(); page.finish();
  if (!event.persisted) {sync.dispose(); commandQueue.dispose(); historyPanel.dispose(); preference.dispose(); page.dispose();}
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
    preference.receive(user);
    $('#account-name').textContent = user.username || user.email;
    connect(); await safeRefresh();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) login();
    else {$('#page-state').textContent = '登录状态暂未同步，请刷新重试。'; notice(errorMessage(error), true);}
  } finally {starting = false;}
}
void start();
