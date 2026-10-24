import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {page as domPage} from './support/player-deck-dom.mjs';
import {allocation, setupSelection, cardImageUrl, actionProgress} from '../.test-dist/match-model.js';
import {matchReturnPath} from '../.test-dist/navigation.js';
import {playerActivity} from '../.test-dist/match-player-activity.js';
import {battlePreparation} from '../../engine/dist/index.js';
import {fixture as engineFixture} from '../../engine/tests/support/catalog.mjs';

const source = await readFile(new URL('../.test-dist/match-page.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../match.html', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(status = 'active') {
  const ids = ['TS-0001', 'TS-0002', 'TS-0300', 'TS-0301', 'TS-0476', 'TS-0714', 'TS-0198'];
  const view = {id: 'm'.repeat(32), room_id: 'r'.repeat(32), status, version: 1, host_user_id: 1,
    viewer_player_id: 'alice', can_resolve_setup: status === 'setup_pending', created_at: '',
    players: [{user_id: 1, player_id: 'alice', display_name: '阿莉丝', is_you: true, is_active: true,
      xp: 2, hand_count: 2, draw_count: 4, discard_count: 0, control: []},
    {user_id: 2, player_id: 'bob', display_name: '鲍勃', is_you: false, is_active: false,
      xp: 0, hand_count: 6, draw_count: 6, discard_count: 0, control: []}],
    turn: status === 'active' ? {number: 1, round: 1, active_player_id: 'alice', first_player_id: 'alice', phase: 'PLAYING', subphase: 'TURN_START'} : null,
    draw: [], aside: [], hand: [{instance_id: 'CI-1', card_id: ids[0]}, {instance_id: 'CI-2', card_id: ids[1]}], discard: [],
    supplies: [{zone_id: 'village_supply:test', kind: 'village', top_card_id: ids[1], remaining: 8, infinite: false, cards: [{card_id: ids[1], count: 8}]},
      {zone_id: 'basic_supply:test', kind: 'basic', top_card_id: ids[0], remaining: null, infinite: true, cards: [{card_id: ids[0], count: null}]},
      {zone_id: 'hero_supply:test', kind: 'hero', top_card_id: ids[2], remaining: 10, infinite: false, cards: [{card_id: ids[2], count: 6}, {card_id: ids[3], count: 4}]}],
    dungeons: [{id: 'main', deck_count: 27, hall: [{rank: 1, instance_id: 'CI-3', card_id: ids[4]}]}],
    settings: [{instance_id: 'CI-4', card_id: ids[6]}],
    disease_supply: {mode: 'normal', infinite: true, cards: [{card_id: ids[5], weight: 1}]},
    setup_choice: status === 'setup_pending' ? {kind: 'two_dungeons', group_ids: ids.slice(0, 4), feature_ids: [ids[6]], group_a_count: 2} : null,
    cards: Object.fromEntries(ids.map((id, i) => [id, {card_id: id, name: `卡牌${i}`, card_type: '测试', subcategory: '', tags: [],
      effects: '第一条效果。\n第二条效果。', image_url: `/cards/${id}.png`, stats: {价格: '3', ...(i === 2 || i === 3 ? {英雄等级: String(i - 1)} : {})}}])),
    actor_player_id: 'alice', legal_commands: [{type: 'ChooseAction', actions: ['village', 'dungeon', 'rest']}],
    pending_choice: null, command_instances: {}, abilities: {}, battle_preparation: null,
    viewer_resources: {xp: 2, temporary_gold: 3, purchases_remaining: 1, extra_basic_purchases: 0}, event_log: [], result: null};
  return view;
}

async function page({view = fixture(), authenticated = true, userId = 1, search = `?id=${'m'.repeat(32)}`, post, getMatch, restoreFailureOnce = false, animationsEnabled = false} = {}) {
  const requests = [], navigations = [], sockets = [];
  let current = view, uuidCount = 0;
  class FakeSocket {
    static OPEN = 1; readyState = 1;
    constructor() {sockets.push(this);}
    send() {} close() {this.onclose?.();}
  }
  const ui = await domPage({html, source, animationsEnabled, session: authenticated ? {access_token: 'token', refresh_token: 'refresh'} : null,
    globals: ({document, Element}) => ({HTMLInputElement: Element,
      Option: function(text, value) {const option = document.createElement('option'); option.textContent = text; option.value = value; return option;},
      location: {search, protocol: 'https:', host: 'test.invalid', replace: url => navigations.push(url), assign: url => navigations.push(url)},
      history: {replaceState() {}}, URL, URLSearchParams, structuredClone, queueMicrotask,
      setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, WebSocket: FakeSocket,
      crypto: {randomUUID: () => ++uuidCount === 1 ? 'command-uuid' : `command-uuid-${uuidCount}`}, confirm: () => true,
    }),
    fetchResponse: async (url, options = {}) => {
      requests.push({url, options, body: options.body ? JSON.parse(options.body) : null});
      assert.equal(options.headers?.get('Authorization'), authenticated ? 'Bearer token' : null);
      let result;
      if (url === '/api/v1/users/me') {
        if (restoreFailureOnce) {restoreFailureOnce = false; throw new TypeError('network unavailable');}
        result = {id: userId, username: '阿莉丝', email: 'a@test.invalid'};
      }
      else if (options.method === 'POST') result = post ? await post(url, JSON.parse(options.body), current) : current;
      else if (url === '/api/v1/matches/current') result = {match: current};
      else result = getMatch ? await getMatch() : current;
      return result?.httpError ? {ok: false, status: result.httpError, json: async () => ({error: result.error})}
        : {ok: true, status: 200, json: async () => result};
    }});
  await settle();
  return {...ui, requests, navigations, sockets, setView(value) {current = value;},
    winEvents: new Proxy({}, {get: (_, name) => event => ui.window.fire(name, event)}),
    cleanup() {ui.window.fire('pagehide', {persisted: false});}};
}

test('login return links stay on the match route and reject external destinations', () => {
  assert.equal(matchReturnPath('/match?id=abc_123'), '/match?id=abc_123');
  assert.equal(matchReturnPath('/match'), '/match');
  for (const value of ['https://evil.example/match?id=x', '//evil.example/match', '/play', '/match?id=../../secret']) assert.equal(matchReturnPath(value), null);
  assert.equal(cardImageUrl('/cards/TS-0001.png'), '/cards/TS-0001.png');
  assert.equal(cardImageUrl('https://example.com/track.png'), null);
});

test('allocation filters obsolete entries and preserves only two valid monster groups', () => {
  const view = fixture('setup_pending');
  const chosen = setupSelection(view, {groupA: ['TS-0001', 'TS-0002', 'old'], featureA: ['TS-0198', 'old']});
  const result = allocation(view, chosen);
  assert.deepEqual(result.groupA, ['TS-0001', 'TS-0002']); assert.deepEqual(result.groupB, ['TS-0300', 'TS-0301']);
  assert.deepEqual(result.featureA, ['TS-0198']); assert.equal(result.valid, true);
  assert.equal(allocation(view, {groupA: [], featureA: []}).valid, false);
});

test('unauthenticated match page fetches no match data and returns through login', async () => {
  const ui = await page({authenticated: false});
  assert.deepEqual(ui.requests, []); assert.equal(ui.get('match-content').hidden, true);
  assert.equal(ui.navigations[0], `/play?next=${encodeURIComponent(`/match?id=${'m'.repeat(32)}`)}`); ui.cleanup();
});

test('active match renders public piles and own cards; details use actual card data', async () => {
  const ui = await page();
  assert.equal(ui.get('notice').textContent, '');
  assert.equal(ui.get('match-content').hidden, false); assert.equal(ui.get('active-table').hidden, false);
  assert.equal(handCards(ui).length, 2); assert.equal(ui.get('match-public-players').children[1].children.length, 2);
  assert.ok(ui.get('match-public-village-cards-pile-hero_supply:test')); assert.ok(ui.get('match-public-village-cards-pile-basic_supply:test'));
  assert.match(ui.get('match-title').textContent, /阿莉丝/); assert.match(ui.get('disease-description').textContent, /无限供应/);
  ui.get('disease-cards').children[0].dispatch('click');
  assert.equal(ui.get('card-dialog').open, true); assert.equal(ui.get('card-detail-name').textContent, '卡牌5');
  assert.match(ui.get('card-detail').textContent, /第二条效果/);
  ui.get('close-card-dialog').dispatch('click'); assert.equal(ui.get('card-dialog').open, false); ui.cleanup();
});

test('flying spire host selects two groups, submits once and shows the resulting board', async () => {
  const ui = await page({view: fixture('setup_pending'), post: async () => fixture()});
  const checkbox = i => ui.get('setup-monsters').children[i].children.at(-1).children[0];
  assert.equal(ui.get('confirm-setup').disabled, true);
  checkbox(0).checked = true; checkbox(0).dispatch('change'); checkbox(1).checked = true; checkbox(1).dispatch('change');
  assert.equal(checkbox(2).disabled, true); assert.equal(ui.get('confirm-setup').disabled, false);
  const feature = ui.get('setup-features').children[0].children.at(-1).children[0]; feature.checked = true; feature.dispatch('change');
  ui.get('confirm-setup').dispatch('click'); ui.get('confirm-setup').dispatch('click'); await settle();
  const calls = ui.requests.filter(r => r.options.method === 'POST'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {expected_version: 1, group_a_ids: ['TS-0001', 'TS-0002'], group_a_feature_ids: ['TS-0198'], command_id: 'command-uuid'});
  assert.equal(ui.get('active-table').hidden, false); assert.equal(ui.get('setup-panel').hidden, true);
  assert.equal(ui.get('cancel-match').disabled, false, 'success must unlock cancel without waiting for a websocket event'); ui.cleanup();
});

test('nonhost allocation is read-only; realtime and reconnect reload the authoritative match', async () => {
  const view = fixture('setup_pending'); view.can_resolve_setup = false;
  const ui = await page({view, userId: 2});
  assert.equal(ui.get('confirm-setup').hidden, true); assert.equal(ui.get('cancel-match-bar').hidden, true);
  assert.equal(ui.get('setup-monsters').children[0].children.at(-1).children[0].disabled, true);
  ui.setView(fixture()); ui.sockets[0].onmessage({data: JSON.stringify({type: 'match_changed'})}); await settle();
  assert.equal(ui.get('active-table').hidden, false);
  const changed = fixture(); changed.turn.number = 2; ui.setView(changed);
  ui.sockets[0].onmessage({data: JSON.stringify({type: 'ack'})}); await settle();
  assert.match(ui.get('match-subtitle').textContent, /第 2 回合/); ui.cleanup();
});

test('current-match restoration and cancelled notifications show a return to the room', async () => {
  const ui = await page({search: ''});
  assert.ok(ui.requests.some(r => r.url === '/api/v1/matches/current'));
  ui.setView({...fixture(), status: 'cancelled', version: 2});
  ui.sockets[0].onmessage({data: JSON.stringify({type: 'match_changed'})}); await settle();
  assert.equal(ui.get('match-content').hidden, true); assert.equal(ui.get('empty-view').hidden, false);
  assert.equal(ui.get('empty-title').textContent, '本局已取消'); ui.cleanup();
});

test('host cancellation posts versioned command and navigates only after confirmation succeeds', async () => {
  const ui = await page({post: async () => ({...fixture(), status: 'cancelled', version: 2})});
  ui.get('cancel-match').dispatch('click'); await settle();
  const call = ui.requests.find(r => r.options.method === 'POST');
  assert.ok(call.url.endsWith('/cancel')); assert.deepEqual(call.body, {expected_version: 1, command_id: 'command-uuid'});
  assert.equal(ui.navigations.at(-1), '/play?view=room'); ui.cleanup();
});

test('rule-revision conflicts preserve the actionable server message and unlock retry controls', async () => {
  const ui = await page({view: fixture('setup_pending'), post: async () => ({httpError: 409,
    error: {code: 'match_rules_changed', message: '规则版本已变化，请取消本局后重新开始'}})});
  const checkbox = i => ui.get('setup-monsters').children[i].children.at(-1).children[0];
  for (const i of [0, 1]) {checkbox(i).checked = true; checkbox(i).dispatch('change');}
  ui.get('confirm-setup').dispatch('click'); await settle(); await settle();
  assert.match(ui.get('notice').textContent, /请取消本局后重新开始/);
  assert.equal(ui.get('cancel-match').disabled, false); assert.equal(ui.get('confirm-setup').disabled, false); ui.cleanup();
});

test('a failed initial session request can recover via the refresh button', async () => {
  const ui = await page({restoreFailureOnce: true});
  assert.equal(ui.get('match-content').hidden, true); assert.match(ui.get('page-state').textContent, /暂未同步/);
  ui.get('refresh-match').dispatch('click'); await settle(); await settle();
  assert.equal(ui.get('match-content').hidden, false); assert.equal(ui.get('notice').hidden, true); ui.cleanup();
});

function descendants(node) {return node.children.flatMap(child => [child, ...descendants(child)]);}
const commandButtons = (ui, type) => descendants(ui.get('turn-actions')).filter(node => node.dataset.command === type);
function commandView(command) {
  const view = fixture(); view.legal_commands = [command];
  view.command_instances = Object.fromEntries(view.hand.map(item => [item.instance_id, {...item, owner_player_id: 'alice'}]));
  view.abilities = {'TS-0001-A01': {source_card_id: 'TS-0001', source_line: '地下城：抽 1 张牌。'},
    'TS-0002-A01': {source_card_id: 'TS-0002', source_line: '攻击 +1。'}};
  if (command.type.startsWith('Resolve')) view.pending_choice = {kind: 'test_choice', player_id: 'alice', can_resolve: true,
    ability_id: 'TS-0001-A01', stage: command.stage};
  return view;
}

for (const [title, legal, expected] of [
  ['choose village', {type: 'ChooseAction', actions: ['village']}, {type: 'ChooseAction', action: 'village'}],
  ['activate', {type: 'ActivateAbility', options: [{ability_id: 'TS-0001-A01', source_instance_id: 'CI-1'}]}, {type: 'ActivateAbility', ability_id: 'TS-0001-A01', source_instance_id: 'CI-1'}],
  ['buy', {type: 'BuyCard', card_ids: ['TS-0001'], options: [{card_id: 'TS-0001', price: 2}]}, {type: 'BuyCard', card_id: 'TS-0001'}],
  ['upgrade', {type: 'UpgradeHero', options: [{source_instance_id: 'CI-1', target_card_id: 'TS-0300', xp_cost: 2}]}, {type: 'UpgradeHero', source_instance_id: 'CI-1', target_card_id: 'TS-0300'}],
  ['rest', {type: 'RestDestroy', instance_ids: ['CI-1']}, {type: 'RestDestroy', instance_id: 'CI-1'}],
  ['pass', {type: 'FinishUpgrading'}, {type: 'FinishUpgrading'}],
  ['spell', {type: 'UseSpell', instance_ids: ['CI-1']}, {type: 'UseSpell', instance_id: 'CI-1'}],
  ['number', {type: 'ResolveValueChoice', options: [0, 2]}, {type: 'ResolveValueChoice', value: 0}],
  ['boolean', {type: 'ResolveValueChoice', options: [false, true]}, {type: 'ResolveValueChoice', value: false}],
  ['player', {type: 'ResolveValueChoice', options: ['bob']}, {type: 'ResolveValueChoice', value: 'bob'}],
  ['effect purchase', {type: 'ResolveEffectPurchase', options: [{card_id: 'TS-0001', price: 2}], may_skip: true}, {type: 'ResolveEffectPurchase', card_id: 'TS-0001'}],
  ['effect upgrade', {type: 'ResolveEffectUpgrade', options: [{source_instance_id: 'CI-1', target_card_id: 'TS-0300', xp_cost: 2}]}, {type: 'ResolveEffectUpgrade', source_instance_id: 'CI-1', target_card_id: 'TS-0300'}],
  ['reuse', {type: 'ResolveReusedAbility', ability_ids: ['TS-0001-A01']}, {type: 'ResolveReusedAbility', ability_id: 'TS-0001-A01'}],
  ['response source', {type: 'ResolveResponse', stage: 'source', options: [{source_instance_id: 'CI-1', ability_id: 'TS-0001-A01', action: 'ignore_trap'}], may_decline: true}, {type: 'ResolveResponse', source_instance_id: 'CI-1', recipient_id: null}],
  ['response recipient', {type: 'ResolveResponse', stage: 'recipient', options: ['bob'], may_decline: true}, {type: 'ResolveResponse', source_instance_id: null, recipient_id: 'bob'}],
  ['disease source', {type: 'ResolveDiseaseReplacement', stage: 'source', options: [{source_instance_id: 'CI-1', ability_id: 'TS-0001-A01', action: 'destroy'}]}, {type: 'ResolveDiseaseReplacement', source_instance_id: 'CI-1', recipient_id: null}],
  ['disease recipient', {type: 'ResolveDiseaseReplacement', stage: 'recipient', options: ['bob']}, {type: 'ResolveDiseaseReplacement', source_instance_id: null, recipient_id: 'bob'}],
]) test(`match command UI: ${title} uses versioned endpoint and only public command fields`, async () => {
  const ui = await page({view: commandView(legal), post: async () => ({...fixture(), version: 2})});
  const button = commandButtons(ui, legal.type)[0]; assert.ok(button, legal.type);
  if (title === 'activate') assert.match(button.textContent, /卡牌0：地下城：抽 1 张牌/);
  if (title === 'buy') assert.match(ui.get('turn-actions').textContent, /2 金币/);
  if (title === 'boolean') assert.equal(button.textContent, '否');
  button.dispatch('click'); button.dispatch('click'); await settle();
  const requests = ui.requests.filter(r => r.url.endsWith('/commands')); assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, {expected_version: 1, command_id: 'command-uuid', command: expected});
  assert.equal(commandButtons(ui, 'ChooseAction')[0].disabled, false); ui.cleanup();
});

test('effect multi-selection includes all selected instances and supports an optional zero selection', async () => {
  const ui = await page({view: commandView({type: 'ResolveChoice', instance_ids: ['CI-1', 'CI-2'], min_count: 1, max_count: 2})});
  for (const id of ['CI-1', 'CI-2']) {
    const input = descendants(ui.get('turn-actions')).find(node => node.dataset.choiceInstance === id);
    input.checked = true; input.dispatch('change');
  }
  commandButtons(ui, 'ResolveChoice')[0].dispatch('click'); await settle();
  assert.deepEqual(ui.requests.find(r => r.url.endsWith('/commands')).body.command, {type: 'ResolveChoice', instance_ids: ['CI-1', 'CI-2']}); ui.cleanup();
  const optional = await page({view: commandView({type: 'ResolveChoice', instance_ids: ['CI-1'], min_count: 0, max_count: 1})});
  assert.equal(commandButtons(optional, 'ResolveChoice')[0].disabled, false);
  commandButtons(optional, 'ResolveChoice')[0].dispatch('click'); await settle();
  assert.deepEqual(optional.requests.find(r => r.url.endsWith('/commands')).body.command.instance_ids, []); optional.cleanup();
});

for (const kind of ['ResolveCardOrder', 'ResolveEffectOrder']) test(`${kind} sends the visible edited order`, async () => {
  const legal = kind === 'ResolveCardOrder' ? {type: kind, instance_ids: ['CI-1', 'CI-2']} : {type: kind, effects: [
    {effect_id: 'e1', ability_id: 'TS-0001-A01', source_instance_id: 'CI-1'}, {effect_id: 'e2', ability_id: 'TS-0002-A01', source_instance_id: 'CI-2'}]};
  const ui = await page({view: commandView(legal)});
  descendants(ui.get('turn-actions')).find(node => node.dataset.orderIndex === '1' && node.dataset.offset === '-1').dispatch('click');
  commandButtons(ui, kind)[0].dispatch('click'); await settle();
  const command = ui.requests.find(r => r.url.endsWith('/commands')).body.command;
  assert.deepEqual(command[kind === 'ResolveCardOrder' ? 'instance_ids' : 'effect_ids'], kind === 'ResolveCardOrder' ? ['CI-2', 'CI-1'] : ['e2', 'e1']); ui.cleanup();
});

test('other players see a waiting message without command controls or private choice labels', async () => {
  const view = commandView({type: 'ResolveValueChoice', options: ['pay']});
  view.actor_player_id = 'bob'; view.pending_choice = {kind: 'effect_value', player_id: 'bob', can_resolve: false}; view.legal_commands = [];
  const ui = await page({view});
  assert.match(ui.get('turn-controls-note').textContent, /等待 鲍勃/); assert.equal(ui.get('turn-actions').children.length, 0); ui.cleanup();
});

function battleView() {
  const f = engineFixture(['TS-0001', 'TS-0002', 'TS-0272'], ['TS-0476']);
  const view = fixture(); view.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  view.hand = f.hand.map(instance_id => ({instance_id, card_id: f.state.instances[instance_id].card_id}));
  view.dungeons = [{id: 'main', deck_count: 0, hall: [{rank: 1, instance_id: f.hall[0], card_id: 'TS-0476'}]}];
  for (const id of ['TS-0001', 'TS-0002', 'TS-0272', 'TS-0476']) view.cards[id] = {...view.cards['TS-0001'], card_id: id, name: f.cards[id].name, image_url: `/cards/${id}.png`};
  view.legal_commands = [{type: 'SubmitBattleTeam', target_instance_ids: f.hall}, {type: 'EquipWeapon', options: [{hero_instance_id: f.hand[0], weapon_instance_id: f.hand[1]}]}];
  return {view, f};
}

test('battle team uses the shared local engine, keeps cards in hand and submits only the chosen team', async () => {
  const {view, f} = battleView();
  const ui = await page({view, post: async () => ({...fixture(), version: 2})});
  const [hero, weapon, spell] = f.hand;
  const selectHero = ui.get(`hand-controls-${hero}`).children[0].children[0]; selectHero.checked = false; selectHero.dispatch('change');
  assert.match(ui.get('battle-team-panel').textContent, /攻击0/);
  const selectSpell = ui.get(`hand-controls-${spell}`).children[0].children[0]; selectSpell.checked = false; selectSpell.dispatch('change');
  assert.match(ui.get('battle-team-panel').textContent, /魔法攻击0/);
  const reselectHero = ui.get(`hand-controls-${hero}`).children[0].children[0]; reselectHero.checked = true; reselectHero.dispatch('change');
  const equip = descendants(ui.get('battle-team-panel')).find(node => node.dataset.weaponInstance === weapon); equip.value = hero; equip.dispatch('change');
  const target = descendants(ui.get('battle-team-panel')).find(node => node.dataset.battleTarget); target.value = f.hall[0]; target.dispatch('change');
  assert.match(ui.get('battle-team-panel').textContent, /攻击2/);
  assert.equal(handCards(ui).length, 3); assert.equal(ui.requests.filter(r => r.options.method === 'POST').length, 0);
  descendants(ui.get('battle-team-panel')).find(node => node.dataset.command === 'SubmitBattleTeam').dispatch('click'); await settle();
  const command = ui.requests.find(r => r.url.endsWith('/commands')).body.command;
  assert.deepEqual(command, {type: 'SubmitBattleTeam', draft: {target_instance_id: f.hall[0], hero_instance_ids: [hero], support_instance_ids: [], equipment: {[hero]: [weapon]}}});
  ui.cleanup();
});

test('same-version recovery restores a temporarily unavailable battle preparation', async () => {
  const {view} = battleView(), ui = await page({view: {...view, battle_preparation: null}});
  assert.equal(ui.get('battle-team-panel').hidden, true);
  ui.setView(view); ui.sockets[0].onmessage({data: JSON.stringify({type: 'match_changed'})}); await settle();
  assert.equal(ui.get('battle-team-panel').hidden, false);
  assert.match(ui.get('battle-team-panel').textContent, /魔法攻击/); ui.cleanup();
});

for (const order of ['post-first', 'refresh-first']) test(`POST/GET race preserves newer authoritative version: ${order}`, async () => {
  let finishPost, finishGet, refreshing = false;
  const postResult = new Promise(resolve => {finishPost = resolve;}), getResult = new Promise(resolve => {finishGet = resolve;});
  const ui = await page({post: () => postResult, getMatch: () => refreshing ? getResult : fixture()});
  commandButtons(ui, 'ChooseAction')[0].dispatch('click');
  refreshing = true; ui.sockets[0].onmessage({data: JSON.stringify({type: 'match_changed'})});
  const older = {...fixture(), version: 2}, newer = {...fixture(), version: 3};
  older.turn.number = 2; newer.turn.number = 3;
  if (order === 'post-first') {finishPost(older); await settle(); finishGet(newer);}
  else {finishGet(newer); await settle(); finishPost(older);}
  await settle(); await settle();
  assert.match(ui.get('match-subtitle').textContent, /第 3 回合/);
  assert.equal(commandButtons(ui, 'ChooseAction')[0].disabled, false); ui.cleanup();
});

test('network retry reuses command id while a later version creates a new one', async () => {
  let calls = 0;
  const ui = await page({post: () => {if (++calls === 1) throw new TypeError('offline'); return {...fixture(), version: calls};}});
  commandButtons(ui, 'ChooseAction')[0].dispatch('click'); await settle();
  assert.match(ui.get('notice').textContent, /连接失败/);
  assert.equal(commandButtons(ui, 'ChooseAction')[0].disabled, false);
  commandButtons(ui, 'ChooseAction')[0].dispatch('click'); await settle();
  commandButtons(ui, 'ChooseAction')[0].dispatch('click'); await settle();
  const requests = ui.requests.filter(r => r.url.endsWith('/commands'));
  assert.equal(requests.length, 3); assert.equal(requests[0].body.command_id, requests[1].body.command_id);
  assert.notEqual(requests[1].body.command_id, requests[2].body.command_id);
  assert.equal(requests[2].body.expected_version, 2); ui.cleanup();
});

test('version-conflict refresh removes stale controls when the actor changes', async () => {
  let current = fixture();
  const ui = await page({getMatch: () => current, post: () => {
    current = {...fixture(), version: 2, actor_player_id: 'bob', legal_commands: []};
    return {httpError: 409, error: {code: 'match_version_conflict', message: 'version conflict'}};
  }});
  const stale = commandButtons(ui, 'ChooseAction')[0]; stale.dispatch('click'); await settle(); await settle();
  assert.match(ui.get('turn-controls-note').textContent, /等待 鲍勃/);
  assert.equal(commandButtons(ui, 'ChooseAction').length, 0);
  stale.dispatch('click'); await settle();
  assert.equal(ui.requests.filter(r => r.url.endsWith('/commands')).length, 1); ui.cleanup();
});

test('cancellation locks turn controls immediately and restores them after a failed request', async () => {
  let fail;
  const pending = new Promise((_, reject) => {fail = reject;});
  const ui = await page({post: () => pending}); ui.get('cancel-match').dispatch('click');
  assert.equal(commandButtons(ui, 'ChooseAction')[0].disabled, true);
  commandButtons(ui, 'ChooseAction')[0].dispatch('click');
  assert.equal(ui.requests.filter(r => r.options.method === 'POST').length, 1);
  fail(new TypeError('offline')); await settle();
  assert.equal(commandButtons(ui, 'ChooseAction')[0].disabled, false); ui.cleanup();
});

test('finished game shows score and public battle result without remaining commands', async () => {
  const view = fixture('finished'); view.legal_commands = []; view.actor_player_id = null;
  view.players[1].eliminated = true;
  view.result = {winner_ids: ['alice'], tie_break: null, players: {
    alice: {victory_points: 14, thunderstones: 1, eliminated: false}, bob: {victory_points: 7, thunderstones: 0, eliminated: true},
  }};
  view.event_log = [{sequence: 1, kind: 'battle_resolved', target_card_id: 'TS-0476', outcome: 'win', health: 5, calculation: {effective_attack: 7}},
    {sequence: 2, kind: 'player_eliminated', player_id: 'bob'}, {sequence: 3, kind: 'private_unknown', secret: 'must not appear'}];
  const ui = await page({view});
  assert.match(ui.get('turn-controls-note').textContent, /阿莉丝获胜/);
  assert.match(ui.get('turn-actions').textContent, /14/); assert.match(ui.get('match-public-players').textContent, /已淘汰/);
  assert.equal(ui.get('cancel-match-bar').hidden, true);
  assert.match(ui.get('event-log').textContent, /对战卡牌4：胜利；有效攻击 7，目标生命 5/);
  assert.doesNotMatch(ui.get('event-log').textContent, /private_unknown|must not appear/);
  assert.equal(commandButtons(ui, 'ChooseAction').length, 0); ui.cleanup();
});

test('duplicate hand abilities identify the exact visible card instance', async () => {
  const view = commandView({type: 'ActivateAbility', options: [
    {source_instance_id: 'CI-1', ability_id: 'TS-0001-A01'}, {source_instance_id: 'CI-2', ability_id: 'TS-0001-A01'},
  ]});
  view.hand[1].card_id = 'TS-0001'; view.command_instances['CI-2'].card_id = 'TS-0001';
  const ui = await page({view});
  assert.match(commandButtons(ui, 'ActivateAbility')[0].textContent, /手牌 1/);
  assert.match(commandButtons(ui, 'ActivateAbility')[1].textContent, /手牌 2/);
  assert.deepEqual(handCards(ui).map(card => card.dataset.instanceId), ['CI-1', 'CI-2']); ui.cleanup();
});

function handCards(ui) {return ui.get('match-deck-hand-track').children.filter(node => node.dataset.instanceId);}

function restView(candidates = ['CI-1', 'CI-2']) {
  const view = fixture(); view.turn.subphase = 'REST'; view.turn.chosen_action = 'rest';
  view.legal_commands = [...(candidates.length ? [{type: 'RestDestroy', instance_ids: candidates}] : []), {type: 'SkipRestDestroy'}];
  return view;
}
const posts = ui => ui.requests.filter(request => request.url.endsWith('/commands'));
const glowing = ui => handCards(ui).filter(card => card.dataset.glowing === 'true').map(card => card.dataset.instanceId);

test('action and numbered stage labels use the server action, phase and paused event', () => {
  const cases = [
    ['village', 'VILLAGE_ABILITIES', 'VILLAGE_ENTER', 1, '展示手牌'],
    ['village', 'VILLAGE_ABILITIES', null, 2, '使用村庄效果'],
    ['village', 'VILLAGE_BUY', 'VILLAGE_GOLD', 3, '生产金币'],
    ['village', 'VILLAGE_BUY', null, 4, '购买卡牌'],
    ['village', 'VILLAGE_UPGRADE', null, 5, '升级英雄'],
    ['village', 'ACTION_END', null, 6, '结束回合'],
    ['dungeon', 'DUNGEON_PREPARE', 'DUNGEON_ENTER', 1, '展示手牌'],
    ['dungeon', 'DUNGEON_PREPARE', null, 2, '构建战斗队伍'],
    ['dungeon', 'BATTLE_COMMIT', null, 3, '宣言战斗'],
    ['dungeon', 'BATTLE_EFFECTS', null, 4, '结算战斗'],
    ['dungeon', 'BATTLE_AFTER_EFFECTS', null, 4, '结算战斗'],
    ['dungeon', 'ACTION_END', null, 5, '结束回合'],
    ['rest', 'REST', null, 1, '摧毁手牌'],
    ['rest', 'ACTION_END', null, 2, '结束回合'],
  ];
  for (const [action, subphase, resolving_event, step, stage] of cases) {
    const view = fixture(); Object.assign(view.turn, {chosen_action: action, subphase, resolving_event});
    assert.deepEqual(actionProgress(view), {action: {village: '访问村庄', dungeon: '进入地下城', rest: '休整'}[action],
      stage, step, total: {village: 6, dungeon: 5, rest: 2}[action]});
  }
  assert.equal(actionProgress(fixture()), undefined);
  const finished = restView(); finished.status = 'finished'; assert.equal(actionProgress(finished), undefined);
});

for (const [action, total] of [['village', 6], ['dungeon', 5]]) test(`${action} ends only through the common red end-turn choice`, async () => {
  const view = fixture(); Object.assign(view.turn, {subphase: 'ACTION_END', chosen_action: action});
  view.legal_commands = [{type: 'FinishTurn'}];
  const ui = await page({view, post: () => ({...fixture(), version: 2})});
  const root = ui.get('match-deck-player-response');
  assert.equal(root.children[0], ui.get('match-deck-turn-indicator'));
  assert.equal(root.children[1], ui.get('match-deck-response-progress'));
  assert.match(root.children[1].textContent, new RegExp(`${total}/${total} 结束回合`));
  assert.equal(ui.get('match-deck-response-FinishTurn').dataset.tone, 'red');
  assert.equal(posts(ui).length, 0);
  await ui.click('refresh-match'); assert.equal(posts(ui).length, 0);
  await ui.click('match-deck-response-FinishTurn');
  assert.deepEqual(posts(ui).map(request => request.body.command), [{type: 'FinishTurn'}]); ui.cleanup();
});

test('own turn indicator leads the response area, and each action has its own labeled color', async () => {
  const ui = await page(), response = ui.get('match-deck-player-response'), marker = ui.get('match-deck-turn-indicator');
  assert.equal(response.children[0], marker); assert.equal(marker.getAttribute('aria-label'), '当前是你的回合');
  assert.equal(marker.children[0].tagName, 'svg');
  for (const [action, label, tone] of [['village', '访问村庄', 'gold'], ['dungeon', '进入地下城', 'violet'], ['rest', '休整', 'blue']]) {
    const button = ui.get(`match-deck-response-action:${action}`); assert.equal(button.textContent, label); assert.equal(button.dataset.tone, tone);
  }
  const next = fixture(); next.version++; next.turn.active_player_id = 'bob'; next.actor_player_id = 'bob'; next.legal_commands = [];
  ui.setView(next); await ui.click('refresh-match');
  assert.equal(marker.isConnected, false); assert.equal(ui.get('match-deck-response-action:rest').isConnected, false); ui.cleanup();
});

test('rest first offers destruction or skipping, then glows only legal cards and submits exactly the clicked instance', async () => {
  const next = fixture(); next.version = 3; next.actor_player_id = 'bob'; next.turn.active_player_id = 'bob'; next.legal_commands = [];
  next.hand = [{instance_id: 'new-hand', card_id: 'TS-0002'}];
  const ui = await page({post: (_url, body) => body.command.type === 'ChooseAction' ? {...restView(['CI-2']), version: 2} : next});
  await ui.click('match-deck-response-action:rest');
  assert.equal(ui.get('match-deck-response-rest:destroy').textContent, '摧毁手牌');
  assert.equal(ui.get('match-deck-response-SkipRestDestroy').textContent, '跳过'); assert.deepEqual(glowing(ui), []);
  assert.equal(ui.get('match-deck-response-progress').textContent, '休整 · 1/2 摧毁手牌');
  assert.equal(ui.get('match-deck-player-response').children.find(node => node.className === 'player-response-prompt').textContent, '');
  handCards(ui)[0].fire('click'); assert.equal(posts(ui).length, 1);
  await ui.click('match-deck-response-rest:destroy'); assert.deepEqual(glowing(ui), ['CI-2']);
  assert.match(ui.get('match-deck-player-response').textContent, /选择一张手牌摧毁/);
  const [ineligible, eligible] = handCards(ui); ineligible.fire('click'); assert.equal(posts(ui).length, 1);
  eligible.fire('pointerenter'); ui.key('Alt'); assert.equal(ui.get('match-deck-inspect-overlay').hidden, false); ui.release();
  eligible.fire('click'); eligible.fire('click'); await settle();
  assert.deepEqual(posts(ui).map(request => request.body.command), [
    {type: 'ChooseAction', action: 'rest'}, {type: 'RestDestroy', instance_id: 'CI-2'},
  ]);
  assert.equal(posts(ui)[1].body.expected_version, 2); assert.deepEqual(glowing(ui), []);
  assert.equal(ui.get('match-deck-response-rest:destroy').isConnected, false); ui.cleanup();
});

for (const selecting of [false, true]) test(`skipping rest destruction waits at stage two, including during targeting: ${selecting}`, async () => {
  const ready = restView(); ready.version = 2; ready.turn.subphase = 'ACTION_END'; ready.legal_commands = [{type: 'FinishTurn'}];
  const ui = await page({view: restView(), post: (_url, body) => body.command.type === 'SkipRestDestroy' ? ready : {...fixture(), version: 3}});
  if (selecting) await ui.click('match-deck-response-rest:destroy');
  await ui.click('match-deck-response-SkipRestDestroy');
  assert.deepEqual(posts(ui).map(request => request.body.command), [{type: 'SkipRestDestroy'}]);
  assert.equal(ui.get('match-deck-response-progress').textContent, '休整 · 2/2 结束回合');
  assert.equal(ui.get('match-deck-response-FinishTurn').dataset.tone, 'red');
  assert.equal(handCards(ui).length, 2);
  await ui.click('match-deck-response-FinishTurn');
  assert.deepEqual(posts(ui).map(request => request.body.command), [{type: 'SkipRestDestroy'}, {type: 'FinishTurn'}]);
  assert.deepEqual(glowing(ui), []); ui.cleanup();
});

test('rest targeting may be cancelled or refreshed, and reordering does not change the chosen instance', async () => {
  const ui = await page({view: restView()});
  await ui.click('match-deck-response-rest:destroy'); assert.deepEqual(glowing(ui), ['CI-1', 'CI-2']);
  await ui.click('match-deck-response-rest:destroy'); assert.deepEqual(glowing(ui), []); assert.equal(posts(ui).length, 0);
  await ui.click('match-deck-response-rest:destroy'); await ui.click('refresh-match');
  assert.deepEqual(glowing(ui), ['CI-1', 'CI-2']);
  const stale = handCards(ui)[0], next = restView(['CI-2']); next.version++;
  ui.setView(next); await ui.click('refresh-match'); assert.deepEqual(glowing(ui), []);
  stale.fire('click'); assert.equal(posts(ui).length, 0);
  await ui.click('match-deck-response-rest:destroy'); assert.deepEqual(glowing(ui), ['CI-2']);
  ui.get('match-deck-auto-sort-hand').checked = true; ui.get('match-deck-auto-sort-hand').fire('change');
  assert.deepEqual(glowing(ui), ['CI-2']); ui.cleanup();
});

test('rest targeting restores after a network failure, locks repeated clicks and reuses the retry command ID', async () => {
  let calls = 0;
  const ui = await page({view: restView(), post: () => {if (++calls === 1) throw new TypeError('offline'); return {...fixture(), version: 2};}});
  await ui.click('match-deck-response-rest:destroy'); const card = handCards(ui)[0];
  card.fire('click'); card.fire('click'); assert.equal(posts(ui).length, 1); assert.deepEqual(glowing(ui), []);
  await settle(); assert.match(ui.get('notice').textContent, /连接失败/); assert.deepEqual(glowing(ui), ['CI-1', 'CI-2']);
  card.fire('click'); await settle();
  assert.equal(posts(ui).length, 2); assert.equal(posts(ui)[0].body.command_id, posts(ui)[1].body.command_id); ui.cleanup();
});

test('rest destruction advances to stage two, then explicit end plays the complete refill sequence', async () => {
  const view = restView(); view.draw = [{instance_id: 'd1', card_id: 'TS-0001'}, {instance_id: 'd2', card_id: 'TS-0002'}, {instance_id: 'd3', card_id: 'TS-0001'}];
  view.discard = [{instance_id: 'x1', card_id: 'TS-0001'}, {instance_id: 'x2', card_id: 'TS-0002'}];
  const destroyed = structuredClone(view); destroyed.version = 2; destroyed.turn.subphase = 'ACTION_END'; destroyed.hand = destroyed.hand.slice(1); destroyed.legal_commands = [{type: 'FinishTurn'}];
  destroyed.event_log = [{sequence: 1, kind: 'rest_card_destroyed', player_id: 'alice', card_id: 'TS-0001'}];
  const ended = structuredClone(destroyed); ended.version = 3; ended.actor_player_id = 'bob'; ended.turn.active_player_id = 'bob'; ended.legal_commands = [];
  ended.hand = [...view.draw, ...view.discard, ...destroyed.hand]; ended.draw = []; ended.discard = [];
  ended.event_log.push({sequence: 2, kind: 'turn_hand_discarded', player_id: 'alice', count: 1}, {sequence: 3, kind: 'player_deck_shuffled', player_id: 'alice'}, {sequence: 4, kind: 'cards_drawn', player_id: 'alice', count: 6});
  const ui = await page({view, animationsEnabled: true, post: (_url, body) => body.command.type === 'RestDestroy' ? destroyed : ended});
  await ui.click('match-deck-response-rest:destroy'); handCards(ui)[0].fire('click'); await settle();
  assert.ok(ui.animations.some(animation => animation.element.className === 'card-destruction'));
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, true);
  // A same-version refresh must not interrupt or restart the destruction.
  ui.setView(destroyed); await ui.click('refresh-match');
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-destruction').length, 1);
  await ui.advance(1500);
  const response = ui.get('match-deck-player-response'), buttons = response.children.filter(node => node.tagName === 'button');
  assert.deepEqual(buttons.map(button => button.textContent), ['结束回合']);
  assert.equal(ui.get('match-deck-response-rest:destroy').isConnected, false);
  assert.equal(ui.get('match-deck-response-progress').textContent, '休整 · 2/2 结束回合');
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false); assert.equal(ui.get('match-deck-response-FinishTurn').dataset.tone, 'red');
  assert.equal(posts(ui).length, 1);
  await ui.click('match-deck-response-FinishTurn'); await ui.advance(3000);
  assert.deepEqual(posts(ui).map(request => request.body.command.type), ['RestDestroy', 'FinishTurn']);
  assert.equal(handCards(ui).length, 6); assert.equal(ui.get('match-deck-draw-count').textContent, '0'); assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  assert.ok(ui.animations.some(animation => animation.element.className === 'shuffle-packet'));
  assert.equal(ui.get('match-deck-card-motion-layer').children.length, 0); ui.cleanup();
});

test('empty hands, waiting recipients and unavailable matches cannot select a rest destruction target', async () => {
  const empty = restView([]); empty.hand = [];
  const ui = await page({view: empty}); assert.equal(ui.get('match-deck-response-rest:destroy').disabled, true);
  assert.equal(ui.get('match-deck-response-SkipRestDestroy').disabled, false); ui.cleanup();
  for (const view of [{...restView(), actor_player_id: 'bob'}, {...restView(), unavailable_reason: '暂不可用'}]) {
    const ui = await page({view});
    assert.equal(ui.all.some(node => node.id === 'match-deck-response-rest:destroy' && node.isConnected), false);
    assert.deepEqual(glowing(ui), []); handCards(ui)[0].fire('click'); assert.equal(posts(ui).length, 0); ui.cleanup();
  }
});

test('table hand clicks and hall target selection update local battle preview without network calls', async () => {
  const {view, f} = battleView(), ui = await page({view});
  const [hero, , spell] = f.hand;
  const card = id => handCards(ui).find(card => card.dataset.instanceId === id);
  assert.equal(card(hero).dataset.selected, 'true');
  card(hero).fire('click'); assert.equal(card(hero).dataset.selected, 'false');
  assert.match(ui.get('battle-team-panel').textContent, /攻击0/);
  card(spell).fire('click'); assert.match(ui.get('battle-team-panel').textContent, /魔法攻击0/);
  card(hero).fire('click');
  ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0].fire('click');
  const target = descendants(ui.get('battle-team-panel')).find(node => node.dataset.battleTarget);
  assert.equal(target.value, f.hall[0]);
  assert.equal(handCards(ui).length, 3);
  assert.equal(ui.requests.filter(request => request.options.method === 'POST').length, 0);
  ui.cleanup();
});

test('hand response bar sends authoritative versioned action and removes choices after the phase changes', async () => {
  const next = {...restView(), version: 2};
  const ui = await page({post: () => next});
  await ui.click('match-deck-response-action:rest');
  assert.deepEqual(ui.requests.find(request => request.url.endsWith('/commands')).body,
    {expected_version: 1, command_id: 'command-uuid', command: {type: 'ChooseAction', action: 'rest'}});
  assert.equal(ui.get('match-deck-response-action:rest').isConnected, false);
  assert.equal(ui.get('match-deck-response-SkipRestDestroy').isConnected, true);
  ui.cleanup();
});

function graphicalView() {
  const view = fixture();
  const card = (instance_id, card_id) => ({instance_id, card_id});
  view.draw = [card('D-1', 'TS-0301'), card('D-2', 'TS-0001')];
  view.discard = [card('X-1', 'TS-0301'), card('X-2', 'TS-0002')];
  view.players[0].avatar_url = '/avatars/alice.png';
  view.players[1].avatar_url = '/avatars/bob.png';
  view.players[1].cards = {hand: [{instance_id: 'opaque', revealed: false}, {...card('shown', 'TS-0476'), revealed: true}],
    draw: [card('inventory:bob:draw:1', 'TS-0301'), card('inventory:bob:draw:0', 'TS-0001')],
    discard: [card('inventory:bob:discard:1', 'TS-0301'), card('inventory:bob:discard:0', 'TS-0002')]};
  return view;
}
const playerCards = ui => ui.get('match-public-player-browser-grid').children.filter(node => node.className === 'player-browser-entry').map(entry => entry.children[0]);

test('opponent turn reveal and rest destruction replace the row bubble without replaying on refresh', async () => {
  const view = graphicalView(); view.actor_player_id = 'bob'; view.turn.active_player_id = 'bob'; view.legal_commands = [];
  view.cards['TS-0001'].name = '民兵'; view.players[1].is_active = true; view.players[0].is_active = false;
  const ui = await page({view}), bubble = ui.get('match-public-player-activity');
  assert.equal(bubble.textContent, '展示了手牌'); assert.equal(bubble.parentElement.dataset.playerId, 'bob');
  const entered = structuredClone(view); entered.version++; entered.turn.subphase = 'REST'; entered.turn.chosen_action = 'rest';
  entered.event_log = [{sequence: 1, kind: 'ACTION_ENTERED', player_id: 'bob', action: 'rest'}];
  ui.setView(entered); await ui.click('refresh-match'); assert.equal(bubble.textContent, '展示了手牌');
  const next = structuredClone(entered); next.version++; next.turn.subphase = 'ACTION_END';
  next.event_log.push({sequence: 2, kind: 'card_destroyed', player_id: 'bob', card_id: 'TS-0001'},
    {sequence: 3, kind: 'rest_card_destroyed', player_id: 'bob', card_id: 'TS-0001'});
  ui.setView(next); await ui.click('refresh-match'); assert.equal(bubble.textContent, '摧毁了 民兵');
  await ui.advance(3000); await ui.click('refresh-match'); await ui.advance(1500); assert.equal(bubble.isConnected, false);
  const own = structuredClone(next); own.version++; own.turn.number++; own.turn.active_player_id = 'alice'; own.actor_player_id = 'alice';
  ui.setView(own); await ui.click('refresh-match'); assert.equal(bubble.isConnected, false); ui.cleanup();
});

test('activity notices ignore old history, own actions and generic destruction without an acting player', () => {
  const own = graphicalView(), rest = [{sequence: 1, kind: 'rest_card_destroyed', player_id: 'alice', card_id: 'TS-0001'}];
  assert.equal(playerActivity(own, structuredClone(own), rest), null);
  const other = structuredClone(own); other.turn.active_player_id = 'bob'; other.turn.subphase = 'REST';
  assert.equal(playerActivity(other, null, [{...rest[0], player_id: 'bob'}]), null);
  assert.equal(playerActivity(other, structuredClone(other), [{sequence: 2, kind: 'card_destroyed', player_id: 'bob', card_id: 'TS-0001'}]), null);
  const next = structuredClone(other); next.turn.number++;
  assert.deepEqual(playerActivity(next, other, []), {playerId: 'bob', text: '展示了手牌'});
});

test('production players use actual names/avatars; only revealed opponents hand cards have fronts', async () => {
  const ui = await page({view: graphicalView()});
  const players = ui.get('match-public-players').children[1].children;
  assert.match(players[1].textContent, /鲍勃/);
  assert.ok(descendants(players[1]).some(node => node.src === '/avatars/bob.png'));
  players[0].children[0].fire('click'); assert.equal(ui.get('match-public-player-browser').hidden, true);
  players[1].children[0].fire('click'); await settle();
  assert.deepEqual(playerCards(ui).map(card => card.dataset.face), ['back', 'front']);
  assert.equal(playerCards(ui)[0].dataset.cardId, undefined);
  await ui.click('match-public-player-browser-draw-tab');
  assert.deepEqual(playerCards(ui).map(card => card.dataset.cardId), ['TS-0001', 'TS-0301']);
  await ui.click('match-public-player-browser-discard-tab');
  assert.deepEqual(playerCards(ui).map(card => card.dataset.cardId), ['TS-0002', 'TS-0301']);
  ui.cleanup();
});

test('open player browser refreshes reveals and names, then closes when the match is cancelled', async () => {
  const view = graphicalView(), ui = await page({view});
  ui.get('match-public-players').children[1].children[1].children[0].fire('click');
  const next = structuredClone(view); next.version++;
  next.players[1].display_name = '新名称';
  next.players[1].cards.hand[0] = {instance_id: 'shown2', card_id: 'TS-0002', revealed: true};
  ui.setView(next); await ui.click('refresh-match');
  assert.equal(ui.get('match-public-player-browser-title').textContent, '新名称');
  assert.deepEqual(playerCards(ui).map(card => card.dataset.face), ['front', 'front']);
  ui.setView({...next, version: 3, status: 'cancelled'}); await ui.click('refresh-match');
  assert.equal(ui.get('match-public-player-browser').hidden, true);
  assert.equal(ui.get('match-content').inert, false); assert.equal(ui.get('match-header').inert, false);
  ui.cleanup();
});

test('draw and discard browsers retain probe sorting, Alt inspection and external snapshot updates', async () => {
  const view = graphicalView(), ui = await page({view});
  ui.get('match-deck-draw-pile').children.find(node => node.dataset.instanceId).fire('click'); await settle();
  const cards = () => descendants(ui.get('match-deck-pile-browser-grid')).filter(node => node.className === 'physical-card' && !node.hidden);
  assert.deepEqual(cards().map(card => card.dataset.cardId), ['TS-0001', 'TS-0301']);
  cards()[0].fire('pointerenter'); ui.key('Alt'); assert.equal(ui.get('match-deck-inspect-overlay').hidden, false); ui.release();
  const next = structuredClone(view); next.version++; next.draw.pop();
  ui.setView(next); await ui.click('refresh-match');
  assert.equal(ui.get('match-deck-pile-browser').hidden, false); assert.deepEqual(cards().map(card => card.dataset.cardId), ['TS-0301']);
  ui.key('Escape');
  ui.get('match-deck-discard-pile').children.find(node => node.dataset.instanceId).fire('click'); await settle();
  assert.deepEqual(cards().map(card => card.dataset.cardId), ['TS-0002', 'TS-0301']);
  ui.cleanup();
});

test('production table includes environment, two halls, extra ranks and all hero levels even when depleted', async () => {
  const view = fixture(); view.cards['TS-0198'].subcategory = '环境牌';
  view.dungeons[0].id = 'a'; view.dungeons[0].rank_count = 4;
  view.dungeons[0].hall.push({rank: 0, instance_id: 'guardian', card_id: 'TS-0476'});
  view.dungeons.push({id: 'b', deck_count: 20, hall: []});
  view.supplies.find(pile => pile.kind === 'hero').cards[0].count = 0;
  const ui = await page({view});
  assert.equal(ui.get('match-public-dungeon-cards-environment').hidden, false);
  for (const id of ['a', 'b']) for (const rank of [1, 2, 3]) assert.ok(ui.get(`match-public-dungeon-cards-${id}-rank-${rank}`).isConnected);
  assert.ok(ui.get('match-public-dungeon-cards-a-rank-0').isConnected); assert.ok(ui.get('match-public-dungeon-cards-a-rank-4').isConnected);
  await ui.click('match-public-village-tab');
  const pile = ui.get('match-public-village-cards-pile-hero_supply:test');
  descendants(pile).find(node => node.className === 'physical-card').fire('click'); await settle();
  assert.equal(ui.get('match-public-village-cards-browser').hidden, false);
  assert.deepEqual(ui.get('match-public-village-cards-browser-grid').children.map(node => node.dataset.depleted), ['true', 'false']);
  ui.setView({...view, version: 2, status: 'cancelled'}); await ui.click('refresh-match');
  assert.equal(ui.get('match-public-village-cards-browser').hidden, true);
  assert.equal(ui.get('match-content').inert, false); ui.cleanup();
});
