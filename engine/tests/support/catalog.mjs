import {readFileSync} from 'node:fs';
import {compileRuleset, EFFECTS_SCHEMA_VERSION, RULESET_VERSION, RNG_VERSION} from '../../dist/index.js';

const root = new URL('../../../', import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
function csv(text) {
  const rows = [], row = []; let field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') {field += '"'; i++;} else quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (character === '\n') {rows.push([...row]); row.length = 0;}
    } else field += character;
  }
  if (field || row.length) {row.push(field); rows.push(row);}
  const headers = rows.shift(); return rows.map(values => Object.fromEntries(headers.map((key, i) => [key, values[i] ?? ''])));
}
export const cards = Object.fromEntries(csv(readFileSync(new URL('cards/cards.csv', root), 'utf8').replace(/^\uFEFF/, '')).map(card => [card.card_id, card]));
export const catalog = {cards, setup_index: json('cards/setup_catalog.json')};
export const rules = {...compileRuleset({schema_version: EFFECTS_SCHEMA_VERSION,
  abilities: ['classic-v1', 'simple-reviewed', 'action-reviewed', 'battle-reviewed', 'event-reviewed']
    .flatMap(name => json(`cards/effects/${name}.json`).abilities),
  mechanics: json('cards/effects/mechanics.json')}, cards), version: 'review-fixture-effects'};

/** Actual catalog/rules and a small complete server state, with no services or I/O writes. */
export function fixture(handCardIds = [], hallCardIds = []) {
  const state = {active_player_id: 'alice', first_player_id: 'alice', player_order: ['alice', 'bob'],
    players: {alice: {xp: 0, temporary_gold: 0, purchases_remaining: 1}, bob: {xp: 0, temporary_gold: 0, purchases_remaining: 1}},
    active_settings: [], instances: {}, zones: {}, chosen_action: 'dungeon', phase: 'PLAYING',
    subphase: 'DUNGEON_PREPARE', timing_window: 'DUNGEON_PREPARE', ruleset_version: RULESET_VERSION,
    catalog_version: catalog.setup_index.cards_csv_sha256, effects_version: rules.version,
    game_version: 1, turn_number: 1, round_number: 1, started_turn: 1, next_instance_sequence: 1, next_event_sequence: 1,
    pending_choice: null, resolution_frames: [], registered_triggers: [], scheduled_effects: [], workflow_steps: [],
    continuous_effects: [], ability_uses: {}, used_cards: [], battle_context: {equipped_weapon_by_hero: {}},
    rng_state: {algorithm: RNG_VERSION, seed: 'review-regression', counter: 0},
    supply_rules: {basic_card_ids: ['TS-0001', 'TS-0002', 'TS-0003', 'TS-0004'], basic_infinite: true,
      disease_infinite: true, disease_mode: 'normal', disease_card_ids: ['TS-0714'], disease_weights: {'TS-0714': 1}}};
  for (const player of state.player_order) for (const zone of ['hand', 'draw', 'discard', 'control']) state.zones[`player:${player}:${zone}`] = [];
  for (const zone of ['destroyed', 'pending:disease', 'hall:main', 'hall:main:rank0', 'dungeon:main']) state.zones[zone] = [];
  const fixture = {state, catalog, rules, cards, mechanics: rules.mechanics, hand: [], hall: []};
  const add = (cardId, zone = 'player:alice:hand') => {
    const state = fixture.state;
    if (!cards[cardId]) throw new Error(`Unknown fixture card: ${cardId}`);
    const id = `CI-${String(state.next_instance_sequence++).padStart(6, '0')}`;
    state.instances[id] = {card_id: cardId, owner_player_id: zone.startsWith('player:') ? zone.split(':')[1] : null, origin: 'review', flags: {}};
    (state.zones[zone] ??= []).push(id); return id;
  };
  fixture.hand = handCardIds.map(id => add(id));
  fixture.hall = hallCardIds.map(id => add(id, 'hall:main'));
  fixture.add = add;
  return fixture;
}
