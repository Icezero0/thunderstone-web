import type {MatchView} from '../../shared/api/types.js';
import {actionProgress} from './model.js';

export interface MatchPlayerActivity {playerId: string; text: string;}

/** Convert new public summaries into transient messages; never inspect hidden state. */
export function playerActivity(view: MatchView, previous: MatchView | null,
  events: MatchView['event_log']): MatchPlayerActivity | null {
  if (view.status !== 'active' || !view.turn || view.unavailable_reason) return null;
  const playerId = view.turn.active_player_id;
  const changed = previous && (previous.turn?.number !== view.turn.number || previous.turn?.active_player_id !== playerId);
  if (changed || !previous && view.turn.subphase === 'TURN_START')
    return playerId !== view.viewer_player_id ? {playerId, text: '展示了手牌'} : null;
  if (!previous) return null; // A fresh page must not replay historical actions.
  const name = (value: unknown) => typeof value === 'string' ? view.cards[value]?.name ?? value : '一张卡牌';
  for (const event of [...events].reverse()) {
    const actor = typeof event.player_id === 'string' ? event.player_id
      : event.kind === 'battle_resolved' ? playerId : null;
    if (!actor || actor === view.viewer_player_id) continue;
    let text: string | undefined;
    switch (event.kind) {
      case 'rest_card_destroyed': text = `摧毁了 ${name(event.card_id)}`; break;
      case 'village_gold_counted': text = `生产了 ${event.total} 金币`; break;
      case 'village_upgrade_started':
        if (view.turn.subphase !== 'ACTION_END' && !events.some(item => item.player_id === actor && ['card_bought', 'hero_upgraded'].includes(item.kind)))
          text = '开始升级英雄';
        break;
      case 'card_bought': text = `购买了 ${name(event.card_id)}`; break;
      case 'hero_upgraded': text = `将 ${name(event.source_card_id)} 升级为 ${name(event.target_card_id)}`; break;
      case 'battle_resolved': text = event.outcome === 'win' ? '战斗胜利' : '战斗失败'; break;
      case 'cards_shown': {
        const cards = Array.isArray(event.card_ids) ? event.card_ids : [];
        const count = view.players.find(player => player.player_id === actor)?.hand_count;
        text = cards.length && cards.length !== count ? `展示了 ${cards.map(name).join('、')}` : '展示了手牌'; break;
      }
    }
    if (text) return {playerId: actor, text};
  }
  if (playerId !== view.viewer_player_id && previous.turn?.subphase !== view.turn.subphase) {
    if (previous.turn?.subphase === 'REST' && view.turn.subphase === 'ACTION_END')
      return {playerId, text: '跳过了摧毁手牌'};
    const completed = actionProgress(previous);
    if (completed) return {playerId, text: `完成了${completed.stage}`};
  }
  return null;
}
