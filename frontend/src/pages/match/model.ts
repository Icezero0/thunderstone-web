import type {MatchView} from '../../shared/api/types.js';

export interface SetupSelection {groupA: string[]; featureA: string[]}
export function setupSelection(view: MatchView, previous?: SetupSelection): SetupSelection {
  const choice = view.setup_choice;
  return {groupA: (previous?.groupA ?? []).filter(id => choice?.group_ids.includes(id)),
    featureA: (previous?.featureA ?? []).filter(id => choice?.feature_ids.includes(id))};
}
export function allocation(view: MatchView, selection: SetupSelection) {
  const choice = view.setup_choice;
  const selected = new Set(selection.groupA), features = new Set(selection.featureA);
  const groupA = choice?.group_ids.filter(id => selected.has(id)) ?? [];
  const featureA = choice?.feature_ids.filter(id => features.has(id)) ?? [];
  return {groupA, groupB: choice?.group_ids.filter(id => !selected.has(id)) ?? [],
    featureA, featureB: choice?.feature_ids.filter(id => !features.has(id)) ?? [],
    valid: !!choice && groupA.length === choice.group_a_count};
}
export function matchHeading(view: MatchView): {title: string; detail: string} {
  if (view.status === 'cancelled') return {title: '本局已取消', detail: '返回房间后可以重新配置和准备'};
  if (view.status === 'finished') return {title: '这场冒险告一段落', detail: '对局已结束，可以查看最终结果并返回房间'};
  if (view.status === 'setup_pending') return {title: '分配两座地下城', detail: '飞龙尖塔 · 等待房主确认怪物与特征分配'};
  const active = view.players.find(player => player.player_id === view.turn?.active_player_id);
  return {title: active ? `${active.display_name}的回合` : '牌桌已就绪',
    detail: view.turn ? `第 ${view.turn.round} 轮 · 第 ${view.turn.number} 回合${active?.is_you ? ' · 轮到你' : ''}` : '开局配置已完成'};
}
export function phaseLabel(phase?: string): string {
  const phases: Record<string, string> = {TURN_START: '回合开始', VILLAGE_ABILITIES: '村庄能力',
    VILLAGE_BUY: '村庄购买', VILLAGE_UPGRADE: '英雄升级', REST: '休整', ACTION_END: '结束回合', DUNGEON_PREPARE: '地下城准备',
    BATTLE_COMMIT: '确认战斗', BATTLE_EFFECTS: '战斗效果', BATTLE_AFTER_EFFECTS: '战斗后效果',
    ACTION_EXIT_EFFECTS: '行动结束', TURN_END_EFFECTS: '回合结束', GAME_END: '对局结算'};
  return phase ? phases[phase] ?? '对局进行中' : '等待开局';
}

/** Automatic hand disclosure keeps its rule stage without requiring an extra command. */
export function actionProgress(view: MatchView) {
  const turn = view.turn;
  if (view.status !== 'active' || !turn || !turn.chosen_action) return undefined;
  const stages = {
    village: ['展示手牌', '使用村庄效果', '生产金币', '购买卡牌', '升级英雄', '结束回合'],
    dungeon: ['展示手牌', '构建战斗队伍', '宣言战斗', '结算战斗', '结束回合'],
    rest: ['摧毁手牌', '结束回合'],
  };
  const labels = {village: '访问村庄', dungeon: '进入地下城', rest: '休整'};
  const action = turn.chosen_action, list = stages[action];
  const window = turn.resolving_event ?? view.pending_choice?.event ?? turn.timing_window;
  let step: number | undefined;
  if (['ACTION_END', 'ACTION_EXIT_EFFECTS', 'TURN_END_EFFECTS'].includes(turn.subphase)) step = list.length;
  else if (action === 'rest') step = 1;
  else if (action === 'village') {
    step = window === 'VILLAGE_ENTER' ? 1 : window === 'VILLAGE_GOLD' ? 3
      : ({VILLAGE_ABILITIES: 2, VILLAGE_BUY: 4, VILLAGE_UPGRADE: 5} as Record<string, number>)[turn.subphase];
  } else {
    step = window === 'DUNGEON_ENTER' ? 1
      : ({DUNGEON_PREPARE: 2, BATTLE_COMMIT: 3, BATTLE_EFFECTS: 4, BATTLE_AFTER_EFFECTS: 4} as Record<string, number>)[turn.subphase];
  }
  return step ? {action: labels[action], stage: list[step - 1], step, total: list.length} : undefined;
}

/** Restrict images to the asset namespace; card data never becomes arbitrary HTML. */
export function cardImageUrl(value: string): string | null {
  return /^\/cards\/TS-\d{4}\.png$/.test(value) ? value : null;
}
