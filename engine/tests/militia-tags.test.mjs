import assert from 'node:assert/strict';
import test from 'node:test';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {Transition} from '../dist/turn/transaction.js';
import {queueSteps} from '../dist/turn/workflow.js';
import {fixture, rules} from './support/catalog.mjs';

const MILITIA = 'TS-0001', ELITE = 'TS-0261', OTHER_HERO = 'TS-0354';
const hand = f => f.state.zones['player:alice:hand'];
const calculation = f => ({state: f.state, cards: f.catalog.cards, mechanics: f.rules.mechanics});
function apply(f, fields) {
  const command = {player_id: f.state.pending_choice?.player_id ?? 'alice', expected_version: f.state.game_version, ...fields};
  const before = structuredClone(f.state), result = server.applyCommand(f.state, command, f.catalog, f.rules);
  assert.deepEqual(browser.applyCommand(f.state, command, f.catalog, f.rules), result);
  assert.deepEqual(f.state, before); f.state = result.state; return result;
}
function village(f) {Object.assign(f.state, {chosen_action: 'village', subphase: 'VILLAGE_ABILITIES', timing_window: 'VILLAGE_ABILITIES', battle_context: null});}
function activate(f, id, source = f.hand[0]) {return apply(f, {type: 'ActivateAbility', ability_id: id, source_instance_id: source});}
function select(f, ids) {return apply(f, {type: 'ResolveChoice', instance_ids: ids});}
function isolate(f, id) {f.rules = {...f.rules, abilities: f.rules.abilities.filter(ability => ability.id === id), mechanics: []};}
function fight(f) {
  const {context, draft} = server.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  apply(f, server.buildSubmitBattleTeamCommand(context, draft));
  return apply(f, {type: 'DeclareBattleTarget', target_instance_id: f.hall[0]});
}

for (const militia of [[ELITE], [MILITIA, ELITE, ELITE]]) test(`Highland Officer counts hand militia by tag: ${militia.join(',')}`, () => {
  const f = fixture(['TS-0231', ...militia, OTHER_HERO]);
  for (let i = 0; i < 6; i++) f.add(ELITE, 'player:alice:draw');
  const before = hand(f).length, result = activate(f, 'TS-0231-A02');
  assert.equal(hand(f).length, before + militia.length, 'newly drawn militia do not extend the original count');
  assert.equal(result.events.find(event => event.kind === 'effect_draw').requested, militia.length);
});

test('Highland Officer grants a restricted purchase that can buy elite militia and preserves ordinary purchases', () => {
  const f = fixture(['TS-0231']); village(f);
  f.add('TS-0003', 'player:alice:draw'); f.add(ELITE, 'village_supply:elite');
  f.add(OTHER_HERO, 'hero_supply:other');
  activate(f, 'TS-0231-A01'); assert.equal(f.state.players.alice.extra_basic_purchases, 1);
  apply(f, {type: 'FinishAbilities'});
  f.state.players.alice.purchases_remaining = 0; f.state.players.alice.temporary_gold = 20;
  const options = server.legalCommands(f.state, f.catalog, f.rules).find(command => command.type === 'BuyCard').card_ids;
  assert.deepEqual(options, [MILITIA, ELITE]);
  const price = server.purchasePrice(calculation(f), f.cards[ELITE]);
  f.state.players.alice.temporary_gold = price - 1;
  assert.equal(server.legalCommands(f.state, f.catalog, f.rules).find(command => command.type === 'BuyCard').card_ids.includes(ELITE), false);
  f.state.players.alice.temporary_gold = 20; f.state.players.alice.purchases_remaining = 1;
  apply(f, {type: 'BuyCard', card_id: ELITE});
  assert.equal(f.state.players.alice.extra_basic_purchases, 0);
  // The original purchase survives, and elite militia's own purchase trigger grants one more.
  assert.equal(f.state.players.alice.purchases_remaining, 2);
  assert.equal(f.state.players.alice.temporary_gold, 20 - price);
});

for (const militia of [MILITIA, ELITE, OTHER_HERO]) test(`Short Spear checks its equipper's militia tag: ${militia}`, () => {
  const f = fixture([militia, 'TS-0253']), [hero, spear] = f.hand;
  f.state.battle_context.equipped_weapon_by_hero = {[hero]: [spear]}; f.add('TS-0003', 'player:alice:draw');
  const trace = server.combatValues(calculation(f), 0), expected = militia === OTHER_HERO ? 1 : 3;
  assert.equal(trace.components.find(item => item.instance_id === spear).attack, expected);
  assert.deepEqual(browser.combatValues(calculation(f), 0), trace);
  const active = server.legalCommands(f.state, f.catalog, f.rules).find(command => command.type === 'ActivateAbility')?.options ?? [];
  assert.equal(active.some(option => option.ability_id === 'TS-0253-A03'), militia !== OTHER_HERO);
  if (militia !== OTHER_HERO) {activate(f, 'TS-0253-A03', spear); assert.equal(hand(f).length, 3);}
});

test('Cyril Knight buffs ordinary and elite militia, without buffing unrelated heroes', () => {
  const f = fixture(['TS-0346', MILITIA, ELITE, OTHER_HERO]), trace = server.combatValues(calculation(f), 0);
  assert.equal(trace.components.find(item => item.instance_id === f.hand[1]).attack, 2);
  assert.equal(trace.components.find(item => item.instance_id === f.hand[2]).attack, 3);
  assert.equal(trace.components.find(item => item.instance_id === f.hand[3]).attack, server.stat(f.cards[OTHER_HERO], 'attack'));
});

for (const [source, id, xp, draw] of [['TS-0213', 'TS-0213-A01', 2, 0], ['TS-0223', 'TS-0223-A02', 1, 2]])
  test(`${id} permits sacrificing elite militia and rejects an unrelated hero`, () => {
    const f = fixture([source, ELITE, ELITE, OTHER_HERO]); if (source === 'TS-0213') village(f);
    for (let i = 0; i < draw; i++) f.add('TS-0003', 'player:alice:draw');
    activate(f, id); assert.deepEqual(f.state.pending_choice.candidate_instance_ids, f.hand.slice(1, 3));
    assert.throws(() => select(f, [f.hand[3]])); select(f, [f.hand[1]]);
    assert.ok(f.state.zones.destroyed.includes(f.hand[1])); assert.equal(f.state.players.alice.xp, xp);
    assert.equal(hand(f).length, 3 + draw);
  });

test('False Instructor grants strength to every militia-tagged hero', () => {
  const f = fixture(['TS-0522', MILITIA, ELITE, OTHER_HERO]); activate(f, 'TS-0522-A02');
  assert.equal(f.state.battle_context.card_modifiers[f.hand[1]].strength, 3);
  assert.equal(f.state.battle_context.card_modifiers[f.hand[2]].strength, 3);
  assert.equal(f.state.battle_context.card_modifiers[f.hand[3]], undefined);
});

test('Dinn Enchanter may discard elite militia to take the offered hero', () => {
  const f = fixture(['TS-0416', ELITE, ELITE]); const target = f.add(OTHER_HERO, 'hero_supply:offered');
  f.add('TS-0314', 'hero_supply:other');
  activate(f, 'TS-0416-A02'); select(f, [f.hand[1]]); select(f, [target]);
  assert.ok(f.state.zones['player:alice:discard'].includes(f.hand[1])); assert.ok(hand(f).includes(target));
});

test('Dinn Beguiler copies abilities onto either militia, preserving identity and replacing the original attack', () => {
  const results = [];
  for (const militia of [MILITIA, ELITE]) {
    const f = fixture(['TS-0415', militia, militia, OTHER_HERO]), [, copy, , template] = f.hand;
    activate(f, 'TS-0415-A02'); assert.deepEqual(f.state.pending_choice.candidate_instance_ids, f.hand.slice(1, 3));
    select(f, [copy]); select(f, [template]);
    assert.equal(f.state.instances[copy].card_id, militia);
    assert.deepEqual(f.state.copied_heroes[copy].card_ids, [OTHER_HERO]);
    const trace = server.combatValues(calculation(f), 0);
    assert.equal(trace.hero_strength[copy], server.stat(f.cards[militia], 'strength'));
    results.push(trace.components.find(item => item.instance_id === copy).attack);
  }
  assert.equal(results[0], results[1], 'copied attack replaces the original +1 or +2');
});

test('Krell Warmaster accepts an opponent revealing elite militia instead of forcing a random discard', () => {
  const f = fixture(['TS-0317', ELITE]), shown = f.add(ELITE, 'player:bob:hand'), other = f.add(ELITE, 'player:bob:hand'); f.add('TS-0003', 'player:bob:hand');
  activate(f, 'TS-0317-A02'); assert.equal(f.state.pending_choice.player_id, 'bob');
  assert.deepEqual(f.state.pending_choice.candidate_instance_ids, [shown, other]); select(f, [shown]);
  assert.equal(f.state.battle_context.modifiers.attack, 4);
  assert.equal(f.state.zones['player:bob:hand'].length, 3);
});

for (const id of ['TS-0486-A01', 'TS-0488-A01', 'TS-0527-A02', 'TS-0576-A01', 'TS-0654-A01', 'TS-0665-A02', 'TS-0669-A02', 'TS-0670-A02'])
  test(`${id} targets elite militia and destroys it after battle`, () => {
    const f = fixture([ELITE, ELITE, OTHER_HERO], [id.split('-A')[0]]); isolate(f, id); fight(f);
    assert.deepEqual(f.state.pending_choice.candidate_instance_ids, f.hand.slice(0, 2)); select(f, [f.hand[0]]);
    assert.ok(f.state.zones.destroyed.includes(f.hand[0])); assert.ok(hand(f).includes(f.hand[1])); assert.ok(hand(f).includes(f.hand[2]));
  });

test('Reptile Warrior excludes elite militia from non-militia hero targets', () => {
  const f = fixture([MILITIA, ELITE, OTHER_HERO, OTHER_HERO], ['TS-0632']); isolate(f, 'TS-0632-A01'); fight(f);
  assert.deepEqual(f.state.pending_choice.candidate_instance_ids, f.hand.slice(2));
  assert.throws(() => select(f, [f.hand[1]])); select(f, [f.hand[2]]);
  assert.ok(hand(f).includes(f.hand[0])); assert.ok(hand(f).includes(f.hand[1]));
});

for (const id of ['TS-0639-A02', 'TS-0661-A01']) test(`${id} counts and destroys both militia identities`, () => {
  const f = fixture([MILITIA, ELITE, OTHER_HERO], [id.split('-A')[0]]); isolate(f, id); fight(f);
  assert.ok(f.state.zones.destroyed.includes(f.hand[0])); assert.ok(f.state.zones.destroyed.includes(f.hand[1]));
  assert.ok(hand(f).includes(f.hand[2]));
  if (id === 'TS-0661-A01') assert.equal(f.state.zones['player:alice:discard'].filter(item => f.state.instances[item].card_id === 'TS-0714').length, 2);
});

test('Snake Dragon selects two elite militia and grants the corresponding diseases', () => {
  const f = fixture([ELITE, ELITE, OTHER_HERO], ['TS-0588']); isolate(f, 'TS-0588-A01'); fight(f);
  assert.deepEqual(f.state.pending_choice.candidate_instance_ids, f.hand.slice(0, 2)); select(f, f.hand.slice(0, 2));
  assert.ok(f.state.zones.destroyed.includes(f.hand[0])); assert.ok(f.state.zones.destroyed.includes(f.hand[1]));
  assert.equal(f.state.zones['player:alice:discard'].filter(item => f.state.instances[item].card_id === 'TS-0714').length, 2);
});

test('Shambling Reptile grants the attack modifier to elite militia during battle', () => {
  const f = fixture([ELITE, OTHER_HERO], ['TS-0636']); isolate(f, 'TS-0636-A01');
  const result = fight(f), trace = result.events.find(event => event.kind === 'battle_resolved').calculation;
  assert.equal(trace.components.find(item => item.instance_id === f.hand[0]).attack, 4);
});

for (const [id, event] of [['TS-0501-A02', 'BREACH'], ['TS-0561-A01', 'TURN_WILL_END']])
  test(`${id} finds elite militia in the appropriate event window`, () => {
    const f = fixture(event === 'BREACH' ? [] : [ELITE, ELITE, OTHER_HERO], [id.split('-A')[0]]); isolate(f, id);
    const victims = event === 'BREACH' ? f.state.player_order.map(player => {
      const candidates = [f.add(ELITE, `player:${player}:draw`), f.add(ELITE, `player:${player}:draw`)];
      for (let n = 0; n < 3; n++) f.add('TS-0003', `player:${player}:draw`); return candidates;
    }) : [f.hand.slice(0, 2)];
    const tx = new Transition(f.state, f.catalog, f.rules);
    queueSteps(tx, [{op: 'event', event, context: {source_instance_id: f.hall[0], hall_zone: 'hall:main'}}]); f.state = tx.finish().state;
    for (const candidates of victims) {assert.deepEqual(f.state.pending_choice.candidate_instance_ids, candidates); select(f, [candidates[0]]);}
    for (const candidates of victims) assert.ok(f.state.zones.destroyed.includes(candidates[0]));
  });

test('Highland Soldier takes a treasure by tag even if its catalog subcategory differs', () => {
  const f = fixture(['TS-0396']); village(f);
  f.catalog = {...f.catalog, cards: {...f.cards, 'TS-0694': {...f.cards['TS-0694'], subcategory: '测试分类'}}};
  const treasure = f.add('TS-0694', 'player:bob:control');
  const other = f.add('TS-0694', 'player:bob:control');
  activate(f, 'TS-0396-A02'); assert.deepEqual(f.state.pending_choice.candidate_instance_ids, [treasure, other]); select(f, [treasure]);
  assert.ok(f.state.zones['player:alice:control'].includes(treasure));
});

test('published effects retain literal target IDs only for named cards and the two approved fixed militia supplies', () => {
  const references = [];
  const walk = (node, path, id) => {
    if (Array.isArray(node)) node.forEach((value, index) => walk(value, `${path}[${index}]`, id));
    else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) {
      if (['card_id', 'exclude_card_id', 'equipper_card_id', 'hero_card_id'].includes(key)) references.push(`${id}:${path}.${key}=${value}`);
      walk(value, `${path}.${key}`, id);
    }
  };
  for (const rule of [...rules.abilities, ...rules.mechanics]) walk(rule, '', rule.id);
  assert.deepEqual(references.sort(), ['TS-0522-A01:.body.card_id=TS-0001', 'TS-0601-A01:.body.card_id=TS-0001', 'TS-0634-A01:.body.query.card_id=TS-0002']);
});
