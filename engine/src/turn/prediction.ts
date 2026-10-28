import {applyCommand} from './commands.js';
import type {GameCatalog, GameRules, GameState} from './transaction.js';
import {ENGINE_VERSION} from '../build-info.js';

/** A disposable calculation input, never the authoritative save or a random seed. */
export interface ActionPredictionContext {engine_version: string; state: GameState; catalog: GameCatalog; rules: GameRules; blocked_commands: string[]}
const phases = new Set(['REST', 'VILLAGE_ABILITIES', 'VILLAGE_BUY', 'VILLAGE_UPGRADE', 'ACTION_END']);
const commands = new Set(['FinishAbilities', 'BuyCard', 'FinishBuying', 'UpgradeHero', 'FinishUpgrading', 'RestDestroy', 'SkipRestDestroy']);
const stateFields = ['state_format_version', 'phase', 'subphase', 'timing_window', 'ruleset_version', 'catalog_version', 'effects_version',
  'game_version', 'turn_number', 'round_number', 'next_instance_sequence', 'next_event_sequence', 'player_order',
  'first_player_id', 'active_player_id', 'chosen_action', 'turn_hand_public', 'active_settings', 'turn_purchases'];
const playerFields = ['xp', 'temporary_gold', 'purchases_remaining', 'extra_basic_purchases', 'turn_gold_adjustment', 'rest_destroyed_on_turn', 'eliminated'];
const pick = (value: Record<string, any>, keys: string[]) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]));
const nonempty = (value: any) => value && Object.keys(value).length > 0;

/** Explicit visibility boundary. Hidden inventories and draw ordering never enter browser prediction. */
export function projectActionPrediction(state: GameState, viewer: string, catalog: GameCatalog, rules: GameRules): ActionPredictionContext | null {
  if (viewer !== state.active_player_id || state.phase !== 'PLAYING' || !phases.has(state.subphase) || state.pending_choice
    || state.battle_context || ['resolution_frames', 'workflow_steps', 'registered_triggers', 'scheduled_effects',
      'continuous_effects', 'attachments', 'copied_heroes', 'borrowed_cards', 'effect_collections'].some(key => nonempty(state[key]))) return null;
  const zones: Record<string, string[]> = {}, instances: GameState = {};
  for (const player of state.player_order) for (const zone of ['draw', 'hand', 'discard', 'control']) zones[`player:${player}:${zone}`] = [];
  zones.destroyed = [];
  for (const [zone, pile] of Object.entries(state.zones) as [string, string[]][]) {
    if (!(zone === 'settings' || /^(hall:|hero_supply:|village_supply:)/.test(zone)
      || ['hand', 'discard', 'control'].some(part => zone === `player:${viewer}:${part}`))) continue;
    zones[zone] = [...pile];
    for (const id of pile) {
      const instance = state.instances[id];
      // Complex instance-local effects need the authoritative interpreter for now.
      if (!instance || Object.keys(instance.flags ?? {}).some(key => key !== 'upgraded_on_turn')) return null;
      instances[id] = pick(instance, ['card_id', 'owner_player_id', 'origin', 'flags']);
    }
  }
  const cardIds = new Set<string>([...Object.values(instances).map((i: any) => i.card_id), ...state.supply_rules.basic_card_ids]);
  const groups = (catalog.setup_index.groups ?? []).filter((g: any) => ['hero', 'village'].includes(g.kind) && g.members.some((id: string) => cardIds.has(id)));
  for (const group of groups) for (const id of group.members) cardIds.add(id);
  const mechanics = rules.mechanics.filter(rule => cardIds.has(rule.source_card_id));
  if (mechanics.some(rule => rule.op === 'refill_empty_supply')) return null; // Consumes RNG and introduces a new supply.
  const projected: GameState = {...pick(state, stateFields), zones, instances,
    players: Object.fromEntries(state.player_order.map((id: string) => [id, pick(state.players[id], playerFields)])),
    pending_choice: null, battle_context: null, resolution_frames: [], workflow_steps: [], registered_triggers: [],
    scheduled_effects: [], continuous_effects: [], ability_uses: {}, used_cards: [],
    supply_rules: {basic_card_ids: [...state.supply_rules.basic_card_ids]}};
  const blocked_commands = [['BuyCard', 'CARD_PURCHASED'], ['UpgradeHero', 'HERO_UPGRADED']].filter(([, event]) =>
    rules.abilities.some(a => cardIds.has(a.source_card_id) && a.kind === 'triggered' && a.event === event)).map(([command]) => command);
  return {engine_version: ENGINE_VERSION, state: projected, blocked_commands,
    catalog: {cards: Object.fromEntries([...cardIds].map(id => [id, pick(catalog.cards[id], [
      'card_id', 'name', 'tags', 'card_type', 'subcategory', 'wiki_购买价格', 'wiki_金币值', 'wiki_英雄等级', 'upgrade_xp_cost'])])),
    setup_index: {cards_csv_sha256: catalog.setup_index.cards_csv_sha256,
      groups: structuredClone(groups)}},
    rules: {version: rules.version, mechanics: structuredClone(mechanics),
      abilities: []}};
}

/** Same transition implementation as the server. Unknown effects are an explicit authority barrier. */
export function predictAction(context: ActionPredictionContext, command: Record<string, any>) {
  if (context.engine_version !== ENGINE_VERSION || !commands.has(command.type) || context.blocked_commands.includes(command.type)) return null;
  try {
    const result = applyCommand({...context.state, rng_state: {algorithm: 'sha256-counter-v1', seed: 'unused-preview-stream', counter: 0}}, {...command, player_id: context.state.active_player_id,
      expected_version: context.state.game_version}, context.catalog, context.rules);
    if (result.state.pending_choice || result.state.rng_state.counter !== 0 || !phases.has(result.state.subphase)) return null;
    const {rng_state: _unused, ...state} = result.state;
    return {...result, state, context: {...context, state}};
  } catch {return null;} // A failed preview is not a rejected authoritative command.
}
