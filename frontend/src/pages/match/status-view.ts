import type {MatchView} from '../../shared/api/types.js';
import {$, el} from './dom.js';

/** Status and results remain independent of interactive card targeting. */
export function renderMatchStatus(view: MatchView): void {
  const actions = $('#turn-actions'); actions.replaceChildren();
  if (view.result) {
    $('#turn-controls-title').textContent = '对局结算';
    const winners = view.result.winner_ids.map(id => view.players.find(player => player.player_id === id)?.display_name ?? id);
    $('#turn-controls-note').textContent = winners.length ? `${winners.join('、')}获胜。` : '本局已结束。';
    const table = el('table', 'score-table'), header = el('tr');
    for (const title of ['玩家', '胜利点', '雷霆之石', '结果']) header.append(el('th', '', title)); table.append(header);
    for (const player of view.players) {
      const score = view.result.players[player.player_id]; if (!score) continue;
      const row = el('tr');
      for (const text of [player.display_name, String(score.victory_points), String(score.thunderstones), score.eliminated ? '已淘汰' : view.result.winner_ids.includes(player.player_id) ? '获胜' : '完成']) row.append(el('td', '', text));
      table.append(row);
    }
    actions.append(table); return;
  }
  const actor = view.players.find(player => player.player_id === view.actor_player_id);
  $('#turn-controls-note').textContent = view.unavailable_reason ?? (actor && actor.player_id !== view.viewer_player_id ? `等待 ${actor.display_name} ${view.pending_choice ? '处理效果选择' : '行动'}。` : '');
}
