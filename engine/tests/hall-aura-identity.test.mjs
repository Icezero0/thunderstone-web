import assert from 'node:assert/strict';
import test from 'node:test';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {fixture} from './support/catalog.mjs';

const MAMMOTH = 'TS-0615', KNIGHT = 'TS-0680', SENTINEL = 'TS-0679', MONSTER = 'TS-0476';
const auraIds = new Set(['TS-0615-A01', 'TS-0680-A03', 'TS-0679-A03']);
function scene() {
  const f = fixture();
  f.rules = {...f.rules, abilities: [], mechanics: f.rules.mechanics.filter(rule => auraIds.has(rule.id))};
  f.state.zones['hall:b'] = []; f.state.zones['hall:b:rank0'] = []; f.state.zones['dungeon:b'] = [];
  return f;
}
const input = f => ({state: f.state, cards: f.cards, mechanics: f.rules.mechanics});
const printed = (f, id) => server.stat(f.cards[f.state.instances[id].card_id], 'health');
function health(f, id, rank = 0) {
  const card = f.cards[f.state.instances[id].card_id], before = structuredClone(f.state);
  const result = server.monsterHealth(input(f), card, rank, id);
  assert.equal(browser.monsterHealth(input(f), card, rank, id), result);
  assert.deepEqual(f.state, before); return result;
}

test('Mammoth exempts all Mammoth copies while protecting other Corrupt Druids', () => {
  const f = scene(), first = f.add(MAMMOTH, 'hall:main'), second = f.add(MAMMOTH, 'hall:main');
  const druidCard = Object.values(f.cards).find(card => card.card_id !== MAMMOTH && card.card_type === '地下城牌' && card.tags.split('|').includes('腐化德鲁伊'));
  const druid = f.add(druidCard.card_id, 'hall:main');
  for (const [id, allowed] of [[first, true], [second, true], [druid, false]]) {
    const card = f.cards[f.state.instances[id].card_id];
    const trace = server.combatValues(input(f), 1, card);
    assert.deepEqual(browser.combatValues(input(f), 1, card), trace);
    assert.equal(trace.can_attack, allowed);
  }
  f.state.zones['hall:main'] = [druid]; f.state.zones['dungeon:main'] = [first, second];
  assert.equal(server.combatValues(input(f), 1, druidCard).can_attack, true);
});

test('two Terminal Knights grant each other one health, without granting their own aura to themselves', () => {
  const f = scene(), first = f.add(KNIGHT, 'hall:main:rank0'), second = f.add(KNIGHT, 'hall:b:rank0');
  const monster = f.add(MONSTER, 'hall:main');
  assert.equal(health(f, first), printed(f, first) + 1);
  assert.equal(health(f, second), printed(f, second) + 1);
  assert.equal(health(f, monster, 1), printed(f, monster) + 2);
  f.state.zones['hall:b:rank0'] = []; f.state.zones['dungeon:b'] = [second];
  assert.equal(health(f, first), printed(f, first));
  assert.equal(health(f, monster, 1), printed(f, monster) + 1);
});

test('three Terminal Knight instances stack once per other source', () => {
  const f = scene(), knights = [f.add(KNIGHT, 'hall:main:rank0'), f.add(KNIGHT, 'hall:b:rank0'), f.add(KNIGHT, 'hall:main')];
  for (const id of knights) assert.equal(health(f, id), printed(f, id) + 2);
});

test('rank-zero Death Sentinels affect the other dungeon and other Death Sentinel instances', () => {
  const f = scene(), first = f.add(SENTINEL, 'hall:main:rank0'), second = f.add(SENTINEL, 'hall:b:rank0');
  const monster = f.add(MONSTER, 'hall:b');
  assert.equal(health(f, first), printed(f, first) + 1);
  assert.equal(health(f, second), printed(f, second) + 1);
  assert.equal(health(f, monster, 1), printed(f, monster) + 2);
  // The second sentinel remains a legal recipient in an ordinary rank, but
  // provides its aura only while it occupies rank zero.
  f.state.zones['hall:b:rank0'] = []; f.state.zones['hall:b'].push(second);
  assert.equal(health(f, first), printed(f, first));
  assert.equal(health(f, second, 2), printed(f, second) + 1);
  assert.equal(health(f, monster, 1), printed(f, monster) + 1);
});

test('Knight and rank-zero Sentinel auras stack across dungeons without self-buffs', () => {
  const f = scene(), knight = f.add(KNIGHT, 'hall:main:rank0'), sentinel = f.add(SENTINEL, 'hall:b:rank0');
  const monster = f.add(MONSTER, 'hall:main');
  assert.equal(health(f, knight), printed(f, knight) + 1);
  assert.equal(health(f, sentinel), printed(f, sentinel) + 1);
  assert.equal(health(f, monster, 1), printed(f, monster) + 2);
});

test('default health target resolution uses a matching context or hall instance, preserving per-instance attachments', () => {
  const f = scene(), first = f.add(KNIGHT, 'hall:main:rank0'), second = f.add(KNIGHT, 'hall:b:rank0');
  const other = f.add(MONSTER, 'hall:main'), card = f.cards[KNIGHT];
  f.state.attachments = {[first]: [{kind: 'disease_after'}]};
  assert.equal(health(f, first), printed(f, first) + 2);
  assert.equal(health(f, second), printed(f, second) + 1);
  f.state.battle_context.target_instance_id = second;
  assert.equal(server.monsterHealth(input(f), card), printed(f, second) + 1);
  f.state.battle_context.target_instance_id = other;
  assert.equal(server.monsterHealth(input(f), card), printed(f, first) + 2);
});

test('browser battle preview and authoritative battle resolution include the other same-name aura source', () => {
  const f = scene(), target = f.add(KNIGHT, 'hall:main:rank0'); f.add(KNIGHT, 'hall:b:rank0');
  f.state.battle_context.modifiers = {attack: 999};
  const preparation = server.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  preparation.draft.target_instance_id = target;
  const preview = browser.previewBattleTeam(preparation.context, preparation.draft);
  assert.equal(preview.health, printed(f, target) + 1);
  const submitted = server.applyCommand(f.state, server.buildSubmitBattleTeamCommand(preparation.context, preparation.draft), f.catalog, f.rules);
  const command = {type: 'DeclareBattleTarget', player_id: 'alice', expected_version: submitted.state.game_version, target_instance_id: target};
  const resolved = server.applyCommand(submitted.state, command, f.catalog, f.rules);
  assert.deepEqual(browser.applyCommand(submitted.state, command, f.catalog, f.rules), resolved);
  assert.equal(resolved.events.find(event => event.kind === 'battle_resolved').health, preview.health);
});
