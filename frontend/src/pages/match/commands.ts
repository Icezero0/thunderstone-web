import type {GameCommand, LegalCommand, MatchView, CommandOption} from '../../shared/api/types.js';

export function optionRows(command: LegalCommand): CommandOption[] {
  return (command.options ?? []).filter((option): option is CommandOption => typeof option === 'object' && option !== null);
}
export function instanceCardId(view: MatchView, instance: string): string | undefined {
  return view.command_instances?.[instance]?.card_id ?? [...view.hand, ...view.discard, ...view.settings, ...view.revealed ?? [],
    ...view.players.flatMap(player => player.control), ...view.dungeons.flatMap(dungeon => dungeon.hall)]
    .find(card => card.instance_id === instance)?.card_id;
}
export function instanceName(view: MatchView, instance: string): string {
  const card = instanceCardId(view, instance), name = card ? view.cards[card]?.name ?? card : instance;
  const index = view.hand.findIndex(item => item.instance_id === instance);
  return index >= 0 && view.hand.filter(item => item.card_id === card).length > 1 ? `${name}（手牌 ${index + 1}）` : name;
}
export function abilityText(view: MatchView, id: string, sourceInstance?: string): string {
  const ability = view.abilities?.[id], card = ability?.source_card_id ?? id.split('-A')[0];
  return `${sourceInstance ? instanceName(view, sourceInstance) : view.cards[card]?.name ?? card}${ability?.source_line ? `：${ability.source_line}` : ''}`;
}
export function valueLabel(view: MatchView, value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return String(value);
  const player = view.players.find(player => player.player_id === value); if (player) return player.display_name;
  const labels: Record<string, string> = {village: '村庄', dungeon: '地下城', rest: '休息', hero: '英雄', monster: '怪物',
    two_cards: '弃 2 张牌', pay: '支付代价', decline: '不支付', 'dungeon:main': '主地下城', 'dungeon:a': '地下城 A', 'dungeon:b': '地下城 B',
    attack: '攻击', magic_attack: '魔法攻击'};
  return labels[value] ?? value;
}
/** Only a declared command may be submitted; choices belong to their recipient. */
export function mayCommand(view: MatchView, command: GameCommand): boolean {
  return view.status === 'active' && view.actor_player_id === view.viewer_player_id
    && (view.legal_commands ?? []).some(option => option.type === command.type);
}
export function choiceCountValid(ids: string[], command: LegalCommand): boolean {
  return new Set(ids).size === ids.length && ids.every(id => command.instance_ids?.includes(id))
    && ids.length >= (command.min_count ?? 1) && ids.length <= (command.max_count ?? 1);
}
export function moveChoice(order: string[], index: number, offset: number): string[] {
  const result = [...order], next = index + offset;
  if (index >= 0 && next >= 0 && index < result.length && next < result.length)
    [result[index], result[next]] = [result[next], result[index]];
  return result;
}
