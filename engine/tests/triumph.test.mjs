import test from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {fixture, rules, cards} from './support/catalog.mjs';

function apply(f, command) {
  const input = {...command, player_id: 'alice', expected_version: f.state.game_version};
  const before = structuredClone(f.state), result = server.applyCommand(f.state, input, f.catalog, f.rules);
  assert.deepEqual(browser.applyCommand(f.state, input, f.catalog, f.rules), result);
  assert.deepEqual(f.state, before); f.state = result.state; return result;
}
function fight(f, {won = true, benched = [], equipment = {}} = {}) {
  f.state.battle_context.modifiers = {attack: won ? 999 : -999};
  const prepared = server.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  prepared.draft.hero_instance_ids = prepared.draft.hero_instance_ids.filter(id => !benched.includes(id));
  prepared.draft.equipment = equipment;
  apply(f, server.buildSubmitBattleTeamCommand(prepared.context, prepared.draft));
  return apply(f, {type: 'DeclareBattleTarget', target_instance_id: f.hall[0]});
}

test('all printed triumph lines have their own timing and purchases spend produced gold', () => {
  const lines = Object.values(cards).flatMap(card => card.effect_text.split('\n').flatMap((line, index) =>
    line.startsWith('凯旋：') ? [`${card.card_id}-A${String(index + 1).padStart(2, '0')}`] : []));
  assert.equal(lines.length, 17);
  assert.deepEqual(rules.abilities.filter(a => a.event === 'BATTLE_TRIUMPH').map(a => a.id).sort(), lines.sort());
  for (const id of lines) {
    const ability = rules.abilities.find(a => a.id === id);
    if (ability.body.op === 'buy') assert.equal(ability.body.payment, 'gold');
  }
});

test('triumph counts equipped and marked hand cards once; purchases share gold before destruction and departure', () => {
  const f = fixture(['TS-0340', 'TS-0358', 'TS-0002', ...Array(4).fill('TS-0003')], ['TS-0605', 'TS-0605', 'TS-0605']);
  f.add('TS-0605', 'dungeon:main');
  const [marked, other, weapon] = f.hand;
  f.state.instances[marked].flags.pending_after_battle_destruction = true;
  // Already discarded cards must not generate coins.
  f.add('TS-0003', 'player:alice:discard');
  const total = f.hand.reduce((sum, id) => sum + Number(f.cards[f.state.instances[id].card_id].wiki_金币值 || 0), 0);
  const first = fight(f, {equipment: {[marked]: [weapon]}}), events = [...first.events];
  assert.equal(f.state.pending_choice.kind, 'effect_purchase');
  assert.equal(f.state.resolving_event, 'BATTLE_TRIUMPH');
  assert.equal(f.state.players.alice.temporary_gold, total);
  const counted = events.find(e => e.kind === 'triumph_gold_counted');
  assert.ok(counted.sources.some(row => row.instance_id === weapon));
  assert.ok(f.state.zones['player:alice:hand'].includes(marked));
  assert.ok(f.state.zones['hall:main'].includes(f.hall[0]));
  assert.equal(events.some(e => e.kind === 'card_destroyed'), false);
  const price = f.state.pending_choice.options.find(option => option.card_id === 'TS-0002').price;
  events.push(...apply(f, {type: 'ResolveEffectPurchase', card_id: 'TS-0002'}).events);
  assert.equal(f.state.pending_choice.source_instance_id, other);
  assert.equal(f.state.players.alice.temporary_gold, total - price);
  assert.ok(f.state.pending_choice.options.every(option => option.budget === total - price && option.price <= option.budget));
  events.push(...apply(f, {type: 'ResolveEffectPurchase', card_id: 'TS-0002'}).events);
  assert.equal(f.state.pending_choice, null);
  assert.equal(f.state.players.alice.temporary_gold, total - 2 * price);
  assert.equal(events.filter(e => e.kind === 'triumph_gold_counted').length, 1);
  const bought = events.map((e, i) => e.kind === 'effect_purchase_completed' ? i : -1).filter(i => i >= 0);
  const destroyed = events.findIndex(e => e.kind === 'card_destroyed' && e.instance_id === marked);
  assert.ok(bought.length === 2 && bought.at(-1) < destroyed);
  assert.ok(destroyed < events.findIndex(e => e.kind === 'monster_defeated'));
  assert.ok(f.state.zones.destroyed.includes(marked));
});

for (const won of [true, false]) test(`a marked hero's XP triumph resolves before removal only on victory: ${won}`, () => {
  const f = fixture(['TS-0323'], ['TS-0605', 'TS-0605', 'TS-0605']);
  const hero = f.hand[0]; f.state.instances[hero].flags.pending_after_battle_destruction = true;
  const result = fight(f, {won});
  const resolved = result.events.findIndex(e => e.kind === 'ability_resolved' && e.ability_id === 'TS-0323-A03');
  const removed = result.events.findIndex(e => e.kind === 'card_destroyed' && e.instance_id === hero);
  if (won) assert.ok(resolved >= 0 && resolved < removed);
  else assert.equal(resolved, -1);
  assert.equal(f.state.players.alice.xp, won ? 1 + Number(f.cards['TS-0605'].defeat_xp_reward) : 0);
});

test('benched and immediately destroyed heroes cannot grant triumph', () => {
  const f = fixture(['TS-0323'], ['TS-0605', 'TS-0605', 'TS-0605']);
  const result = fight(f, {benched: f.hand});
  assert.equal(result.events.some(e => e.kind === 'triumph_gold_counted'), false);
  const gone = fixture([], ['TS-0605', 'TS-0605', 'TS-0605']); gone.add('TS-0323', 'destroyed');
  assert.equal(fight(gone).events.some(e => e.kind === 'triumph_gold_counted'), false);
});

test('monster triumph allows an affordable food purchase while the monster still occupies its rank', () => {
  const f = fixture(['TS-0003'], ['TS-0579', 'TS-0605', 'TS-0605']);
  const result = fight(f);
  assert.equal(result.state.pending_choice.ability_id, 'TS-0579-A02');
  assert.ok(result.state.zones['hall:main'].includes(f.hall[0]));
  assert.deepEqual(result.state.pending_choice.options.map(o => o.card_id), ['TS-0004']);
  const done = apply(f, {type: 'ResolveEffectPurchase', card_id: 'TS-0004'});
  assert.ok(done.events.findIndex(e => e.kind === 'effect_purchase_completed') < done.events.findIndex(e => e.kind === 'monster_defeated'));
});

test('declining a triumph purchase resumes destruction and never charges gold', () => {
  const f = fixture(['TS-0340', 'TS-0003', 'TS-0003'], ['TS-0605', 'TS-0605', 'TS-0605']);
  f.state.instances[f.hand[0]].flags.pending_after_battle_destruction = true;
  fight(f); const gold = f.state.players.alice.temporary_gold;
  const done = apply(f, {type: 'ResolveEffectPurchase', card_id: null});
  assert.equal(f.state.players.alice.temporary_gold, gold);
  assert.equal(f.state.subphase, 'ACTION_END');
  assert.ok(done.events.some(e => e.kind === 'card_destroyed'));
});
