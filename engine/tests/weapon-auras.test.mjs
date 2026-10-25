import test from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {fixture} from './support/catalog.mjs';

for (const [sourceCard, light, attack] of [['TS-0411', 1, 0], ['TS-0412', 1, 1], ['TS-0413', 2, 2]])
test(`${sourceCard} derives weapon buffs from current participation and equipment in browser and server`, () => {
  const f = fixture([sourceCard, 'TS-0001', 'TS-0001', 'TS-0002', 'TS-0002', 'TS-0002', 'TS-0002'], ['TS-0476']);
  const [source, hero, bench, ownWeapon, weapon, benchWeapon, loose] = f.hand, before = structuredClone(f.state);
  let {context, draft} = server.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  draft.hero_instance_ids = [hero]; draft.support_instance_ids = [];
  for (const [owner, item] of [[source, ownWeapon], [hero, weapon], [bench, benchWeapon]])
    draft = server.updateBattleDraft(context, draft, {type: 'equip', hero_instance_id: owner, weapon_instance_id: item});
  assert.deepEqual(server.previewBattleTeam(context, draft).continuous_card_statuses, {});
  draft = server.updateBattleDraft(context, draft, {type: 'set_hero', instance_id: source, selected: true});
  const preview = server.previewBattleTeam(context, draft);
  assert.deepEqual(browser.previewBattleTeam(context, draft), preview);
  for (const item of [ownWeapon, weapon, benchWeapon]) {
    const [status] = preview.continuous_card_statuses[item];
    assert.equal(status.source_card_id, sourceCard); assert.equal(status.kind, 'buff'); assert.equal(status.continuous, true);
    assert.match(status.description, new RegExp(`光照 \\+${light}`));
    if (attack) assert.match(status.description, new RegExp(`攻击 \\+${attack}`));
  }
  assert.equal(preview.continuous_card_statuses[loose], undefined);
  assert.equal(preview.calculation.light, light * 2, 'benched equipment is buffed but contributes no light');
  assert.equal(preview.calculation.components.find(row => row.instance_id === weapon).attack, 1 + attack);
  assert.equal(preview.calculation.components.some(row => row.instance_id === benchWeapon), false);
  assert.deepEqual(f.state, before, 'continuous effects never modify printed data or authoritative state');
  const off = server.updateBattleDraft(context, draft, {type: 'set_hero', instance_id: source, selected: false});
  assert.deepEqual(server.previewBattleTeam(context, off).continuous_card_statuses, {});
  assert.equal(server.previewBattleTeam(context, off).calculation.light, 0);
  const unequipped = server.updateBattleDraft(context, draft, {type: 'unequip', weapon_instance_id: weapon});
  assert.equal(server.previewBattleTeam(context, unequipped).continuous_card_statuses[weapon], undefined);
  const committed = server.applyCommand(f.state, server.buildSubmitBattleTeamCommand(context, draft), f.catalog, f.rules);
  const statuses = server.turnOptions(committed.state, 'alice', f.catalog, f.rules).card_statuses;
  for (const item of [ownWeapon, weapon, benchWeapon]) assert.deepEqual(statuses[item], preview.continuous_card_statuses[item]);
  assert.equal(committed.state.battle_context.card_modifiers, undefined);
  assert.equal(committed.state.battle_context.card_statuses, undefined, 'auras are derived, not stored as permanent modifiers');
  const reopened = server.applyCommand(committed.state, {type: 'ReviseBattleTeam', player_id: 'alice', expected_version: committed.state.game_version}, f.catalog, f.rules);
  assert.deepEqual(server.turnOptions(reopened.state, 'alice', f.catalog, f.rules).card_statuses, {});
});

test('several participating aura sources stack, and a departed source cannot leave a weapon buff behind', () => {
  const f = fixture(['TS-0411', 'TS-0412', 'TS-0001', 'TS-0002'], ['TS-0476']);
  const [a, b, hero, weapon] = f.hand, {context} = server.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  let draft = server.createBattleDraft(context);
  draft = server.updateBattleDraft(context, draft, {type: 'equip', hero_instance_id: hero, weapon_instance_id: weapon});
  assert.equal(server.previewBattleTeam(context, draft).continuous_card_statuses[weapon].length, 2);
  assert.equal(server.previewBattleTeam(context, draft).calculation.light, 2);
  f.state.zones['player:alice:hand'].splice(f.state.zones['player:alice:hand'].indexOf(a), 1);
  f.state.zones.destroyed.push(a);
  f.state.instances[a].owner_player_id = null;
  f.state.battle_context = {battle_team: {hero_instance_ids: [b, hero], support_instance_ids: []}, equipped_weapon_by_hero: {[hero]: [weapon]}};
  const statuses = server.turnOptions(f.state, 'alice', f.catalog, f.rules).card_statuses[weapon];
  assert.equal(statuses.length, 1); assert.equal(statuses[0].source_card_id, 'TS-0412');
});
