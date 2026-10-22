import {ENGINE_VERSION} from '../build-info.js';
import type {PreviewContext} from './preview.js';
import {battleTeamOptions, createBattleDraft} from './team.js';
import type {GameCatalog, GameRules, GameState} from '../turn/transaction.js';

const FIELDS = ['battle_team', 'equipped_weapon_by_hero', 'card_modifiers', 'strength_penalty_assignments',
  'hero_battle_modifiers', 'equipment_draw_counts', 'zero_weapon_weight', 'excluded_participants',
  'convert_all_magic', 'convert_equipped_magic', 'convert_card_magic', 'modifiers', 'modifier_sources',
  'disease_order', 'disease_penalty_assignments', 'cannot_defeat', 'used_card_tags', 'target_instance_id',
  'target_rank', 'health_modifier', 'monster_health_modifiers'];

/** Project visible inputs only: no RNG, draw piles, opponents, workflows or private flags. */
export function projectBattleContext(state: GameState, catalog: GameCatalog, rules: GameRules): PreviewContext {
  const player = state.active_player_id, hand = `player:${player}:hand`;
  const zones = Object.fromEntries(Object.entries(state.zones).filter(([name]) => name === hand || name.startsWith('hall:')));
  const ids = new Set(Object.values(zones).flat() as string[]);
  const instances = Object.fromEntries([...ids].map(id => [id, {card_id: state.instances[id].card_id}]));
  const copied = Object.fromEntries(Object.entries(state.copied_heroes ?? {}).filter(([id]) => ids.has(id))) as any;
  const cardIds = new Set([...Object.values(instances).map(item => item.card_id), ...state.active_settings]);
  for (const copy of Object.values(copied) as any[]) for (const id of copy.card_ids) cardIds.add(id);
  const context = Object.fromEntries(FIELDS.filter(key => state.battle_context?.[key] !== undefined)
    .map(key => [key, state.battle_context[key]]));
  const result: PreviewContext = {
    schema_version: 'thunderstone.preview/1', engine_version: ENGINE_VERSION,
    game_version: state.game_version, catalog_version: state.catalog_version,
    effects_version: state.effects_version, player_id: player,
    cards: Object.fromEntries([...cardIds].map(id => [id, catalog.cards[id]])),
    mechanics: rules.mechanics.filter(rule => cardIds.has(rule.source_card_id)),
    state: {active_player_id: player, players: {[player]: {xp: state.players[player].xp}},
      active_settings: state.active_settings, instances, zones: zones as Record<string, string[]>,
      battle_context: context, copied_heroes: copied,
      continuous_effects: (state.continuous_effects ?? []).map((item: any) => ({kind: item.kind,
        scope: item.scope, player_id: item.player_id, amount: item.amount})),
      attachments: Object.fromEntries(Object.entries(state.attachments ?? {}).filter(([id]) => ids.has(id))
        .map(([id, items]) => [id, (items as any[]).map(item => ({kind: item.kind}))]))},
  };
  return structuredClone(result);
}
export function battlePreparationResult(state: GameState, catalog: GameCatalog, rules: GameRules) {
  const context = projectBattleContext(state, catalog, rules);
  return {context, options: battleTeamOptions(context), draft: createBattleDraft(context)};
}
