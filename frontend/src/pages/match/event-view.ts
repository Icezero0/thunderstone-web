import type {MatchView} from '../../shared/api/types.js';
import {$, el} from './dom.js';
import {valueLabel} from './commands.js';

type PublicEvent = MatchView['event_log'][number];

/** Describe only the public projection; never dump engine payloads into the page. */
export function eventDescription(view: MatchView, event: PublicEvent): string | null {
  const text = (key: string) => typeof event[key] === 'string' ? event[key] as string : '';
  const number = (key: string) => typeof event[key] === 'number' ? String(event[key]) : '—';
  const player = (key = 'player_id') => view.players.find(player => player.player_id === text(key))?.display_name ?? '玩家';
  const card = (key = 'card_id') => view.cards[text(key)]?.name ?? '卡牌';
  const cards = () => Array.isArray(event.card_ids) ? event.card_ids.map(id => view.cards[String(id)]?.name ?? '卡牌').join('、') : '';
  switch (event.kind) {
    case 'TURN_STARTED': return `${player()}的回合开始。`;
    case 'TURN_ENDED': return `${player()}的回合结束。`;
    case 'turn_passed': return `回合交给${player('to_player_id')}。`;
    case 'ACTION_ENTERED': return `${player()}选择${valueLabel(view, text('action'))}。`;
    case 'ACTION_EXITED': return null;
    case 'village_abilities_started': return `${player()}开始使用村庄能力。`;
    case 'village_abilities_finished': return `${player()}结束使用村庄能力。`;
    case 'village_gold_counted': return `${player()}本次可用金币：${number('total')}。`;
    case 'village_upgrade_started': return `${player()}开始升级英雄。`;
    case 'card_bought': return `${player()}以 ${number('price')} 金币购买${card()}，剩余 ${number('gold_remaining')} 金币。`;
    case 'hero_upgraded': return `${player()}花费 ${number('xp_cost')} 经验，将${card('source_card_id')}升级为${card('target_card_id')}。`;
    case 'ability_activated': return `${player()}${event.reused ? '再次发动' : '发动'}${card()}的能力。`;
    case 'spell_used': return `${player()}使用${card()}。`;
    case 'weapon_equipped': return `${player()}完成装备：${cards()}。`;
    case 'battle_team_submitted': return `${player()}提交战斗队伍。`;
    case 'battle_team_revision_required': return `${player()}需要重新调整战斗队伍。`;
    case 'rest_card_destroyed': return `${player()}在休息时摧毁${card()}。`;
    case 'card_destroyed': return `${text('player_id') ? player() + '的' : ''}${card()}被摧毁。`;
    case 'cards_drawn': return `${player()}抽取 ${number('count')} 张牌。`;
    case 'turn_hand_discarded': return `${player()}弃掉 ${number('count')} 张手牌。`;
    case 'dungeon_hand_revealed': case 'cards_shown': return `${player()}展示：${cards() || '没有卡牌'}。`;
    case 'battle_target_declared': return `${player()}攻击阶层 ${number('rank')} 的${card()}。`;
    case 'battle_resolved': {
      const outcome = event.outcome === 'win' ? '胜利' : event.outcome === 'loss' ? '失败' : '未能击败';
      const calculation = event.calculation && typeof event.calculation === 'object' ? event.calculation as Record<string, unknown> : {};
      const effective = typeof calculation.effective_attack === 'number' ? String(calculation.effective_attack) : '—';
      return `对战${card('target_card_id')}：${outcome}；有效攻击 ${effective}，目标生命 ${number('health')}。`;
    }
    case 'monster_defeated': return `${player()}击败${card()}，获得 ${number('xp_gained')} 经验。`;
    case 'thunderstone_acquired': case 'treasure_claimed': return `${player()}获得${card()}。`;
    case 'hall_card_entered': return `${card()}进入阶层 ${number('rank')}。`;
    case 'guardian_entered_rank_0': return `${card()}进入守护者阶层。`;
    case 'trap_revealed': return `翻开陷阱：${card()}。`;
    case 'player_eliminated': return `${player()}已被淘汰，其他玩家继续。`;
    case 'game_end_triggered': return '满足游戏结束条件，开始结算。';
    case 'game_scored': return '本局计分完成。';
    default: return null;
  }
}

export function renderEventLog(view: MatchView): void {
  const log = $('#event-log'); log.replaceChildren();
  for (const event of [...view.event_log ?? []].reverse()) {
    const description = eventDescription(view, event); if (!description) continue;
    const item = el('li'); item.append(el('small', 'muted', `#${event.sequence}`), el('span', '', description)); log.append(item);
  }
  if (!log.childElementCount) log.append(el('li', 'muted', '后续公开行动与战斗结果将显示在这里。'));
}
