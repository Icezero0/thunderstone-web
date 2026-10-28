import {ENGINE_VERSION} from '../build-info.js';
import type {PreviewContext} from './preview.js';
import {battleTeamOptions, createBattleDraft} from './team.js';
import {equipmentNeedsResolution} from './equipment.js';
import {affectsBattleOutcome} from '../effects/outcome-impact.js';
import type {GameCatalog, GameRules, GameState} from '../turn/transaction.js';

const stats = (value: any) => Object.fromEntries(['attack', 'magic_attack', 'light', 'strength']
  .filter(key => typeof value?.[key] === 'number').map(key => [key, value[key]]));

/** Keep resolved numbers while removing references to cards outside the visible input. */
function visibleContext(raw: Record<string, any>, ids: Set<string>): Record<string, any> {
  const result: Record<string, any> = {};
  const list = (value: any) => (Array.isArray(value) ? value : []).filter(id => ids.has(id));
  for (const key of ['zero_weapon_weight', 'convert_all_magic', 'convert_equipped_magic', 'cannot_defeat'])
    if (typeof raw[key] === 'boolean') result[key] = raw[key];
  for (const key of ['target_rank', 'health_modifier', 'damage_divisor'])
    if (typeof raw[key] === 'number') result[key] = raw[key];
  for (const key of ['hero_battle_modifiers', 'modifiers']) if (raw[key]) result[key] = stats(raw[key]);
  for (const key of ['excluded_participants', 'convert_card_magic', 'disease_order'])
    if (raw[key]) result[key] = list(raw[key]);
  if (raw.used_card_tags) result.used_card_tags = raw.used_card_tags.filter((tag: any) => typeof tag === 'string');
  if (raw.flag_sources) result.flag_sources = Object.fromEntries(Object.entries(raw.flag_sources)
    .filter(([flag, card]) => ['zero_weapon_weight', 'convert_all_magic', 'convert_equipped_magic', 'cannot_defeat'].includes(flag) && typeof card === 'string'));
  if (ids.has(raw.target_instance_id)) result.target_instance_id = raw.target_instance_id;
  for (const key of ['equipment_draw_counts', 'spell_cast_counts', 'monster_health_modifiers']) if (raw[key])
    result[key] = Object.fromEntries(Object.entries(raw[key]).filter(([id, value]) => ids.has(id) && typeof value === 'number'));
  if (raw.card_modifiers) result.card_modifiers = Object.fromEntries(Object.entries(raw.card_modifiers)
    .filter(([id]) => ids.has(id)).map(([id, value]) => [id, stats(value)]));
  if (raw.strength_penalty_assignments) result.strength_penalty_assignments = Object.fromEntries(
    Object.entries(raw.strength_penalty_assignments).filter(([id, target]) => ids.has(id) && ids.has(target as string)));
  if (raw.disease_penalty_assignments) result.disease_penalty_assignments = Object.fromEntries(
    Object.entries(raw.disease_penalty_assignments).filter(([id, type]) => ids.has(id) && ['attack', 'magic_attack'].includes(type as string)));
  if (raw.equipped_weapon_by_hero) result.equipped_weapon_by_hero = Object.fromEntries(
    Object.entries(raw.equipped_weapon_by_hero).filter(([id]) => ids.has(id))
      .map(([id, weapons]) => [id, list(Array.isArray(weapons) ? weapons : [weapons])]));
  if (raw.battle_team) result.battle_team = {hero_instance_ids: list(raw.battle_team.hero_instance_ids),
    support_instance_ids: list(raw.battle_team.support_instance_ids)};
  if (raw.modifier_sources) result.modifier_sources = raw.modifier_sources
    .filter((item: any) => ['attack', 'magic_attack', 'light', 'strength'].includes(item.field) && typeof item.amount === 'number')
    .map((item: any) => {
      const visible = ids.has(item.source_instance_id);
      // A departed source can already be excluded by a resolved effect. Fold
      // that fixed subtraction into the aggregate before removing its identity.
      if (!visible && item.source_instance_id !== null && raw.excluded_participants?.includes(item.source_instance_id)) {
        result.modifiers ??= {};
        result.modifiers[item.field] = (result.modifiers[item.field] ?? 0) - item.amount;
      }
      return {source_instance_id: visible ? item.source_instance_id : null, field: item.field, amount: item.amount,
        ...(typeof item.source_card_id === 'string' ? {source_card_id: item.source_card_id} : {})};
    });
  return result;
}

/** Project visible inputs only: no RNG, draw piles, opponents, workflows or private flags. */
export function projectBattleContext(state: GameState, catalog: GameCatalog, rules: GameRules): PreviewContext {
  const player = state.active_player_id, hand = `player:${player}:hand`;
  const zones = Object.fromEntries(Object.entries(state.zones).filter(([name]) => name === hand || name === 'settings' || name.startsWith('hall:')));
  const ids = new Set((Object.values(zones).flat() as string[]).filter(id => typeof id === 'string'));
  const instances = Object.fromEntries([...ids].map(id => [id, {card_id: state.instances[id].card_id}]));
  const copied = Object.fromEntries(Object.entries(state.copied_heroes ?? {}).filter(([id]) => ids.has(id))
    .map(([id, item]: [string, any]) => [id, {card_ids: [...item.card_ids],
      full_card: !!item.full_card, preserve_attack: !!item.preserve_attack}])) as any;
  const cardIds = new Set([...Object.values(instances).map(item => item.card_id), ...state.active_settings]);
  for (const copy of Object.values(copied) as any[]) for (const id of copy.card_ids) cardIds.add(id);
  const context = visibleContext(state.battle_context ?? {}, ids);
  for (const id of Object.values(context.flag_sources ?? {}) as string[]) cardIds.add(id);
  for (const item of context.modifier_sources ?? []) if (item.source_card_id) cardIds.add(item.source_card_id);
  for (const item of state.continuous_effects ?? []) if (item.source_card_id) cardIds.add(item.source_card_id);
  const result: PreviewContext = {
    schema_version: 'thunderstone.preview/1', engine_version: ENGINE_VERSION,
    game_version: state.game_version, catalog_version: state.catalog_version,
    effects_version: state.effects_version, player_id: player,
    battle_effect_sources: rules.abilities.filter(ability => ability.kind === 'triggered' && ability.event === 'BATTLE_BEFORE_OUTCOME')
      .flatMap(ability => {
        const affects_outcome = affectsBattleOutcome(ability.body);
        if (state.active_settings.includes(ability.source_card_id)) return [{source_instance_id: null, source_zone: 'settings', affects_outcome}];
        return [...ids].filter(id => (instances[id].card_id === ability.source_card_id || copied[id]?.card_ids.includes(ability.source_card_id))
          && (ability.source_zone === 'active_hand' ? (zones[hand] as string[] | undefined)?.includes(id) : ['battle_target', 'hall'].includes(ability.source_zone)
            && Object.entries(zones).some(([zone, pile]) => zone.startsWith('hall:') && (pile as string[]).includes(id))))
          .map(id => ({source_instance_id: id as string | null, source_zone: ability.source_zone, affects_outcome}));
      }).concat([...(state.registered_triggers ?? []), ...(state.scheduled_effects ?? []).filter((item: any) =>
        item.player_id === player && item.turn_number === state.turn_number)]
        .some(item => item.event === 'BATTLE_BEFORE_OUTCOME' && (!item.body || affectsBattleOutcome(item.body)))
        ? [{source_instance_id: null, source_zone: 'scheduled', affects_outcome: true}] : []),
    cards: Object.fromEntries([...cardIds].map(id => [id, catalog.cards[id]])),
    mechanics: rules.mechanics.filter(rule => cardIds.has(rule.source_card_id)),
    state: {active_player_id: player, players: {[player]: {xp: state.players[player].xp}},
      active_settings: state.active_settings, instances, zones: zones as Record<string, string[]>,
      battle_context: context, copied_heroes: copied,
      continuous_effects: (state.continuous_effects ?? []).map((item: any) => ({kind: item.kind,
        scope: item.scope, player_id: item.player_id, amount: item.amount,
        ...(item.until ? {until: item.until} : {}),
        ...(item.source_card_id ? {source_card_id: item.source_card_id} : {})})),
      attachments: Object.fromEntries(Object.entries(state.attachments ?? {}).filter(([id]) => ids.has(id))
        .map(([id, items]) => [id, (items as any[]).map(item => ({kind: item.kind}))]))},
  };
  return structuredClone(result);
}
export function battlePreparationResult(state: GameState, catalog: GameCatalog, rules: GameRules) {
  const context = projectBattleContext(state, catalog, rules);
  const draft = createBattleDraft(context);
  if (state.subphase === 'DUNGEON_DECLARE') Object.assign(draft, context.state.battle_context!.battle_team);
  const options = battleTeamOptions(context);
  return {context, options: {...options, immediate_equipment_instance_ids:
    options.weapon_instance_ids.filter(id => equipmentNeedsResolution(state, rules, id))}, draft};
}
