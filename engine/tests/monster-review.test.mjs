import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import * as engine from '../dist/index.js';
import {Transition} from '../dist/turn/transaction.js';
import {dispatchEvent} from '../dist/effects/execute.js';
import {resolveSelection} from '../dist/effects/choice-transition.js';
import {resolveResponse} from '../dist/effects/responses.js';
import {attach, diseaseGainSteps} from '../dist/effects/ownership.js';
import {queueSteps} from '../dist/turn/workflow.js';
import {settleGame} from '../dist/turn/settlement.js';

const file = name => JSON.parse(readFileSync(new URL(`../../cards/effects/${name}.json`, import.meta.url), 'utf8'));
const abilities = ['classic-v1', 'simple-reviewed', 'action-reviewed', 'battle-reviewed', 'event-reviewed'].flatMap(name => file(name).abilities);
const mechanics = file('mechanics');
const card = (id, tags = '怪物', fields = {}) => ({card_id: id, name: id, slot_kind: 'front', tags,
  card_type: '地下城牌', subcategory: '怪物', effect_text: '', 'wiki_生命值': '2',
  'wiki_力量': '', 'wiki_英雄等级': '', 'wiki_金币值': '', 'wiki_光照': '', 'wiki_重量': '',
  'wiki_胜利点': '', '正文_基础攻击': '', '正文_基础魔法攻击': '', defeat_xp_reward: '1', ...fields});
const cards = Object.fromEntries([...abilities, ...mechanics].map(a => [a.source_card_id, card(a.source_card_id)]));
Object.assign(cards, {
  'TS-0001': card('TS-0001', '民兵|英雄', {card_type: '基础牌', subcategory: '', 'wiki_力量': '2', 'wiki_英雄等级': '0', '正文_基础攻击': '1'}),
  'TS-0002': card('TS-0002', '武器|村庄', {card_type: '基础牌', subcategory: '', 'wiki_重量': '2'}),
  'TS-0003': card('TS-0003', '物品|光照|村庄', {card_type: '基础牌', subcategory: '', 'wiki_金币值': '2', 'wiki_光照': '1'}),
  'TS-0004': card('TS-0004', '物品|食物|村庄', {card_type: '基础牌', subcategory: ''}),
  'TS-0302': card('TS-0302', '弓箭手|英雄', {card_type: '英雄牌', subcategory: '测试', 'wiki_英雄等级': '1', 'wiki_力量': '4'}),
  'TS-0303': card('TS-0303', '弓箭手|英雄', {card_type: '英雄牌', subcategory: '测试', 'wiki_英雄等级': '2', 'wiki_力量': '5'}),
  'TS-0304': card('TS-0304', '弓箭手|英雄', {card_type: '英雄牌', subcategory: '测试', 'wiki_英雄等级': '3', 'wiki_力量': '6'}),
  'TS-0340': card('TS-0340', '战士|英雄', {card_type: '英雄牌', subcategory: '测试战士', 'wiki_英雄等级': '2', 'wiki_力量': '5'}),
  'TS-0464': card('TS-0464', '怪物', {'wiki_胜利点': '10'}),
  'TS-0476': card('TS-0476', '怪物', {defeat_xp_reward: '2'}),
  'TS-0495': card('TS-0495', '怪物|元素'),
  'TS-0510': card('TS-0510'),
  'TS-0610': card('TS-0610', '怪物|腐化德鲁伊'),
  'TS-0611': card('TS-0611', '怪物|腐化德鲁伊'),
  'TS-0615': card('TS-0615', '怪物|腐化德鲁伊'),
  'TS-0673': card('TS-0673', '怪物|守护者', {subcategory: '守护者'}),
  'TS-0677': card('TS-0677', '怪物|守护者', {subcategory: '守护者'}),
  'TS-0686': card('TS-0686', '陷阱', {subcategory: '陷阱'}),
  'TS-0692': card('TS-0692', '陷阱', {subcategory: '陷阱'}),
  'TS-0700': card('TS-0700', '宝藏', {subcategory: '宝藏'}),
  'TS-0703': card('TS-0703', '宝藏', {subcategory: '宝藏'}),
  'TS-0704': card('TS-0704', '宝藏', {subcategory: '宝藏'}),
  'TS-0705': card('TS-0705', '宝藏', {subcategory: '宝藏'}),
  'TS-0707': card('TS-0707', '雷霆之石', {subcategory: '雷霆之石'}),
  'TS-0714': card('TS-0714', '疾病', {card_type: '疾病牌', subcategory: ''}),
});
for (const mechanic of mechanics) cards[mechanic.source_card_id].effect_text += `\n${mechanic.source_line}`;
function fixture(abilityIds, mechanicIds = []) {
  const rules = {...engine.compileRuleset({schema_version: 'thunderstone.effects/1',
    abilities: abilities.filter(a => abilityIds.includes(a.id)),
    mechanics: mechanics.filter(a => mechanicIds.includes(a.id))}, cards), version: 'review'};
  const state = {phase: 'PLAYING', subphase: 'DUNGEON_PREPARE', timing_window: 'DUNGEON_PREPARE',
    chosen_action: 'dungeon', ruleset_version: engine.RULESET_VERSION, catalog_version: 'catalog', effects_version: 'review',
    player_order: ['alice', 'bob'], active_player_id: 'alice', first_player_id: 'alice', turn_number: 1, round_number: 1,
    game_version: 1, started_turn: 1, next_instance_sequence: 1, next_event_sequence: 1,
    players: {alice: {xp: 5, temporary_gold: 0, purchases_remaining: 1}, bob: {xp: 0, temporary_gold: 0, purchases_remaining: 1}},
    zones: {'hall:main': [], 'hall:main:rank0': [], 'dungeon:main': [], destroyed: [], settings: []}, instances: {},
    active_settings: [], battle_context: {equipped_weapon_by_hero: {}, target_rank: 1},
    pending_choice: null, resolution_frames: [], registered_triggers: [], scheduled_effects: [], workflow_steps: [],
    continuous_effects: [], ability_uses: {}, used_cards: [],
    supply_rules: {basic_card_ids: [], disease_infinite: true, disease_card_ids: ['TS-0714'], disease_weights: {'TS-0714': 1}, disease_mode: 'ordinary'},
    rng_state: {algorithm: engine.RNG_VERSION, seed: 'monster-review', counter: 0}};
  for (const p of state.player_order) for (const part of ['hand', 'draw', 'discard', 'control', 'aside']) state.zones[`player:${p}:${part}`] = [];
  const catalog = {cards, setup_index: {cards_csv_sha256: 'catalog', groups: []}};
  const tx = new Transition(state, catalog, rules);
  const add = (id, zone = 'player:alice:hand') => {
    const instance = `CI-${String(tx.state.next_instance_sequence++).padStart(6, '0')}`;
    tx.state.instances[instance] = {card_id: id, owner_player_id: zone.startsWith('player:') ? zone.split(':')[1] : null, flags: {}, origin: 'fixture'};
    (tx.state.zones[zone] ??= []).push(instance); return instance;
  };
  return {tx, add, catalog, rules};
}
const healthCases = [
  ['TS-0551-A01', ['TS-0003'], 3], ['TS-0552-A01', ['TS-0002'], 4],
  ['TS-0553-A01', ['TS-0003'], 2], ['TS-0554-A01', ['TS-0001'], 4],
  ['TS-0555-A01', ['TS-0003'], 2], ['TS-0611-A01', ['TS-0610'], 3],
  ['TS-0613-A02', ['TS-0714'], 2], ['TS-0614-A02', [], 5],
  ['TS-0615-A02', [], 2], ['TS-0638-A01', ['TS-0001'], 1],
  ['TS-0639-A01', ['TS-0302'], 2], ['TS-0640-A01', ['TS-0303'], 3],
  ['TS-0641-A01', ['TS-0304'], 4], ['TS-0642-A01', ['TS-0001'], 2],
  ['TS-0673-A03', ['TS-0302', 'TS-0303'], 3],
];
for (const [abilityId, hand, bonus] of healthCases) test(`${abilityId} resolves its health bonus once and keeps the snapshot`, () => {
  const {tx, add} = fixture([abilityId]);
  assert.ok(!mechanics.some(m => m.id === abilityId));
  const source = add(abilityId.split('-A')[0], 'hall:main');
  tx.state.battle_context.target_instance_id = source;
  hand.forEach(id => add(id));
  const companion = abilityId === 'TS-0615-A02' ? add('TS-0610', 'hall:main') : null;
  assert.equal(tx.health(tx.card(source), 1, source), 2);
  dispatchEvent(tx, 'BATTLE_BEFORE_OUTCOME');
  assert.equal(tx.health(tx.card(source), 1, source), 2 + bonus);
  for (const id of [...tx.zone('hand')]) tx.move(id, 'player:alice:hand', 'player:alice:discard');
  if (companion) tx.move(companion, 'hall:main', 'dungeon:main');
  tx.player.xp = 100;
  assert.equal(tx.health(tx.card(source), 1, source), 2 + bonus);
});

test('health conditions absent at resolution do not turn on after a later card arrives', () => {
  for (const [id, arriving] of [['TS-0611-A01', 'TS-0610'], ['TS-0641-A01', 'TS-0304']]) {
    const {tx, add} = fixture([id]); const source = add(id.split('-A')[0], 'hall:main');
    tx.state.battle_context.target_instance_id = source;
    dispatchEvent(tx, 'BATTLE_BEFORE_OUTCOME'); add(arriving);
    assert.equal(tx.health(tx.card(source), 1, source), 2);
  }
});

test('health modifiers without a Battle prefix remain continuous', () => {
  for (const id of ['TS-0461-A01', 'TS-0600-A01']) {
    const {tx, add} = fixture([], [id]); const source = add(id.split('-A')[0], 'hall:main');
    assert.ok(!mechanics.find(m => m.id === id).source_line.startsWith('战斗：'));
    const before = tx.health(tx.card(source), 1, source);
    if (id === 'TS-0461-A01') {add('TS-0003'); add('TS-0003'); add('TS-0003');}
    else add('TS-0001');
    assert.equal(tx.health(tx.card(source), 1, source), id === 'TS-0461-A01' ? before / 2 : before + 1);
  }
});

test('Suffering Guardian repeats the same snapshot health effect; Ruby Dragon can ignore an occurrence', () => {
  for (const useRuby of [false, true]) {
    const {tx, add} = fixture(['TS-0551-A01'], ['TS-0677-A01', 'TS-0703-A01']);
    const source = add('TS-0551', 'hall:main'); add('TS-0003'); add('TS-0677', 'hall:main:rank0');
    tx.state.battle_context.target_instance_id = source;
    const ruby = useRuby ? add('TS-0703', 'player:alice:control') : null;
    dispatchEvent(tx, 'BATTLE_BEFORE_OUTCOME');
    if (ruby) {assert.equal(tx.state.pending_choice.ability_id, 'TS-0551-A01'); resolveResponse(tx, ruby);}
    assert.equal(tx.health(tx.card(source), 1, source), useRuby ? 5 : 8);
    assert.equal(tx.state.pending_choice, null);
  }
});

test('battle health calculation also runs through the public battle command', () => {
  const f = fixture(['TS-0551-A01']); const source = f.add('TS-0551', 'hall:main'); f.add('TS-0003');
  const result = engine.applyCommand(f.tx.state, {type: 'DeclareBattleTarget', player_id: 'alice', target_instance_id: source}, f.catalog, f.rules);
  assert.equal(result.events.find(e => e.kind === 'battle_resolved').health, 5);
});

test('Earth Wrath damage reduction is frozen, repeatable, and stacks multiplicatively', () => {
  const {tx, add} = fixture(['TS-0508-A02'], ['TS-0677-A01']);
  const source = add('TS-0508', 'hall:main'); add('TS-0677', 'hall:main:rank0');
  tx.state.battle_context.target_instance_id = source;
  tx.state.battle_context.modifiers = {attack: 13, magic_attack: 6, light: 3};
  dispatchEvent(tx, 'BATTLE_BEFORE_OUTCOME');
  assert.equal(tx.state.battle_context.damage_divisor, 4);
  let trace = tx.combat(1, tx.card(source));
  assert.equal(trace.attack + trace.magic_attack, 4);
  add('TS-0495'); trace = tx.combat(1, tx.card(source));
  assert.equal(trace.attack + trace.magic_attack, 4);
  assert.equal(trace.light, 3);
});

test('Ruby Dragon can prevent one repeated Earth Wrath damage reduction', () => {
  const {tx, add} = fixture(['TS-0508-A02'], ['TS-0677-A01', 'TS-0703-A01']);
  const source = add('TS-0508', 'hall:main'); add('TS-0677', 'hall:main:rank0');
  const ruby = add('TS-0703', 'player:alice:control'); tx.state.battle_context.target_instance_id = source;
  dispatchEvent(tx, 'BATTLE_BEFORE_OUTCOME'); resolveResponse(tx, ruby);
  assert.equal(tx.state.battle_context.damage_divisor, 2);
  assert.equal(tx.state.pending_choice, null);
});

for (const [ability, victim, count] of [
  ['TS-0586-A01', 'TS-0004', 1], ['TS-0587-A01', 'TS-0003', 1],
  ['TS-0588-A01', 'TS-0001', 1], ['TS-0589-A01', 'TS-0340', 2], ['TS-0590-A01', 'TS-0476', 2],
]) test(`${ability} counts only newly marked destruction when the battle repeats`, () => {
  const {tx, add} = fixture([ability], ['TS-0677-A01']); const source = add(ability.split('-A')[0], 'hall:main');
  add(victim); add('TS-0677', 'hall:main:rank0'); tx.state.battle_context.target_instance_id = source;
  dispatchEvent(tx, 'BATTLE_BEFORE_OUTCOME');
  while (tx.state.pending_choice?.kind === 'effect_select') {
    const c = tx.state.pending_choice; resolveSelection(tx, c.candidate_instance_ids.slice(0, c.min_count));
  }
  assert.equal(tx.events.filter(e => e.kind === 'effect_card_marked').length, 1);
  assert.equal(tx.events.filter(e => e.kind === 'disease_taken_from_supply').length, count);
});

test('Dragons Voice destroys the monster set aside by Sapphire Dragon without resurrecting it at game end', () => {
  const {tx, add} = fixture(['TS-0705-A01', 'TS-0692-A01']);
  const sapphire = add('TS-0705', 'player:alice:control'), monster = add('TS-0510', 'player:alice:discard');
  tx.state.event_context = {source_instance_id: monster}; dispatchEvent(tx, 'MONSTER_DEFEATED'); resolveSelection(tx, [monster]);
  const trap = add('TS-0692', 'revealed:main');
  tx.state.event_context = {source_instance_id: trap, defeated_instance_id: monster}; dispatchEvent(tx, 'TRAP_REVEALED');
  assert.ok(tx.state.zones.destroyed.includes(monster)); assert.deepEqual(tx.state.attachments[sapphire], []);
  assert.ok(tx.zone('aside').includes(sapphire));
  settleGame(tx, 'test');
  assert.ok(tx.state.zones.destroyed.includes(monster)); assert.equal(tx.state.instances[monster].owner_player_id, null);
  assert.ok(tx.zone('discard').includes(sapphire));
});

test('an attached disease enters the normal acquisition and replacement workflow', () => {
  const {tx, add} = fixture([], ['TS-0239-A02']);
  const monster = add('TS-0510', 'hall:main'), disease = add('TS-0714'); add('TS-0239');
  attach(tx, disease, monster, 'disease_before', 'alice');
  queueSteps(tx, diseaseGainSteps(tx, monster, 'before'));
  assert.equal(tx.state.instances[disease], undefined);
  assert.ok(tx.events.some(e => e.kind === 'card_destroyed' && e.instance_id === disease && e.destination === 'disease_supply'));
  assert.equal(tx.events.filter(e => e.kind === 'card_gained' && e.instance_id === disease).length, 1);
  assert.ok(tx.events.some(e => e.kind === 'disease_replacement_applied' && e.instance_id === disease));
  assert.equal(tx.state.attachments[monster], undefined);
});

for (const replacement of ['destroy', 'redirect']) test(`Emerald Dragon disease release uses the receiving player's ${replacement} replacement and resumes battle`, () => {
  const f = fixture(['TS-0704-A01', 'TS-0704-A02'], ['TS-0239-A02', 'TS-0423-A02']);
  const emerald = f.add('TS-0704', 'player:alice:control'), disease = f.add('TS-0714');
  const firstVictory = f.add('TS-0510', 'player:alice:discard');
  f.tx.state.event_context = {source_instance_id: firstVictory};
  dispatchEvent(f.tx, 'MONSTER_DEFEATED'); resolveSelection(f.tx, [disease]);
  assert.ok(f.tx.zone('aside', 'alice').includes(disease));
  const destroySource = f.add('TS-0239', 'player:bob:hand'), redirectSource = f.add('TS-0423', 'player:bob:hand');
  f.tx.state.active_player_id = 'bob';
  f.tx.state.battle_context.modifiers = {attack: 100};
  const target = f.add('TS-0464', 'hall:main');
  for (let i = 0; i < 5; i++) f.add('TS-0510', 'dungeon:main');
  const started = engine.applyCommand(f.tx.state, {type: 'DeclareBattleTarget', player_id: 'bob', target_instance_id: target}, f.catalog, f.rules);
  const choice = started.state.pending_choice;
  assert.equal(choice.kind, 'disease_replacement'); assert.equal(choice.player_id, 'bob');
  assert.deepEqual(choice.options.map(o => o.source_instance_id).sort(), [destroySource, redirectSource].sort());
  assert.ok(started.state.zones['pending:disease'].includes(disease));
  assert.ok(started.state.zones.destroyed.includes(emerald));
  const paused = JSON.parse(JSON.stringify(started.state));
  const command = {type: 'ResolveDiseaseReplacement', player_id: 'bob',
    source_instance_id: replacement === 'destroy' ? destroySource : redirectSource};
  assert.throws(() => engine.applyCommand(paused, {...command, player_id: 'alice'}, f.catalog, f.rules));
  const finished = engine.applyCommand(paused, command, f.catalog, f.rules);
  const events = [...started.events, ...finished.events];
  assert.equal(finished.state.pending_choice, null);
  assert.equal(finished.state.attachments[emerald], undefined);
  assert.equal(events.filter(e => e.kind === 'card_gained' && e.instance_id === disease).length, 1);
  assert.equal(events.filter(e => e.kind === 'attachment_released' && e.anchor_instance_id === emerald).length, 1);
  assert.equal(events.filter(e => e.kind === 'disease_replacement_applied' && e.instance_id === disease).length, 1);
  if (replacement === 'destroy') assert.equal(finished.state.instances[disease], undefined);
  else {
    assert.equal(finished.state.instances[disease].owner_player_id, 'alice');
    assert.ok(finished.state.zones['player:alice:discard'].includes(disease));
  }
  assert.ok(events.some(e => e.kind === 'battle_resolved' && e.outcome === 'win'));
  assert.notEqual(finished.state.subphase, 'BATTLE_EFFECTS');
});

test('Barkeeper reveals the replenished hand before discarding its heroes', () => {
  const {tx, add} = fixture(['TS-0528-A02']); const source = add('TS-0528', 'hall:main');
  const hero = add('TS-0001'), food = add('TS-0004'); tx.state.battle_context.target_instance_id = source;
  dispatchEvent(tx, 'BATTLE_BEFORE_OUTCOME'); dispatchEvent(tx, 'HAND_REFILL_COMPLETE');
  const shown = tx.events.findIndex(e => e.kind === 'cards_shown');
  assert.deepEqual(tx.events[shown].instance_ids, [hero, food]);
  assert.ok(shown < tx.events.findIndex(e => e.kind === 'card_moved' && e.instance_id === hero));
});

for (const replacement of ['TS-0686', 'TS-0700', 'TS-0707', 'TS-0673']) test(`Tholis Oracle may exchange in ${replacement} and resolves its hall arrival`, () => {
  const f = fixture(['TS-0454-A02', 'TS-0686-A01']);
  const oracle = f.add('TS-0454'); const original = f.add('TS-0510', 'hall:main');
  f.add('TS-0510', 'hall:main'); f.add('TS-0510', 'hall:main');
  const incoming = f.add(replacement, 'dungeon:main'); f.add('TS-0510', 'dungeon:main'); f.add('TS-0510', 'dungeon:main'); f.add('TS-0510', 'dungeon:main');
  let result = engine.applyCommand(f.tx.state, {type: 'ActivateAbility', player_id: 'alice', ability_id: 'TS-0454-A02', source_instance_id: oracle}, f.catalog, f.rules);
  let selected = false; const events = [...result.events];
  for (let i = 0; i < 15 && result.state.pending_choice; i++) {
    const c = result.state.pending_choice;
    let cmd;
    if (c.kind === 'effect_select') {
      const ids = c.candidate_instance_ids;
      const value = ids.includes(incoming) ? [incoming] : ids.includes(original) ? [original] : ids.slice(0, c.min_count);
      if (ids.includes(incoming)) selected = true;
      cmd = {type: 'ResolveChoice', instance_ids: value};
    } else if (c.kind === 'effect_reorder') cmd = {type: 'ResolveCardOrder', instance_ids: c.candidate_instance_ids};
    else if (c.kind === 'effect_value') cmd = {type: 'ResolveValueChoice', value: c.options[0]};
    else if (c.kind === 'effect_order') cmd = {type: 'ResolveEffectOrder', effect_ids: c.effects.map(e => e.effect_id)};
    else assert.fail(`unexpected choice ${c.kind}`);
    result = engine.applyCommand(result.state, {...cmd, player_id: c.player_id}, f.catalog, f.rules); events.push(...result.events);
  }
  assert.ok(selected); assert.equal(result.state.pending_choice, null);
  if (replacement === 'TS-0686') assert.ok(result.state.zones.destroyed.includes(incoming));
  if (replacement === 'TS-0700') assert.ok(result.state.zones['player:alice:control'].includes(incoming));
  if (replacement === 'TS-0707') assert.equal(result.state.phase, 'SETTLING');
  if (replacement === 'TS-0673') assert.ok(result.state.zones['hall:main:rank0'].includes(incoming));
  assert.ok(events.some(e => e.kind === 'hall_monster_exchanged'));
});
