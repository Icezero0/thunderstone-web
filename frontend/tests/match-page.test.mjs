import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {page as domPage} from './support/player-deck-dom.mjs';
import {allocation, setupSelection, cardImageUrl, actionProgress} from '../.test-dist/match-model.js';
import {matchReturnPath} from '../.test-dist/navigation.js';
import {playerActivity} from '../.test-dist/match-player-activity.js';
import {battlePreparation, projectActionPrediction, legalCommands} from '../../engine/dist/index.js';
import {predictMatchAction} from '../.test-dist/match-action-prediction.js';
import {fixture as engineFixture} from '../../engine/tests/support/catalog.mjs';

const source = await readFile(new URL('../.test-dist/match-page.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../match.html', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('predicted purchase flies to discard before a slow server reply and confirmation does not replay it', async () => {
  const fx = engineFixture(['TS-0001', 'TS-0002']);
  fx.state.battle_context = null; fx.state.chosen_action = 'village';
  fx.state.subphase = fx.state.timing_window = 'VILLAGE_BUY'; fx.state.players.alice.temporary_gold = 10;
  const view = villageView('VILLAGE_BUY', legalCommands(fx.state, fx.catalog, fx.rules));
  view.viewer_resources = {xp: 0, temporary_gold: 10, purchases_remaining: 1, extra_basic_purchases: 0};
  view.hand = fx.hand.map(id => ({instance_id: id, card_id: fx.state.instances[id].card_id}));
  view.supplies = [{zone_id: 'basic_supply:TS-0002', kind: 'basic', infinite: true, remaining: null,
    top_card_id: 'TS-0002', cards: [{card_id: 'TS-0002', count: null}]}];
  view.action_prediction = projectActionPrediction(fx.state, 'alice', fx.catalog, fx.rules);
  view.sync = {reset: false, event_sequence: 0, history_loaded: false, history_after: 0};
  const expected = predictMatchAction(view, {type: 'BuyCard', card_id: 'TS-0002'}); assert.ok(expected);
  let confirm;
  const ui = await page({view, animationsEnabled: true, post: () => new Promise(resolve => {confirm = resolve;})});
  await ui.click('match-public-village-tab'); await ui.click('match-deck-response-village:buy');
  supplyCard(ui, 'basic_supply:TS-0002').fire('click'); await settle();
  assert.equal(posts(ui).length, 1);
  assert.equal(ui.animations.filter(a => a.element.className === 'card-flight').length, 1);
  await ui.advance(2000);
  assert.equal(ui.get('match-deck-discard-count').textContent, '1');
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false);
  assert.match(ui.get('page-state').textContent, /正在同步 1 步/);
  confirm(expected); await settle(); await ui.advance(2000);
  assert.equal(ui.animations.filter(a => a.element.className === 'card-flight').length, 1);
  assert.doesNotMatch(ui.get('page-state').textContent, /正在同步/); ui.cleanup();
});

const deckMotion = (sequence, steps) => ({sequence, kind: 'player_card_motion', player_id: 'alice', steps});

test('a locally predicted hero upgrade only evolves, including a delayed authoritative confirmation', async () => {
  const fx = engineFixture(['TS-0001']);
  const hero = Object.values(fx.cards).find(card => card.card_type === '英雄牌' && card['wiki_英雄等级'] === '1');
  const zone = 'hero_supply:upgrade-test'; fx.add(hero.card_id, zone);
  fx.state.battle_context = null; fx.state.chosen_action = 'village'; fx.state.turn_hand_public = true;
  fx.state.subphase = fx.state.timing_window = 'VILLAGE_UPGRADE'; fx.state.players.alice.xp = 10;
  const view = villageView('VILLAGE_UPGRADE', legalCommands(fx.state, fx.catalog, fx.rules));
  view.hand = fx.hand.map(id => ({instance_id: id, card_id: fx.state.instances[id].card_id}));
  view.viewer_resources = {xp: 10, temporary_gold: 0, purchases_remaining: 1, extra_basic_purchases: 0};
  view.supplies = [{zone_id: zone, kind: 'hero', infinite: false, remaining: 1, top_card_id: hero.card_id,
    cards: [{card_id: hero.card_id, count: 1}]}];
  view.cards[hero.card_id] = {...view.cards['TS-0300'], card_id: hero.card_id, name: hero.name};
  view.action_prediction = projectActionPrediction(fx.state, 'alice', fx.catalog, fx.rules);
  const expected = predictMatchAction(view, {type: 'UpgradeHero', source_instance_id: fx.hand[0], target_card_id: hero.card_id});
  assert.ok(expected);
  const removal = expected.event_log.find(event => event.kind === 'card_destroyed');
  assert.equal(removal.cause, 'hero_upgrade'); assert.equal(removal.player_id, 'alice');
  let confirm;
  const ui = await page({view, animationsEnabled: true, post: () => new Promise(resolve => {confirm = resolve;})});
  await ui.click('match-deck-response-village:upgrade'); handCards(ui)[0].fire('click'); await settle();
  const count = name => ui.animations.filter(animation => animation.element.className === name).length;
  assert.equal(count('card-destruction'), 0);
  assert.equal(count('card-upgrade'), 1);
  await ui.advance(5000);
  assert.equal(ui.get('match-deck-discard-count').textContent, '1');
  const completedFlights = count('card-upgrade'); // Arrival and departure share one evolution wrapper.
  confirm(expected); await settle(); await ui.advance(5000);
  assert.equal(count('card-destruction'), 0); assert.equal(count('card-upgrade'), completedFlights);
  assert.equal(new Set(ui.animations.filter(animation => animation.element.className === 'card-upgrade').map(animation => animation.element)).size, 1);
  assert.equal(posts(ui).length, 1); ui.cleanup();
});
const moveCards = (source, destination, cards) => ({kind: 'move', source, destination, cards});

for (const shuffle of [false, true]) test(`Chieftain's Drum plays top discard before bonus draws, including shuffle: ${shuffle}`, async () => {
  const before = fixture(); before.turn.chosen_action = 'village'; before.turn.subphase = 'VILLAGE_ABILITIES'; before.legal_commands = [{type: 'FinishAbilities'}];
  const top = {instance_id: 'drum-top', card_id: 'TS-0001'}, first = {instance_id: 'drum-one', card_id: 'TS-0002'}, second = {instance_id: 'drum-two', card_id: 'TS-0300'};
  before.draw = shuffle ? [top, first] : [top, first, second]; before.discard = shuffle ? [second] : [];
  const final = structuredClone(before); final.version++; final.hand.push(first, second); final.draw = shuffle ? [top] : [];
  final.discard = shuffle ? [] : [top];
  final.card_motion = [deckMotion(1, [moveCards('draw', 'discard', [top])]),
    deckMotion(3, shuffle ? [moveCards('draw', 'hand', [first]), {kind: 'shuffle'}, moveCards('draw', 'hand', [second])] : [moveCards('draw', 'hand', [first, second])])];
  final.event_log = [{sequence: 3, kind: 'cards_drawn', player_id: 'alice', count: 2}];
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match');
  const flights = () => ui.animations.filter(animation => animation.element.className === 'card-flight');
  assert.equal(flights()[0].element.children[0].dataset.instanceId, top.instance_id);
  assert.equal(ui.get('match-deck-response-FinishAbilities').disabled, true);
  await ui.advance(10000);
  assert.equal(flights().length, 3);
  assert.equal(ui.get('match-deck-discard-count').textContent, shuffle ? '0' : '1');
  assert.deepEqual(handCards(ui).map(card => card.dataset.instanceId), ['CI-1', 'CI-2', first.instance_id, second.instance_id]);
  assert.equal(ui.get('match-deck-response-FinishAbilities').disabled, false);
  const count = ui.animations.length; await ui.click('refresh-match'); await ui.advance(1000); assert.equal(ui.animations.length, count); ui.cleanup();
});

test('exact effect movements play draw then discard of the same card even when net hand contents do not change', async () => {
  const before = fixture(), drawn = {instance_id: 'cycle', card_id: 'TS-0001'}; before.draw = [drawn];
  const final = structuredClone(before); final.version++; final.draw = []; final.discard = [drawn];
  final.card_motion = [deckMotion(1, [moveCards('draw', 'hand', [drawn])]), deckMotion(3, [moveCards('hand', 'discard', [drawn])])];
  final.event_log = [{sequence: 1, kind: 'cards_drawn', player_id: 'alice', count: 1}];
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match'); await ui.advance(3000);
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-flight').length, 2);
  assert.deepEqual(handCards(ui).map(card => card.dataset.instanceId), ['CI-1', 'CI-2']); ui.cleanup();
});

test('own discard recovery, topdeck, set-aside and return animate in order without changing game rules', async () => {
  const before = fixture(), item = {instance_id: 'recovered', card_id: 'TS-0001'}; before.discard = [item];
  const final = structuredClone(before); final.version++; final.discard = []; final.hand.push(item);
  final.card_motion = [deckMotion(1, [moveCards('discard', 'hand', [item]), moveCards('hand', 'draw', [item]),
    moveCards('draw', 'hand', [item]), moveCards('hand', 'aside', [item]), moveCards('aside', 'hand', [item])])];
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match'); await ui.advance(8000);
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-flight').length, 5);
  assert.equal(ui.get('match-deck-aside-tab').hidden, true); assert.ok(handCards(ui).some(card => card.dataset.instanceId === item.instance_id)); ui.cleanup();
});

test('interrupted own effect movements settle once and ignore a foreign private movement payload', async () => {
  const before = fixture(), item = {instance_id: 'recovered', card_id: 'TS-0001'}; before.discard = [item];
  const final = structuredClone(before); final.version++; final.discard = []; final.hand.push(item);
  final.card_motion = [deckMotion(1, [moveCards('discard', 'hand', [item])]),
    {...deckMotion(2, [moveCards('draw', 'hand', [{instance_id: 'foreign', card_id: 'TS-0001'}])]), player_id: 'bob'}];
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match');
  ui.window.fire('blur'); await settle(); await ui.advance(2000);
  assert.deepEqual(handCards(ui).map(card => card.dataset.instanceId), ['CI-1', 'CI-2', 'recovered']);
  assert.equal(ui.all.some(node => node.className === 'card-flight' && node.isConnected), false); ui.cleanup();
});

test('committed cleanup discards once, draws the remainder, shuffles and finishes refilling', async () => {
  const before = fixture(), top = {instance_id: 'draw-top', card_id: 'TS-0001'};
  before.draw = [top]; before.discard = [{instance_id: 'discard-old', card_id: 'TS-0002'}];
  const final = structuredClone(before); final.version++; final.draw = []; final.discard = [];
  final.hand = [top, ...before.discard, ...before.hand];
  final.event_log = [{sequence: 1, kind: 'turn_hand_discarded', player_id: 'alice', count: 2},
    {sequence: 2, kind: 'player_deck_shuffled', player_id: 'alice'}, {sequence: 3, kind: 'cards_drawn', player_id: 'alice', count: 4}];
  final.card_motion = [deckMotion(1, [moveCards('hand', 'discard', before.hand)]),
    deckMotion(3, [moveCards('draw', 'hand', [top]), {kind: 'shuffle'}, moveCards('draw', 'hand', [...before.discard, ...before.hand])])];
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match'); await ui.advance(10000);
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-flight').length, 6);
  assert.ok(ui.animations.some(animation => animation.element.className === 'shuffle-packet'));
  assert.deepEqual(handCards(ui).map(card => card.dataset.instanceId), final.hand.map(card => card.instance_id));
  assert.equal(ui.get('match-deck-discard-count').textContent, '0'); ui.cleanup();
});

for (const kind of ['effect_hall_relocated', 'thunderstone_acquired']) test(`public hall acquisition animates without a monster victory event: ${kind}`, async () => {
  const {before, final} = dungeonVisualViews();
  final.event_log[0] = {sequence: 1, kind, player_id: 'alice', card_id: 'TS-0476', hall_zone: 'hall:main', rank: 1,
    ...(kind === 'effect_hall_relocated' ? {destination: 'discard', defeat: false} : {})};
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match');
  const flight = ui.animations.find(animation => animation.element.className === 'card-flight');
  assert.equal(flight.element.children[0].dataset.instanceId, 'CI-3');
  assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  await ui.advance(6000);
  assert.equal(ui.get('match-deck-discard-count').textContent, '1');
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-3').children[1].children[0].dataset.instanceId, 'hall-new');
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-flight').length, 2); ui.cleanup();
});

for (const destruction of [false, true]) test(`a public card leaves its hall slot before destruction or return to deck: destruction ${destruction}`, async () => {
  const {before, final} = dungeonVisualViews(); final.discard = [];
  final.dungeons[0].deck_count = destruction ? 9 : 10;
  final.event_log[0] = {sequence: 1, kind: destruction ? 'card_destroyed' : 'thunderstone_returned_to_deck',
    card_id: 'TS-0476', hall_zone: 'hall:main', rank: 1};
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match');
  assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  await ui.advance(10000);
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-destruction').length, destruction ? 1 : 0);
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0].dataset.instanceId, 'hall-2');
  assert.equal(ui.get('match-deck-discard-count').textContent, '0'); ui.cleanup();
});

test('two hall swaps in one command play both intermediate reflows even with an unchanged final hall', async () => {
  const {before} = dungeonVisualViews(), final = structuredClone(before); final.version++;
  final.event_log = [1, 2].map(sequence => ({sequence, kind: 'hall_cards_swapped', hall_zone: 'hall:main', first_rank: 1, second_rank: 2}));
  const ui = await page({view: before, animationsEnabled: true});
  for (const rank of [1, 2, 3]) {
    const card = ui.get(`match-public-dungeon-cards-main-rank-${rank}`).children[1].children[0];
    card.getBoundingClientRect = () => ({left: Number(card.parentElement.parentElement.dataset.rank) * 120, top: 200, width: 100, height: 140});
  }
  ui.setView(final); await ui.click('refresh-match');
  const rank1 = () => ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0];
  assert.equal(rank1().dataset.instanceId, 'hall-2');
  await ui.advance(3000); assert.equal(rank1().dataset.instanceId, 'CI-3');
  assert.equal(ui.animations.some(animation => animation.element.className === 'card-destruction'), false); ui.cleanup();
});

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

async function page({view = fixture(), authenticated = true, userId = 1, autoSort = false, savePreference, search = `?id=${'m'.repeat(32)}`, post, getMatch, getExport, restoreFailureOnce = false, animationsEnabled = false} = {}) {
  const requests = [], navigations = [], sockets = [], downloads = [], revokedUrls = [];
  const cloneStats = {previewInputs: 0};
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
      history: {replaceState() {}}, Blob, URL: class extends URL {
        static createObjectURL(blob) {const url = `blob:match-test-${downloads.length}`; downloads.push({blob, url}); return url;}
        static revokeObjectURL(url) {revokedUrls.push(url);}
      }, URLSearchParams, structuredClone: value => {
        if (value?.schema_version === 'thunderstone.preview/1') cloneStats.previewInputs++;
        return structuredClone(value);
      }, queueMicrotask,
      setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, WebSocket: FakeSocket,
      crypto: {randomUUID: () => ++uuidCount === 1 ? 'command-uuid' : `command-uuid-${uuidCount}`}, confirm: () => true,
    }),
    fetchResponse: async (url, options = {}) => {
      requests.push({url, options, body: options.body ? JSON.parse(options.body) : null});
      assert.equal(options.headers?.get('Authorization'), authenticated ? 'Bearer token' : null);
      let result;
      if (url === '/api/v1/users/me') {
        if (restoreFailureOnce) {restoreFailureOnce = false; throw new TypeError('network unavailable');}
        if (options.method === 'PATCH') {
          if (savePreference) await savePreference(JSON.parse(options.body));
          autoSort = JSON.parse(options.body).auto_sort_hand;
        }
        result = {id: userId, username: '阿莉丝', email: 'a@test.invalid', auto_sort_hand: autoSort};
      }
      else if (options.method === 'POST') result = post ? await post(url, JSON.parse(options.body), current) : current;
      else if (url.endsWith('/export')) result = await getExport();
      else if (url === '/api/v1/matches/current') result = {match: current};
      else result = getMatch ? await getMatch() : current;
      return result?.httpError ? {ok: false, status: result.httpError, json: async () => ({error: result.error})}
        : {ok: true, status: 200, json: async () => result};
    }});
  await settle();
  return {...ui, requests, navigations, sockets, downloads, revokedUrls, cloneStats, setView(value) {current = value;},
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
  assert.equal(ui.navigations[0], `/login?next=${encodeURIComponent(`/match?id=${'m'.repeat(32)}`)}`); ui.cleanup();
});

test('active match renders public piles and own cards; details use actual card data', async () => {
  const ui = await page();
  assert.equal(ui.get('notice').textContent, '');
  assert.equal(ui.get('match-content').hidden, false); assert.equal(ui.get('active-table').hidden, false);
  assert.equal(handCards(ui).length, 2); assert.equal(ui.get('match-public-players').children[1].children.length, 2);
  assert.ok(ui.get('match-public-village-cards-pile-hero_supply:test')); assert.ok(ui.get('match-public-village-cards-pile-basic_supply:test'));
  assert.match(ui.get('match-title').textContent, /阿莉丝/);
  assert.match(ui.get('page-state').textContent, /\u7a7a\u683c/);
  assert.equal(ui.document.getElementById('disease-description'), null);
  assert.equal(ui.document.getElementById('match-information'), null);
  assert.equal(ui.get('history-panel').hidden, false); assert.equal(ui.get('history-undo').disabled, true); ui.cleanup();
});

test('history handle opens and closes without losing entries; collapsed content cannot take keyboard focus', async () => {
  const ui = await page(), handle = ui.get('history-toggle'), body = ui.get('history-body');
  assert.equal(handle.textContent, ''); assert.equal(handle.getAttribute('aria-expanded'), 'false');
  assert.equal(body.inert, true); assert.equal(ui.document.getElementById('event-log'), null);
  await ui.click('history-toggle'); assert.equal(body.inert, false);
  assert.equal(ui.get('history-panel').dataset.open, 'true'); assert.equal(handle.getAttribute('aria-expanded'), 'true');
  const entries = ui.get('history-entries').textContent;
  ui.get('history-download').focus();
  assert.equal(ui.get('history-panel').fire('keydown', {key: 'Escape'}).defaultPrevented, true);
  assert.equal(body.inert, true); assert.equal(body.getAttribute('aria-hidden'), 'true');
  assert.equal(ui.document.activeElement, handle); assert.equal(ui.get('history-entries').textContent, entries);
  await ui.click('history-toggle');
  ui.document.fire('pointerdown', {target: ui.get('history-undo')});
  assert.equal(body.inert, false, 'inside controls do not dismiss the drawer');
  ui.document.fire('pointerdown', {target: handle.children[0]});
  assert.equal(body.inert, false, 'the handle triangle must not close before the toggle click');
  await ui.click('history-toggle'); assert.equal(body.inert, true);
  await ui.click('history-toggle'); ui.get('refresh-match').focus();
  const outside = ui.document.fire('pointerdown', {target: ui.get('refresh-match')});
  assert.equal(body.inert, true); assert.equal(handle.getAttribute('aria-expanded'), 'false');
  assert.equal(outside.defaultPrevented, false); assert.equal(outside.propagationStopped, undefined);
  assert.equal(ui.document.activeElement, ui.get('refresh-match'), 'outside clicks keep their own focus');
  ui.cleanup();
});

test('download explicitly fetches a complete checkpoint and saves the server revision, without changing the live board', async () => {
  const data = {format: 'thunderstone-match', format_version: 1, match: {id: 'm'.repeat(32), version: 7},
    snapshot: {state: {rng_state: 'private-rng', zones: {hidden_draw: ['secret-card']}}}};
  let finish;
  const ui = await page({getExport: () => new Promise(resolve => {finish = resolve;})});
  assert.equal(ui.requests.some(row => row.url.endsWith('/export')), false);
  await ui.click('history-toggle'); await ui.click('history-download');
  assert.equal(ui.get('history-download').disabled, true);
  await ui.click('history-download'); assert.equal(ui.requests.filter(row => row.url.endsWith('/export')).length, 1);
  finish(data); await settle();
  assert.equal(ui.downloads.length, 1); assert.equal(ui.get('history-download').disabled, false);
  assert.deepEqual(JSON.parse(await ui.downloads[0].blob.text()), data);
  const link = ui.all.find(node => node.tagName === 'a' && node.download);
  assert.equal(link.download, `thunderstone-match-${data.match.id}-v7.json`); assert.equal(link.isConnected, false);
  assert.equal(ui.get('history-entries').textContent.includes('secret-card'), false);
  assert.equal(handCards(ui).length, 2); assert.equal(ui.requests.some(row => row.options.method === 'POST'), false);
  await ui.advance(1000); assert.deepEqual(ui.revokedUrls, [ui.downloads[0].url]); ui.cleanup();
});

test('failed checkpoint download creates no file and permits retry', async () => {
  let attempt = 0;
  const ui = await page({getExport: () => {
    if (++attempt === 1) throw new TypeError('offline');
    return {format: 'thunderstone-match', format_version: 1, match: {id: 'm'.repeat(32), version: 1}, snapshot: {}};
  }});
  await ui.click('history-download'); assert.equal(ui.downloads.length, 0);
  assert.equal(ui.get('history-download').disabled, false);
  await ui.click('history-download'); assert.equal(ui.downloads.length, 1);
  await ui.advance(1000); ui.cleanup();
});

for (const host of [false, true]) test(`history undo is shared, jumps are host-only and restored snapshots do not replay animations: host ${host}`, async () => {
  const view = fixture(); view.host_user_id = host ? 1 : 2; view.version = 2;
  view.history = {cursor: 2, epoch: 0, can_undo: true, can_jump: host, entries: [
    {step: 1, parent_step: null, user_id: 1, label: '开始对局', turn_number: 1, created_at: '2026-10-25T00:00:00Z'},
    {step: 2, parent_step: 1, user_id: 1, label: '选择休整', turn_number: 1, created_at: '2026-10-25T00:00:01Z'},
  ]};
  const restored = structuredClone(view); restored.version++; restored.history = {...restored.history, cursor: 1, epoch: 1, can_undo: false};
  restored.event_log = [{sequence: 1, kind: 'card_destroyed', player_id: 'alice', card_id: 'TS-0001'}];
  const ui = await page({view, animationsEnabled: true, post: async (url, body) => {
    assert.ok(url.endsWith('/history/restore')); assert.equal(body.expected_version, 2); assert.equal(body.target_step, undefined); return restored;
  }});
  assert.equal(ui.get('history-undo').disabled, false);
  await ui.click('history-toggle');
  assert.equal(ui.get('history-entries').querySelectorAll('button').length, host ? 1 : 0);
  await ui.click('history-undo'); await ui.advance(5000);
  assert.equal(ui.get('history-undo').disabled, true);
  assert.equal(ui.animations.filter(animation => ['card-flight', 'card-destruction'].includes(animation.element.className)).length, 0);
  ui.cleanup();
});

test('temporary reveals fly into the tab, then skipping animation reaches the committed response without submitting a choice', async () => {
  const before = fixture(), revealed = {instance_id: 'draw-temp', card_id: 'TS-0001'};
  before.draw = [revealed]; const final = structuredClone(before); final.version++;
  final.draw = []; final.revealed = [revealed]; final.card_motion = [deckMotion(1, [moveCards('draw', 'revealed', [revealed])])];
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match');
  const skip = ui.all.find(node => node.className.includes('match-animation-skip')); assert.equal(skip.hidden, false); skip.dispatch('click'); await settle();
  assert.equal(skip.hidden, true); assert.equal(ui.get('match-deck-revealed-tab').getAttribute('aria-selected'), 'true');
  assert.equal(ui.requests.filter(request => request.options.method === 'POST').length, 0); ui.cleanup();
});

test('cross-player borrow uses a public flight, then a private draw shows only the card back', async () => {
  const before = fixture(), final = structuredClone(before), borrowed = {instance_id: 'borrowed', card_id: 'TS-0300'};
  final.version++; final.hand.push(borrowed); final.table_motion = [
    {sequence: 1, kind: 'table_card_motion', steps: [{source: {kind: 'player', player_id: 'bob', zone: 'hand'}, destination: {kind: 'owned', zone: 'hand'}, card: borrowed}]},
    {sequence: 2, kind: 'table_card_motion', steps: [{source: {kind: 'player', player_id: 'bob', zone: 'draw'}, destination: {kind: 'player', player_id: 'bob', zone: 'hand'}, card: {instance_id: 'opaque'}}]},
  ];
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match'); await ui.advance(300);
  const flights = ui.animations.filter(animation => animation.element.className === 'card-flight');
  const hiddenFlight = flights.at(-1).element.children[0];
  assert.ok(hiddenFlight); assert.equal(hiddenFlight.children[0].children[0].children[0].children[0].src, '/cards/TS-BACK-001.jpg');
  await ui.advance(4000); assert.ok(handCards(ui).some(card => card.dataset.instanceId === 'borrowed'));
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-flight').length, 2); ui.cleanup();
});

test('destroying an authorized other-player reveal uses its exact temporary instance once', async () => {
  const before = fixture(), first = {instance_id: 'revealed-first', card_id: 'TS-0001'}, second = {...first, instance_id: 'revealed-second'};
  before.revealed = [first, second]; const final = structuredClone(before); final.version++; final.revealed = [second];
  final.event_log = [{sequence: 1, kind: 'card_destroyed', player_id: 'bob', card_id: first.card_id}];
  final.card_motion = [deckMotion(1, [{kind: 'destroy', cards: [first]}])];
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match'); await ui.advance(5000);
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-destruction').length, 1);
  const cards = ui.get('match-deck-revealed-track').children.filter(node => node.tagName === 'button' && !node.hidden);
  assert.deepEqual(cards.map(card => card.dataset.instanceId), [second.instance_id]);
  ui.cleanup();
});

test('jumping between history branches may reuse an instance ID for a different card without retaining cached fronts', async () => {
  const before = fixture(); before.history = {cursor: 4, epoch: 0, can_undo: true, can_jump: true, entries: []};
  const final = structuredClone(before); final.version++; final.history.epoch++;
  final.hand[0].card_id = 'TS-0300'; final.discard = [{instance_id: 'reused', card_id: 'TS-0301'}];
  before.discard = [{instance_id: 'reused', card_id: 'TS-0300'}];
  const ui = await page({view: before}); ui.get('match-deck-discard-pile').children.find(node => node.dataset.instanceId).fire('click'); await settle();
  ui.setView(final); await ui.click('refresh-match');
  assert.equal(handCards(ui).find(card => card.dataset.instanceId === 'CI-1').dataset.cardId, 'TS-0300');
  ui.get('match-deck-discard-pile').children.find(node => node.dataset.instanceId).fire('click'); await settle();
  const viewed = ui.get('match-deck-browse-reused'); assert.equal(viewed.dataset.cardId, 'TS-0301'); ui.cleanup();
});

test('a card attached then destroyed in the same operation keeps both animations and removes the mini stack', async () => {
  const before = fixture(), captured = before.hand[0], anchor = {instance_id: 'cage', card_id: 'TS-0301'};
  before.aside = [anchor]; const final = structuredClone(before); final.version++; final.hand = [before.hand[1]];
  final.table_motion = [{sequence: 1, kind: 'table_card_motion', steps: [{
    source: {kind: 'owned', zone: 'hand'}, destination: {kind: 'attachment', anchor_id: anchor.instance_id, attachment_kind: 'cage'}, card: captured,
  }]}];
  final.event_log = [{sequence: 2, kind: 'card_destroyed', player_id: 'alice', card_id: captured.card_id}];
  final.card_motion = [deckMotion(2, [{kind: 'destroy', cards: [captured]}])];
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match'); await ui.advance(8000);
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-flight').length, 1);
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-destruction').length, 1);
  assert.equal(ui.all.some(node => node.className === 'card-attachments' && !node.hidden && node.isConnected), false); ui.cleanup();
});

test('public exchange animates both cards and restores the previous public tab', async () => {
  const before = fixture(), final = structuredClone(before); final.version++;
  const outgoing = before.dungeons[0].hall[0], incoming = before.hand[0];
  final.hand = [before.hand[1], {instance_id: outgoing.instance_id, card_id: outgoing.card_id}];
  final.dungeons[0].hall = [{...incoming, rank: 1}];
  final.table_motion = [{sequence: 1, kind: 'table_card_motion', steps: [
    {source: {kind: 'hall', dungeon_id: 'main', rank: 1}, destination: {kind: 'owned', zone: 'hand'}, card: outgoing},
    {source: {kind: 'owned', zone: 'hand'}, destination: {kind: 'hall', dungeon_id: 'main', rank: 1}, card: incoming},
  ]}];
  const ui = await page({view: before, animationsEnabled: true}); await ui.click('match-public-village-tab');
  ui.setView(final); await ui.click('refresh-match');
  assert.equal(ui.get('match-public-dungeon-tab').getAttribute('aria-selected'), 'true');
  await ui.advance(3000); assert.equal(ui.get('match-public-village-tab').getAttribute('aria-selected'), 'true');
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-flight').length, 2);
  assert.ok(handCards(ui).some(card => card.dataset.instanceId === outgoing.instance_id)); ui.cleanup();
});

test('gold always appears, follows authoritative spending on the own turn and resets to zero between turns while XP remains visible', async () => {
  const view = fixture(), ui = await page({view});
  assert.equal(ui.get('match-deck-gold-resource').hidden, false); assert.equal(ui.get('match-deck-xp-value').textContent, '2');
  const village = structuredClone(view); village.version++; village.turn.chosen_action = 'village'; village.turn.subphase = 'VILLAGE_ABILITIES';
  village.legal_commands = [{type: 'FinishAbilities'}]; village.viewer_resources.temporary_gold = 0;
  ui.setView(village); await ui.click('refresh-match');
  assert.equal(ui.get('match-deck-gold-resource').hidden, false); assert.equal(ui.get('match-deck-gold-value').textContent, '0');
  const produced = structuredClone(village); produced.version++; produced.turn.subphase = 'VILLAGE_BUY'; produced.viewer_resources.temporary_gold = 6;
  ui.setView(produced); await ui.click('refresh-match'); assert.equal(ui.get('match-deck-gold-value').textContent, '6');
  const spent = structuredClone(produced); spent.version++; spent.turn.subphase = 'VILLAGE_UPGRADE';
  spent.viewer_resources.temporary_gold = 1; spent.viewer_resources.xp = 0;
  ui.setView(spent); await ui.click('refresh-match');
  assert.equal(ui.get('match-deck-gold-value').textContent, '1'); assert.equal(ui.get('match-deck-xp-value').textContent, '0');
  const other = structuredClone(spent); other.version++; other.turn.active_player_id = 'bob'; other.actor_player_id = 'bob'; other.legal_commands = [];
  other.viewer_resources.xp = 4; other.players[1].xp = 99;
  ui.setView(other); await ui.click('refresh-match');
  assert.equal(ui.get('match-deck-gold-resource').hidden, false); assert.equal(ui.get('match-deck-gold-value').textContent, '0');
  assert.equal(ui.get('match-deck-xp-value').textContent, '4'); ui.cleanup();
});

test('gold forecasts follow authoritative state before production, then disappear for production and other actions or turns', async () => {
  const view = fixture(); view.viewer_resources.temporary_gold = 0; view.viewer_resources.gold_income_preview = 10;
  const ui = await page({view}); assert.equal(ui.get('match-deck-gold-resource').textContent, '0(+10)');
  const abilities = structuredClone(view); abilities.version++; abilities.turn.chosen_action = 'village';
  abilities.turn.subphase = 'VILLAGE_ABILITIES'; abilities.legal_commands = [{type: 'FinishAbilities'}];
  abilities.viewer_resources.temporary_gold = 2; abilities.viewer_resources.gold_income_preview = 7;
  ui.setView(abilities); await ui.click('refresh-match'); assert.equal(ui.get('match-deck-gold-resource').textContent, '2(+7)');
  const waiting = structuredClone(abilities); waiting.version++; waiting.actor_player_id = 'bob'; waiting.legal_commands = [];
  waiting.pending_choice = {kind: 'effect_value', player_id: 'bob', can_resolve: false};
  ui.setView(waiting); await ui.click('refresh-match'); assert.equal(ui.get('match-deck-gold-resource').textContent, '2(+7)');
  let version = waiting.version;
  for (const [phase, action] of [['VILLAGE_BUY', 'village'], ['VILLAGE_UPGRADE', 'village'], ['DUNGEON_PREPARE', 'dungeon'], ['REST', 'rest'], ['ACTION_END', 'village']]) {
    const next = structuredClone(abilities); next.version = ++version; next.turn.subphase = phase; next.turn.chosen_action = action;
    // Even an outdated forecast cannot survive a phase change at the presentation boundary.
    next.viewer_resources.temporary_gold = 9; ui.setView(next); await ui.click('refresh-match');
    assert.equal(ui.get('match-deck-gold-resource').textContent, '9'); assert.equal(ui.get('match-deck-gold-income-preview').hidden, true);
  }
  const other = structuredClone(view); other.version = ++version; other.turn.active_player_id = 'bob'; other.actor_player_id = 'bob'; other.legal_commands = [];
  ui.setView(other); await ui.click('refresh-match'); assert.equal(ui.get('match-deck-gold-resource').textContent, '0'); ui.cleanup();
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

test('effect selection has no candidate rail or extra layout region', async () => {
  const view = commandView({type: 'ResolveChoice', instance_ids: ['foreign'], min_count: 0, max_count: 1});
  view.command_instances.foreign = {instance_id: 'foreign', card_id: 'TS-0300', owner_player_id: 'bob'};
  const ui = await page({view}), board = ui.get('active-table');
  const before = [...board.children];
  assert.equal(ui.all.some(node => node.id === 'match-staging-area'), false);
  assert.equal(ui.all.some(node => node.id === 'match-card-picker'), false);
  assert.ok(ui.get('match-deck-response-pick:card:0'));
  const next = structuredClone(view); next.version++; next.pending_choice = null; next.legal_commands = [];
  ui.setView(next); await ui.click('refresh-match');
  assert.deepEqual(board.children, before); ui.cleanup();
});

test('a hall response highlights its original monster and inactive dungeon tab without switching the desktop', async () => {
  const before = fixture(), ui = await page({view: before}); await ui.click('match-public-village-tab');
  const next = commandView({type: 'ResolveChoice', instance_ids: ['CI-3'], min_count: 0, max_count: 1}); next.version++;
  ui.setView(next); await ui.click('refresh-match');
  assert.equal(ui.get('match-public-village-tab').getAttribute('aria-selected'), 'true');
  assert.equal(ui.get('match-public-dungeon-tab').dataset.attention, 'true');
  await ui.click('match-public-dungeon-tab');
  assert.equal(ui.get('match-public-dungeon-tab').dataset.attention, 'false');
  const monster = ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0];
  assert.equal(monster.dataset.glowing, 'true'); monster.fire('click');
  await settle(); assert.deepEqual(posts(ui)[0].body.command.instance_ids, ['CI-3']); ui.cleanup();
});

test('discard effect targets are selected in the existing pile browser without producing candidate card copies', async () => {
  const view = commandView({type: 'ResolveChoice', instance_ids: ['discard-target'], min_count: 0, max_count: 1});
  view.discard = [{instance_id: 'discard-target', card_id: 'TS-0300'}];
  view.command_instances['discard-target'] = {...view.discard[0], owner_player_id: 'alice'};
  const ui = await page({view});
  const pile = ui.get('match-deck-discard-pile').children.find(node => node.dataset.instanceId === 'discard-target');
  assert.equal(pile.dataset.glowing, 'true'); pile.fire('click');
  const target = ui.get('match-deck-browse-discard-target'); assert.equal(target.dataset.glowing, 'true'); target.fire('click');
  await settle();
  assert.deepEqual(posts(ui)[0].body.command.instance_ids, ['discard-target']); ui.cleanup();
});

test('aside effect targets highlight their tab and remain selectable in that original area', async () => {
  const view = commandView({type: 'ResolveChoice', instance_ids: ['aside-target'], min_count: 0, max_count: 1});
  view.aside = [{instance_id: 'aside-target', card_id: 'TS-0300'}];
  view.command_instances['aside-target'] = {...view.aside[0], owner_player_id: 'alice'};
  const ui = await page({view}); assert.equal(ui.get('match-deck-aside-tab').dataset.attention, 'true');
  await ui.click('match-deck-aside-tab');
  const target = ui.get('match-deck-aside-track').children.find(node => node.dataset.instanceId === 'aside-target');
  assert.equal(target.dataset.glowing, 'true'); target.fire('click');
  await settle(); assert.deepEqual(posts(ui)[0].body.command.instance_ids, ['aside-target']); ui.cleanup();
});

test('an authorized opponent discard target is picked in that player browser rather than a separate candidate area', async () => {
  const view = commandView({type: 'ResolveChoice', instance_ids: ['bob-target'], min_count: 0, max_count: 1});
  view.players[1].cards = {hand: [], draw: [], discard: [{instance_id: 'bob-target', card_id: 'TS-0300'}]};
  view.command_instances['bob-target'] = {instance_id: 'bob-target', card_id: 'TS-0300', owner_player_id: 'bob'};
  const ui = await page({view});
  assert.equal(pickOptions(ui).length, 0);
  descendants(ui.get('match-public-players')).find(node => node.dataset.playerId === 'bob').children[0].fire('click');
  await ui.click('match-public-player-browser-discard-tab');
  const target = ui.get('match-public-player-browser-grid').children.find(node => node.className === 'player-browser-entry').children[0];
  assert.equal(target.dataset.glowing, 'true'); target.fire('click');
  await settle();
  assert.deepEqual(posts(ui)[0].body.command.instance_ids, ['bob-target']); ui.cleanup();
});

test('match restores and saves account hand-sort preference without issuing a game command', async () => {
  const ui = await page({autoSort: true});
  const toggle = ui.get('match-deck-auto-sort-hand'); assert.equal(toggle.checked, true);
  toggle.checked = false; toggle.fire('change'); await settle();
  const saved = ui.requests.filter(row => row.url === '/api/v1/users/me' && row.options.method === 'PATCH');
  assert.deepEqual(saved.map(row => row.body), [{auto_sort_hand: false}]);
  assert.equal(ui.requests.some(row => row.url.endsWith('/commands')), false); ui.cleanup();
  const failed = await page({savePreference: async () => {throw new Error('offline');}});
  const check = failed.get('match-deck-auto-sort-hand'); check.checked = true; check.fire('change'); await settle();
  assert.equal(check.checked, false); assert.match(failed.get('match-deck-player-response').textContent, /偏好保存失败/); failed.cleanup();
});

test('match hand snapshots display the source and amount of a card status', async () => {
  const view = fixture(); view.hand[0].statuses = [{kind: 'buff', source_name: '应急干粮', source_card_id: 'TS-0004', description: '力量 +2'}];
  const ui = await page({view}), icon = descendants(ui.get('match-deck-first-card')).find(node => node.className === 'card-status-icon');
  assert.ok(icon); icon.fire('pointerenter', {clientX: 300, clientY: 500});
  assert.ok(ui.all.some(node => node.className === 'card-status-tooltip game-cursor' && node.isConnected && /应急干粮：力量 \+2/.test(node.textContent)));
  const next = structuredClone(view); next.version++; next.hand[0].statuses = []; ui.setView(next); await ui.click('refresh-match');
  assert.equal(ui.all.some(node => node.className === 'card-status-tooltip game-cursor' && node.isConnected), false); ui.cleanup();
});
const commandButtons = (ui, type) => type === 'ChooseAction'
  ? descendants(ui.get('match-deck-player-response')).filter(node => node.id?.startsWith('match-deck-response-action:'))
  : descendants(ui.get('match-card-actions')).filter(node => node.dataset.command === type);
const pickOptions = ui => responseButtons(ui).filter(node => node.id.startsWith('match-deck-response-pick:card:'));
const handCard = (ui, id) => handCards(ui).find(card => card.dataset.instanceId === id);
function cardAction(ui, id, label) {
  if (['出阵', '撤回出阵', '使用', '取消使用', '装备', '卸下装备'].includes(label)) {handCard(ui, id).fire('click'); return;}
  const mode = ui.all.find(node => node.id === 'match-deck-response-battle:effects' && node.isConnected);
  if (mode && mode.attributes['aria-pressed'] !== 'true') mode.fire('click');
  handCard(ui, id).fire('click');
  const button = descendants(ui.get('match-card-actions')).find(node => node.tagName === 'button' && node.textContent === label);
  assert.ok(button, label); button.fire('click');
}
const combatText = ui => ui.get('match-deck-combat-values').children.map(node => node.attributes['aria-label']).join(' ');
const playerRow = (ui, id) => descendants(ui.get('match-public-players')).find(node => node.dataset.playerId === id);
const diseaseBirths = ui => ui.animations.filter(animation => animation.keyframes[0]?.filter === 'blur(14px)');
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
  ['number', {type: 'ResolveValueChoice', options: [0, 2]}, {type: 'ResolveValueChoice', value: 0}],
  ['boolean', {type: 'ResolveValueChoice', options: [false, true]}, {type: 'ResolveValueChoice', value: false}],
  ['player', {type: 'ResolveValueChoice', options: ['bob']}, {type: 'ResolveValueChoice', value: 'bob'}],
  ['effect purchase', {type: 'ResolveEffectPurchase', options: [{card_id: 'TS-0001', price: 2}], may_skip: true}, {type: 'ResolveEffectPurchase', card_id: 'TS-0001'}],
  ['effect upgrade', {type: 'ResolveEffectUpgrade', options: [{source_instance_id: 'CI-1', target_card_id: 'TS-0300', xp_cost: 2}]}, {type: 'ResolveEffectUpgrade', source_instance_id: 'CI-1', target_card_id: 'TS-0300'}],
  ['reuse', {type: 'ResolveReusedAbility', source_instance_id: 'CI-1', ability_ids: ['TS-0001-A01']}, {type: 'ResolveReusedAbility', ability_id: 'TS-0001-A01'}],
  ['response source', {type: 'ResolveResponse', stage: 'source', options: [{source_instance_id: 'CI-1', ability_id: 'TS-0001-A01', action: 'ignore_trap'}], may_decline: true}, {type: 'ResolveResponse', source_instance_id: 'CI-1', recipient_id: null}],
  ['response recipient', {type: 'ResolveResponse', stage: 'recipient', options: ['bob'], may_decline: true}, {type: 'ResolveResponse', source_instance_id: null, recipient_id: 'bob'}],
  ['disease source', {type: 'ResolveDiseaseReplacement', stage: 'source', options: [{source_instance_id: 'CI-1', ability_id: 'TS-0001-A01', action: 'destroy'}]}, {type: 'ResolveDiseaseReplacement', source_instance_id: 'CI-1', recipient_id: null}],
  ['disease recipient', {type: 'ResolveDiseaseReplacement', stage: 'recipient', options: ['bob']}, {type: 'ResolveDiseaseReplacement', source_instance_id: null, recipient_id: 'bob'}],
]) test(`match command UI: ${title} uses versioned endpoint and only public command fields`, async () => {
  const ui = await page({view: commandView(legal), post: async () => ({...fixture(), version: 2})});
  if (title === 'effect purchase') await ui.click('match-public-village-tab');
  const instance = ['effect upgrade', 'response source', 'disease source', 'reuse'].includes(title);
  const button = title === 'disease recipient' ? descendants(ui.get('match-public-players')).find(row => row.dataset.playerId === 'bob')?.children[0]
    : instance ? handCard(ui, 'CI-1') : title === 'effect purchase' ? supplyCard(ui, 'basic_supply:test')
    : title === 'reuse' ? pickOptions(ui)[0] : responseButtons(ui)[0];
  assert.ok(button, legal.type);
  if (title === 'boolean') assert.equal(button.textContent, '否');
  if (title !== 'reuse') {button.dispatch('click'); button.dispatch('click');} await settle();
  const requests = ui.requests.filter(r => r.url.endsWith('/commands')); assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, {expected_version: 1, command_id: 'command-uuid', command: expected});
  assert.equal(commandButtons(ui, 'ChooseAction')[0].disabled, false);
  assert.equal(ui.get('match-content').inert, false); ui.cleanup();
});

test('effect multi-selection includes all selected instances and supports an optional zero selection', async () => {
  const ui = await page({view: commandView({type: 'ResolveChoice', instance_ids: ['CI-1', 'CI-2'], min_count: 1, max_count: 2})});
  assert.deepEqual(glowing(ui), ['CI-1', 'CI-2']);
  assert.equal(ui.get('match-deck-response-pick:confirm').disabled, true);
  for (const id of ['CI-1', 'CI-2']) handCard(ui, id).fire('click');
  await ui.click('match-deck-response-pick:confirm');
  assert.deepEqual(ui.requests.find(r => r.url.endsWith('/commands')).body.command, {type: 'ResolveChoice', instance_ids: ['CI-1', 'CI-2']}); ui.cleanup();
  const optional = await page({view: commandView({type: 'ResolveChoice', instance_ids: ['CI-1'], min_count: 0, max_count: 1})});
  assert.equal(posts(optional).length, 0);
  await optional.click('match-deck-response-pick:skip');
  assert.deepEqual(optional.requests.find(r => r.url.endsWith('/commands')).body.command.instance_ids, []); optional.cleanup();
});

test('one-card choices submit on click, block duplicate input and reuse the request ID on manual retry', async () => {
  const view = commandView({type: 'ResolveChoice', instance_ids: ['CI-1', 'CI-2'], min_count: 1, max_count: 1});
  const ui = await page({view, post: () => {throw new TypeError('offline');}});
  assert.equal(responseButtons(ui).some(button => button.id.endsWith('pick:confirm')), false);
  handCard(ui, 'CI-1').fire('click'); handCard(ui, 'CI-2').fire('click');
  await settle(); assert.equal(posts(ui).length, 1);
  assert.deepEqual(posts(ui)[0].body.command, {type: 'ResolveChoice', instance_ids: ['CI-1']});
  handCard(ui, 'CI-1').fire('click'); await settle();
  assert.equal(posts(ui).length, 2); assert.equal(posts(ui)[0].body.command_id, posts(ui)[1].body.command_id);
  assert.equal(ui.get('match-content').inert, false); ui.cleanup();
});

test('a forced unique target submits automatically once; failed requests wait for manual retry, even after refresh', async () => {
  const view = commandView({type: 'ResolveChoice', instance_ids: ['CI-1'], min_count: 1, max_count: 1});
  const ui = await page({view, post: () => {throw new TypeError('offline');}});
  assert.equal(posts(ui).length, 1); assert.deepEqual(posts(ui)[0].body.command, {type: 'ResolveChoice', instance_ids: ['CI-1']});
  await ui.click('refresh-match'); await settle(); assert.equal(posts(ui).length, 1);
  handCard(ui, 'CI-1').fire('click'); await settle(); assert.equal(posts(ui).length, 2);
  assert.equal(posts(ui)[0].body.command_id, posts(ui)[1].body.command_id); ui.cleanup();
});

for (const blocked of ['other-player', 'unavailable']) test(`a unique effect target does not submit when ${blocked}`, async () => {
  const view = commandView({type: 'ResolveChoice', instance_ids: ['CI-1'], min_count: 1, max_count: 1});
  if (blocked === 'other-player') {view.actor_player_id = 'bob'; view.pending_choice.can_resolve = false;}
  else view.unavailable_reason = '规则版本已变化';
  const ui = await page({view}); await settle(); assert.equal(posts(ui).length, 0); ui.cleanup();
});

test('choices use hand and hall originals, with response text for a revealed card that has no permanent position', async () => {
  const view = commandView({type: 'ResolveChoice', instance_ids: ['CI-1', 'CI-3', 'foreign'], min_count: 3, max_count: 3});
  view.command_instances.foreign = {instance_id: 'foreign', card_id: 'TS-0300', owner_player_id: 'bob'};
  const ui = await page({view});
  assert.equal(pickOptions(ui).length, 1);
  assert.match(pickOptions(ui)[0].textContent, /鲍勃/);
  const hall = ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0];
  assert.equal(hall.dataset.glowing, 'true'); hall.fire('click');
  handCard(ui, 'CI-2').fire('click'); assert.equal(handCard(ui, 'CI-2').dataset.selected, 'false');
  handCard(ui, 'CI-1').fire('click'); pickOptions(ui)[0].fire('click');
  await ui.click('match-deck-response-pick:confirm');
  assert.deepEqual(posts(ui)[0].body.command.instance_ids, ['CI-3', 'CI-1', 'foreign']);
  assert.equal(ui.get('match-card-actions').hidden, true); ui.cleanup();
});

test('a same-version permission change clears private candidates and invalidates old card and confirm handlers', async () => {
  const view = commandView({type: 'ResolveChoice', instance_ids: ['foreign', 'CI-1'], min_count: 1, max_count: 2});
  view.command_instances.foreign = {instance_id: 'foreign', card_id: 'TS-0300', owner_player_id: 'bob'};
  const ui = await page({view}), old = pickOptions(ui)[0]; old.fire('click');
  const confirm = ui.get('match-deck-response-pick:confirm');
  const other = structuredClone(view); other.actor_player_id = 'bob'; other.legal_commands = []; other.command_instances = {};
  ui.setView(other); await ui.click('refresh-match');
  assert.equal(pickOptions(ui).length, 0); assert.deepEqual(glowing(ui), []);
  old.fire('click'); confirm.fire('click'); assert.equal(posts(ui).length, 0); ui.cleanup();
});

test('effect purchasing targets the highlighted current supply top without a hero browser or price badge', async () => {
  const view = commandView({type: 'ResolveEffectPurchase', options: [{card_id: 'TS-0300', price: 0}], may_skip: true});
  const ui = await page({view, post: () => ({...fixture(), version: 2})});
  await ui.click('match-public-village-tab');
  const top = supplyCard(ui, 'hero_supply:test'); assert.equal(top.dataset.glowing, 'true');
  supplyCard(ui, 'village_supply:test').fire('click'); assert.equal(posts(ui).length, 0);
  top.fire('click'); await settle();
  assert.deepEqual(posts(ui)[0].body.command, {type: 'ResolveEffectPurchase', card_id: 'TS-0300'});
  assert.equal(ui.get('match-public-village-cards-browser').hidden, true); ui.cleanup();
});

test('effect upgrade selects the source in hand and the target in its original hero supply', async () => {
  const view = commandView({type: 'ResolveEffectUpgrade', options: ['TS-0300', 'TS-0301'].map(target_card_id => ({source_instance_id: 'CI-1', target_card_id})), may_skip: true});
  const ui = await page({view, post: () => ({...fixture(), version: 2})});
  assert.deepEqual(glowing(ui), ['CI-1']); handCard(ui, 'CI-1').fire('click');
  assert.equal(ui.get('match-public-village-tab').dataset.attention, 'true'); assert.equal(ui.get('match-content').inert, false);
  await ui.click('match-deck-response-pick:cancel'); assert.deepEqual(glowing(ui), ['CI-1']);
  handCard(ui, 'CI-1').fire('click'); await ui.click('match-public-village-tab');
  supplyCard(ui, 'hero_supply:test').fire('click'); await settle();
  ui.all.find(node => node.tagName === 'button' && node.dataset.cardId === 'TS-0301' && node.id.includes('browse-')).fire('click'); await settle();
  assert.deepEqual(posts(ui)[0].body.command, {type: 'ResolveEffectUpgrade', source_instance_id: 'CI-1', target_card_id: 'TS-0301'}); ui.cleanup();
});

test('two ordered effects of one card remain individually selectable and do not confuse instance identity', async () => {
  const view = commandView({type: 'ResolveEffectOrder', effects: [
    {effect_id: 'e1', source_instance_id: 'CI-1', ability_id: 'TS-0001-A01'},
    {effect_id: 'e2', source_instance_id: 'CI-1', ability_id: 'TS-0002-A01'}]});
  const ui = await page({view}); assert.equal(pickOptions(ui).length, 0);
  handCard(ui, 'CI-1').fire('click'); assert.equal(ui.get('match-deck-response-pick:confirm').disabled, true);
  pickOptions(ui)[1].fire('click');
  pickOptions(ui)[0].fire('click');
  await ui.click('match-deck-response-pick:confirm');
  assert.deepEqual(posts(ui)[0].body.command.effect_ids, ['e2', 'e1']); ui.cleanup();
});

for (const kind of ['ResolveCardOrder', 'ResolveEffectOrder']) test(`${kind} sends the visible edited order`, async () => {
  const legal = kind === 'ResolveCardOrder' ? {type: kind, instance_ids: ['CI-1', 'CI-2']} : {type: kind, effects: [
    {effect_id: 'e1', ability_id: 'TS-0001-A01', source_instance_id: 'CI-1'}, {effect_id: 'e2', ability_id: 'TS-0002-A01', source_instance_id: 'CI-2'}]};
  const ui = await page({view: commandView(legal)});
  if (kind === 'ResolveCardOrder') {handCard(ui, 'CI-2').fire('click'); handCard(ui, 'CI-1').fire('click');}
  else {handCard(ui, 'CI-2').fire('click'); handCard(ui, 'CI-1').fire('click');}
  await ui.click('match-deck-response-pick:confirm');
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
  view.turn.chosen_action = 'dungeon'; view.turn.subphase = 'DUNGEON_PREPARE';
  view.hand = f.hand.map(instance_id => ({instance_id, card_id: f.state.instances[instance_id].card_id}));
  view.dungeons = [{id: 'main', deck_count: 0, hall: [{rank: 1, instance_id: f.hall[0], card_id: 'TS-0476'}]}];
  for (const id of ['TS-0001', 'TS-0002', 'TS-0272', 'TS-0476']) view.cards[id] = {...view.cards['TS-0001'], card_id: id, name: f.cards[id].name, image_url: `/cards/${id}.png`};
  view.legal_commands = [{type: 'SubmitBattleTeam', target_instance_ids: f.hall}, {type: 'EquipWeapon', options: [{hero_instance_id: f.hand[0], weapon_instance_id: f.hand[1]}]}];
  return {view, f};
}

test('battle selection calculates one shared preview per draft and reuses it for unchanged controls', async t => {
  const {view, f} = battleView(), ui = await page({view});
  const before = ui.cloneStats.previewInputs, start = performance.now();
  handCard(ui, f.hand[0]).fire('click');
  const copies = ui.cloneStats.previewInputs - before;
  t.diagnostic(`Hero toggle: ${copies} preview-context copies, ${(performance.now() - start).toFixed(2)} ms in the nonvisual fixture`);
  assert.equal(handCard(ui, f.hand[0]).dataset.selected, 'true');
  // Draft validation and one shared preview each create two isolated contexts.
  assert.ok(copies <= 4, `one selection cloned its full preview context ${copies} times`);
  const after = ui.cloneStats.previewInputs;
  await ui.click('match-deck-response-battle:effects');
  await ui.click('match-deck-response-battle:effects');
  assert.equal(ui.cloneStats.previewInputs, after, 'display-only controls must reuse the unchanged calculation');
  assert.equal(posts(ui).length, 0); ui.cleanup();
});

test('battle participation changes preserve every hand DOM node in place', async () => {
  const {view, f} = battleView(), ui = await page({view}), cards = handCards(ui);
  let removals = 0;
  for (const card of cards) {
    const remove = card.remove.bind(card); card.remove = () => {removals++; remove();};
  }
  handCard(ui, f.hand[0]).fire('click');
  assert.equal(removals, 0, 'selecting a hero must not detach the hand and disturb the next pointer gesture');
  assert.deepEqual(handCards(ui), cards); assert.equal(handCard(ui, f.hand[0]).dataset.selected, 'true'); ui.cleanup();
});

for (const autoSort of [false, true]) test(`rapid hero clicks with small pointer drift all select immediately: auto-sort ${autoSort}`, async () => {
  const f = engineFixture(Array(6).fill('TS-0001'), ['TS-0476']), {view} = battleView();
  view.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  view.hand = f.hand.map(instance_id => ({instance_id, card_id: 'TS-0001'}));
  view.legal_commands = [{type: 'SubmitBattleTeam'}];
  const ui = await page({view, autoSort});
  for (const [index, id] of f.hand.entries()) {
    const card = handCard(ui, id), point = ui.down(card.id), drift = index === 0 ? 0 : autoSort ? 6 : 3;
    ui.pointer('pointermove', point.clientX + drift); ui.pointer('pointerup', point.clientX + drift); card.fire('click');
    assert.equal(card.dataset.selected, 'true', `click ${index + 1} must not be swallowed as a hand reorder`);
    assert.equal(ui.get('match-deck-response-SubmitBattleTeam').disabled, false);
  }
  assert.equal(posts(ui).length, 0, 'ordinary hero participation is local');
  assert.match(combatText(ui), /攻击 6/); ui.cleanup();
});

test('Veris participation adds and removes continuous weapon status without a game command or stale server buff', async () => {
  const f = engineFixture(['TS-0411', 'TS-0001', 'TS-0002'], ['TS-0476']);
  const [source, hero, weapon] = f.hand, view = fixture();
  view.turn.chosen_action = 'dungeon'; view.turn.subphase = 'DUNGEON_PREPARE';
  view.hand = f.hand.map(id => ({instance_id: id, card_id: f.state.instances[id].card_id}));
  view.hand[2].statuses = [{kind: 'buff', source_name: '维里斯侍从', source_card_id: 'TS-0411', description: '光照 +1', continuous: true}];
  for (const id of ['TS-0411', 'TS-0001', 'TS-0002']) view.cards[id] = {...view.cards['TS-0001'], card_id: id, name: f.cards[id].name};
  view.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  view.legal_commands = [{type: 'SubmitBattleTeam'}];
  const ui = await page({view}), markers = () => descendants(handCard(ui, weapon)).find(node => node.className === 'card-status-markers');
  handCard(ui, weapon).fire('click'); handCard(ui, hero).fire('click'); handCard(ui, hero).fire('click');
  assert.equal(handCard(ui, weapon).dataset.equippedTo, hero); assert.equal(markers().hidden, true);
  handCard(ui, source).fire('click');
  assert.equal(markers().hidden, false); assert.match(markers().children[0].getAttribute('aria-label'), /维里斯侍从：光照 \+1/);
  assert.match(combatText(ui), /光照 1/);
  handCard(ui, weapon).fire('pointerenter'); ui.key(' ');
  assert.ok(ui.all.some(node => node.className === 'inspect-status-panel' && !node.hidden && /维里斯侍从光照 \+1/.test(node.textContent))); ui.release();
  handCard(ui, source).fire('click'); assert.equal(markers().hidden, true); assert.match(combatText(ui), /光照 0/);
  handCard(ui, source).fire('click'); assert.equal(markers().hidden, false);
  handCard(ui, weapon).fire('click'); assert.equal(markers().hidden, true); assert.equal(handCard(ui, weapon).dataset.equippedTo, undefined);
  assert.equal(posts(ui).length, 0, 'local participation/status preview must not send requests');
  assert.equal(view.hand[2].statuses.length, 1, 'local toggles never mutate the server snapshot'); ui.cleanup();
});

function declarationView({attack = 0, pending = false, diseaseOnly = false} = {}) {
  const {view, f} = battleView();
  f.add('TS-0477', 'hall:main');
  f.state.subphase = view.turn.subphase = 'DUNGEON_DECLARE';
  f.state.battle_context.battle_team = {hero_instance_ids: [f.hand[0]], support_instance_ids: []};
  f.state.battle_context.modifiers = {attack};
  f.rules = {...f.rules, abilities: pending || diseaseOnly ? [{id: 'pending-test', source_card_id: 'TS-0476', source_zone: 'battle_target',
    kind: 'triggered', event: 'BATTLE_BEFORE_OUTCOME', body: {op: diseaseOnly ? 'gain_disease' : 'draw', count: 1}, actions: [], conditions: [], usage: 'once_per_event'}] : []};
  view.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  const hall = f.state.zones['hall:main'];
  view.dungeons[0].hall = hall.map((id, i) => ({instance_id: id, rank: i + 1, card_id: f.state.instances[id].card_id}));
  view.cards['TS-0477'] = {...view.cards['TS-0476'], card_id: 'TS-0477', name: '另一只怪物'};
  view.legal_commands = [{type: 'DeclareBattleTarget', instance_ids: [...hall]}, {type: 'ReviseBattleTeam'}];
  return {view, f, hall};
}

for (const [title, options, outcome] of [['success', {attack: 100}, 'win'], ['failure', {}, 'loss'], ['pending', {attack: 100, pending: true}, 'unknown'],
  ['disease-only success', {attack: 100, diseaseOnly: true}, 'win'], ['disease-only failure', {diseaseOnly: true}, 'loss']])
test(`declaration preview shows ${title} separately, with adjusted stats and no premature command`, async () => {
  const {view, hall} = declarationView(options), ui = await page({view});
  assert.equal(ui.get('match-deck-response-battle:confirm').disabled, true);
  const target = ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0];
  target.fire('click'); await settle();
  assert.equal(posts(ui).length, 0); assert.equal(target.dataset.selected, 'true');
  assert.equal(ui.get('match-deck-response-battle:confirm').disabled, false);
  const content = descendants(ui.get('match-deck-player-response'));
  assert.equal(content.find(node => node.className === 'battle-preview-outcome').dataset.outcome, outcome);
  assert.equal(content.filter(node => node.className === 'combat-value-adjusted').length, 3);
  assert.equal(ui.get('match-deck-player-response').textContent.includes('有效果待执行'), outcome === 'unknown');
  ui.get('match-public-dungeon-cards-main-rank-2').children[1].children[0].fire('click');
  assert.equal(target.dataset.selected, 'false');
  assert.match(ui.get('match-deck-player-response').textContent, /攻击阶层 2/);
  assert.equal(posts(ui).length, 0);
  await ui.click('match-deck-response-battle:confirm');
  assert.deepEqual(posts(ui)[0].body.command, {type: 'DeclareBattleTarget', target_instance_id: hall[1]}); ui.cleanup();
});

test('an invalid declaration reports in the response area, retains its target for retry and clears on a new choice', async () => {
  const {view} = declarationView(), ui = await page({view, post: () => ({httpError: 400, error: {code: 'invalid_game_command', message: '尚未满足攻击条件'}})});
  ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0].fire('click');
  await ui.click('match-deck-response-battle:confirm');
  assert.equal(ui.get('notice').hidden, true); assert.match(ui.get('match-deck-player-response').textContent, /尚未满足攻击条件/);
  assert.equal(ui.get('match-deck-response-battle:confirm').disabled, false);
  ui.get('match-public-dungeon-cards-main-rank-2').children[1].children[0].fire('click');
  assert.doesNotMatch(ui.get('match-deck-player-response').textContent, /尚未满足攻击条件/);
  assert.match(ui.get('match-deck-player-response').textContent, /攻击阶层 2/); ui.cleanup();
});

test('a removed declaration target clears local selection and disables confirmation', async () => {
  const {view, f, hall} = declarationView(), ui = await page({view});
  ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0].fire('click');
  const next = structuredClone(view); next.version++;
  next.dungeons[0].hall = [next.dungeons[0].hall[1]]; next.legal_commands[0].instance_ids = [hall[1]];
  f.state.zones['destroyed'].push(f.state.zones['hall:main'].shift()); f.state.game_version++;
  next.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  ui.setView(next); await ui.click('refresh-match');
  assert.equal(ui.get('match-deck-response-battle:confirm').disabled, true);
  assert.match(ui.get('match-deck-player-response').textContent, /请选择地下城大厅/); assert.equal(posts(ui).length, 0); ui.cleanup();
});

test('battle team uses the shared local engine, keeps cards in hand and submits only the chosen team', async () => {
  const {view, f} = battleView();
  view.legal_commands = view.legal_commands.filter(command => command.type !== 'EquipWeapon');
  const ui = await page({view, post: async () => ({...fixture(), version: 2})});
  const [hero, weapon, spell] = f.hand;
  assert.match(combatText(ui), /攻击 0/);
  cardAction(ui, hero, '出阵');
  cardAction(ui, weapon, '装备');
  assert.deepEqual(glowing(ui), [hero]);
  // Already resolved equipment need not send another EquipWeapon event.
  handCard(ui, hero).fire('click'); await settle();
  ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0].fire('click');
  assert.match(combatText(ui), /攻击 2/);
  assert.equal(handCards(ui).length, 3); assert.equal(ui.requests.filter(r => r.options.method === 'POST').length, 0);
  await ui.click('match-deck-response-SubmitBattleTeam');
  const command = ui.requests.find(r => r.url.endsWith('/commands')).body.command;
  assert.deepEqual(command, {type: 'SubmitBattleTeam', draft: {target_instance_id: null, hero_instance_ids: [hero], support_instance_ids: [], equipment: {[hero]: [weapon]}}});
  ui.cleanup();
});

test('same-version recovery restores a temporarily unavailable battle preparation', async () => {
  const {view} = battleView(), ui = await page({view: {...view, battle_preparation: null}});
  assert.equal(ui.get('battle-team-panel').hidden, true);
  ui.setView(view); ui.sockets[0].onmessage({data: JSON.stringify({type: 'match_changed'})}); await settle();
  assert.equal(ui.get('battle-team-panel').hidden, true);
  assert.match(combatText(ui), /魔法攻击/); ui.cleanup();
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
  assert.equal(ui.get('notice').hidden, true);
  assert.match(ui.get('match-deck-player-response').textContent, /连接失败/);
  assert.ok(descendants(ui.get('match-deck-player-response')).some(node => node.dataset.error === 'true' && node.getAttribute('role') === 'alert'));
  assert.equal(commandButtons(ui, 'ChooseAction')[0].disabled, false);
  commandButtons(ui, 'ChooseAction')[0].dispatch('click'); await settle();
  commandButtons(ui, 'ChooseAction')[0].dispatch('click'); await settle();
  const requests = ui.requests.filter(r => r.url.endsWith('/commands'));
  assert.equal(requests.length, 3); assert.equal(requests[0].body.command_id, requests[1].body.command_id);
  assert.notEqual(requests[1].body.command_id, requests[2].body.command_id);
  assert.equal(requests[2].body.expected_version, 2); ui.cleanup();
});

test('an incompatible or unavailable engine explains missing actions in the response area', async () => {
  const reason = '当前引擎无法读取本局规则或存档格式；本局已保留，可下载对局文件排查并迁移';
  const ui = await page({view: {...fixture(), legal_commands: [], unavailable_reason: reason}});
  const response = ui.get('match-deck-player-response');
  assert.ok(response.textContent.includes(reason));
  assert.ok(descendants(response).some(node => node.dataset.error === 'true' && node.getAttribute('role') === 'alert'));
  assert.equal(posts(ui).length, 0); ui.cleanup();
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

test('finished game shows score without the removed public event list or remaining commands', async () => {
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
  assert.equal(ui.document.getElementById('event-log'), null);
  assert.doesNotMatch(ui.get('history-body').textContent, /private_unknown|must not appear/);
  assert.equal(commandButtons(ui, 'ChooseAction').length, 0); ui.cleanup();
});

test('finished results open once, rank equal totals by stone and reopen without recalculating private cards', async () => {
  const view = fixture('finished'); view.legal_commands = []; view.actor_player_id = null;
  view.players[1].avatar_url = '/avatars/bob.png';
  view.result = {winner_ids: ['bob'], tie_break: 'thunderstone', players: {
    alice: {victory_points: 14, card_victory_points: 9, experience_points: 5, thunderstones: 0, eliminated: false},
    bob: {victory_points: 14, card_victory_points: 12, experience_points: 2, thunderstones: 1, eliminated: false},
  }};
  const ui = await page({view});
  const find = cls => descendants(ui.get('match-overlays')).find(node => node.className.split(' ').includes(cls));
  const dialog = find('game-results'); assert.equal(dialog.hidden, false); assert.equal(ui.get('match-content').inert, true);
  const rows = find('game-results-chart').children;
  assert.deepEqual(rows.map(row => row.dataset.playerId), ['bob', 'alice']);
  assert.match(rows[1].textContent, /卡牌 9 \+ XP 5/);
  assert.ok(descendants(rows[0]).some(node => node.src === '/avatars/bob.png'));
  assert.equal(descendants(rows[0]).filter(node => node.className === 'game-results-crown').length, 1);
  descendants(dialog).find(node => node.className.split(' ').includes('browse-dialog-close')).fire('click'); assert.equal(dialog.hidden, true);
  await ui.click('refresh-match'); assert.equal(dialog.hidden, true);
  await ui.click('match-deck-response-match:results'); assert.equal(dialog.hidden, false);
  const returnButton = descendants(dialog).find(node => node.className.split(' ').includes('game-results-return'));
  ui.document.fire('keydown', {key: 'Tab'}); assert.equal(ui.document.activeElement, returnButton);
  returnButton.fire('click'); assert.equal(ui.navigations.at(-1), '/play?view=room');
  assert.equal(posts(ui).length, 0); ui.cleanup(); assert.equal(dialog.hidden, true);
});

test('duplicate hand abilities identify the exact visible card instance', async () => {
  const view = commandView({type: 'ActivateAbility', options: [
    {source_instance_id: 'CI-1', ability_id: 'TS-0001-A01'}, {source_instance_id: 'CI-2', ability_id: 'TS-0001-A01'},
  ]});
  view.hand[1].card_id = 'TS-0001'; view.command_instances['CI-2'].card_id = 'TS-0001';
  view.turn.subphase = 'VILLAGE_ABILITIES'; view.turn.chosen_action = 'village';
  const ui = await page({view});
  handCard(ui, 'CI-1').fire('click'); assert.match(ui.get('match-card-actions-title').textContent, /手牌 1/);
  ui.get('match-card-actions-close').fire('click');
  handCard(ui, 'CI-2').fire('click'); assert.match(ui.get('match-card-actions-title').textContent, /手牌 2/);
  assert.equal(commandButtons(ui, 'ActivateAbility')[0].dataset.sourceInstanceId, 'CI-2');
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

function villageView(phase, commands) {
  const view = fixture(); Object.assign(view.turn, {chosen_action: 'village', subphase: phase});
  view.legal_commands = commands; return view;
}
const responseButtons = ui => ui.get('match-deck-player-response').children.filter(node => node.tagName === 'button');
const supplyCard = (ui, zone) => descendants(ui.get(`match-public-village-cards-pile-${zone}`))
  .find(node => node.className === 'physical-card' && !node.hidden);

test('village stages expose exactly their action and skip buttons, including disabled actions with no legal options', async () => {
  for (const [phase, commands, labels] of [
    ['VILLAGE_ABILITIES', [{type: 'FinishAbilities'}], ['跳过']],
    ['VILLAGE_BUY', [{type: 'FinishBuying'}], ['购买卡牌', '跳过']],
    ['VILLAGE_UPGRADE', [{type: 'FinishUpgrading'}], ['升级英雄', '跳过']],
  ]) {
    const ui = await page({view: villageView(phase, commands)});
    assert.deepEqual(responseButtons(ui).map(node => node.textContent), labels);
    if (phase !== 'VILLAGE_ABILITIES') assert.equal(responseButtons(ui)[0].disabled, true);
    assert.equal(responseButtons(ui).at(-1).disabled, false); ui.cleanup();
  }
});

test('village effect cards glow immediately and list distinct legal abilities for the exact hand instance', async () => {
  const abilities = ['TS-0001-A01', 'TS-0001-A02'];
  const view = villageView('VILLAGE_ABILITIES', [{type: 'ActivateAbility', options: abilities.map(ability_id => ({ability_id, source_instance_id: 'CI-1'}))}, {type: 'FinishAbilities'}]);
  view.abilities = Object.fromEntries(abilities.map((id, index) => [id, {source_card_id: 'TS-0001', source_line: `村庄：效果 ${index + 1}。`}]));
  const next = structuredClone(view); next.version++; next.legal_commands = [{type: 'FinishAbilities'}];
  const ui = await page({view, post: () => next});
  assert.deepEqual(glowing(ui), ['CI-1']);
  handCards(ui)[1].fire('click'); assert.equal(ui.get('match-card-actions').hidden, true);
  handCards(ui)[0].fire('click'); assert.equal(ui.get('match-card-actions').hidden, false);
  assert.equal(ui.get('match-content').inert, true);
  const options = descendants(ui.get('match-card-actions')).filter(node => node.dataset.command === 'ActivateAbility');
  assert.deepEqual(options.map(node => node.textContent), ['村庄：效果 1。', '村庄：效果 2。']);
  options[1].fire('click'); options[1].fire('click'); await settle();
  assert.deepEqual(posts(ui).map(request => request.body.command), [{type: 'ActivateAbility', source_instance_id: 'CI-1', ability_id: abilities[1]}]);
  assert.equal(ui.get('match-card-actions').hidden, true); assert.equal(ui.get('match-content').inert, false);
  assert.deepEqual(glowing(ui), []); ui.cleanup();
});

test('stale card ability buttons cannot execute after a newer projection closes the panel', async () => {
  const view = villageView('VILLAGE_ABILITIES', [{type: 'ActivateAbility', options: [{ability_id: 'TS-0001-A01', source_instance_id: 'CI-1'}]}, {type: 'FinishAbilities'}]);
  const ui = await page({view}); handCards(ui)[0].fire('click');
  const old = descendants(ui.get('match-card-actions')).find(node => node.dataset.command === 'ActivateAbility');
  const next = structuredClone(view); next.version++;
  ui.setView(next); await ui.click('refresh-match');
  assert.equal(ui.get('match-card-actions').hidden, true); old.fire('click');
  assert.equal(posts(ui).length, 0); ui.cleanup();
});

test('card action dialogs share keyboard focus trapping, escape dismissal and background restoration', async () => {
  const view = villageView('VILLAGE_ABILITIES', [{type: 'ActivateAbility', options: ['A01', 'A02'].map(suffix => ({source_instance_id: 'CI-1', ability_id: `TS-0001-${suffix}`}))}, {type: 'FinishAbilities'}]);
  const ui = await page({view}), card = handCards(ui)[0]; card.focus(); card.fire('click');
  const close = ui.get('match-card-actions-close'), options = descendants(ui.get('match-card-actions')).filter(node => node.dataset.command);
  assert.ok(ui.document.activeElement === close);
  ui.window.fire('keydown', {key: 'Tab', shiftKey: true}); assert.ok(ui.document.activeElement === options.at(-1));
  ui.window.fire('keydown', {key: 'Tab'}); assert.ok(ui.document.activeElement === close);
  ui.window.fire('keydown', {key: 'Escape'});
  assert.equal(ui.get('match-card-actions').hidden, true); assert.equal(ui.get('match-content').inert, false);
  assert.ok(ui.document.activeElement === card); assert.equal(posts(ui).length, 0); ui.cleanup();
});

test('a village effect choice closes its action menu and shows choices directly in the response area', async () => {
  const view = villageView('VILLAGE_ABILITIES', [{type: 'ActivateAbility', options: [{ability_id: 'TS-0001-A01', source_instance_id: 'CI-1'}]}, {type: 'FinishAbilities'}]);
  const pending = structuredClone(view); pending.version++; pending.pending_choice = {kind: 'effect_value', player_id: 'alice', can_resolve: true};
  pending.legal_commands = [{type: 'ResolveValueChoice', options: [0, 1]}];
  const done = structuredClone(view); done.version += 2;
  const ui = await page({view, post: (_url, body) => body.command.type === 'ActivateAbility' ? pending : done});
  handCards(ui)[0].fire('click'); descendants(ui.get('match-card-actions')).find(node => node.dataset.command === 'ActivateAbility').fire('click'); await settle();
  assert.equal(ui.get('match-card-actions').hidden, true); assert.equal(ui.get('match-content').inert, false);
  assert.deepEqual(responseButtons(ui).map(node => node.textContent), ['0', '1']);
  responseButtons(ui)[0].fire('click'); await settle();
  assert.deepEqual(posts(ui).at(-1).body.command, {type: 'ResolveValueChoice', value: 0});
  assert.equal(ui.get('match-content').inert, false); ui.cleanup();
});

test('purchase targeting uses quoted prices rather than printed costs and buys only a legal current top', async () => {
  const view = villageView('VILLAGE_BUY', [{type: 'BuyCard', card_ids: ['TS-0001', 'TS-0002'], options: [
    {card_id: 'TS-0001', price: 0}, {card_id: 'TS-0002', price: 3}]}, {type: 'FinishBuying'}]);
  view.viewer_resources.temporary_gold = 3;
  view.cards['TS-0001'].stats.价格 = '99'; view.cards['TS-0300'].stats.价格 = '0';
  const next = structuredClone(view); next.version++; next.viewer_resources.temporary_gold = 0;
  next.turn.subphase = 'ACTION_END'; next.legal_commands = [{type: 'FinishTurn'}];
  const ui = await page({view, post: () => next});
  assert.equal(supplyCard(ui, 'basic_supply:test').dataset.glowing, 'false');
  await ui.click('match-deck-response-village:buy');
  assert.equal(ui.get('match-public-village-tab').getAttribute('aria-selected'), 'true');
  assert.equal(supplyCard(ui, 'basic_supply:test').dataset.glowing, 'true');
  assert.equal(supplyCard(ui, 'village_supply:test').dataset.glowing, 'true');
  assert.equal(supplyCard(ui, 'village_supply:test').dataset.purchasePrice, '3');
  assert.equal(supplyCard(ui, 'hero_supply:test').dataset.glowing, 'false');
  supplyCard(ui, 'hero_supply:test').fire('click'); assert.equal(posts(ui).length, 0);
  assert.equal(ui.get('match-public-village-cards-browser').hidden, true);
  supplyCard(ui, 'village_supply:test').fire('click'); await settle();
  assert.deepEqual(posts(ui).map(request => request.body.command), [{type: 'BuyCard', card_id: 'TS-0002'}]);
  assert.equal(ui.get('match-deck-gold-value').textContent, '0');
  assert.equal(ui.get('match-deck-response-village:buy').isConnected, false);
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false);
  assert.equal(supplyCard(ui, 'basic_supply:test').dataset.glowing, 'false'); ui.cleanup();
});

test('extra purchases stay in purchase targeting and refresh the legal cards after every spend', async () => {
  const view = villageView('VILLAGE_BUY', [{type: 'BuyCard', card_ids: ['TS-0001', 'TS-0002'], options: [
    {card_id: 'TS-0001', price: 2}, {card_id: 'TS-0002', price: 4}]}, {type: 'FinishBuying'}]);
  view.viewer_resources.temporary_gold = 6; view.viewer_resources.purchases_remaining = 2;
  const second = structuredClone(view); second.version++; second.viewer_resources.temporary_gold = 2;
  second.viewer_resources.purchases_remaining = 1; second.legal_commands[0] = {type: 'BuyCard', card_ids: ['TS-0001'], options: [{card_id: 'TS-0001', price: 2}]};
  const done = structuredClone(second); done.version++; done.viewer_resources.temporary_gold = 0;
  done.viewer_resources.purchases_remaining = 0; done.turn.subphase = 'ACTION_END'; done.legal_commands = [{type: 'FinishTurn'}];
  const ui = await page({view, post: (_url, body) => body.command.card_id === 'TS-0002' ? second : done});
  await ui.click('match-deck-response-village:buy'); supplyCard(ui, 'village_supply:test').fire('click'); await settle();
  assert.equal(supplyCard(ui, 'village_supply:test').dataset.glowing, 'false');
  assert.equal(supplyCard(ui, 'basic_supply:test').dataset.glowing, 'true');
  supplyCard(ui, 'basic_supply:test').fire('click'); await settle();
  assert.deepEqual(posts(ui).map(request => request.body.command.card_id), ['TS-0002', 'TS-0001']);
  assert.match(ui.get('match-deck-response-progress').textContent, /6\/6 结束回合/);
  assert.equal(ui.get('match-deck-response-FinishBuying').isConnected, false); ui.cleanup();
});

for (const kind of ['hero', 'basic']) test(`purchasing from ${kind} flies the old visible top into discard before exposing manual turn end`, async () => {
  const cardId = kind === 'hero' ? 'TS-0300' : 'TS-0001', zone = `${kind}_supply:test`;
  const view = villageView('VILLAGE_BUY', [{type: 'BuyCard', card_ids: [cardId], options: [{card_id: cardId, price: 3}]}, {type: 'FinishBuying'}]);
  const next = structuredClone(view); next.version++; next.turn.subphase = 'ACTION_END'; next.viewer_resources.temporary_gold = 0;
  next.legal_commands = [{type: 'FinishTurn'}]; next.discard = [{instance_id: 'CI-bought', card_id: cardId}];
  next.event_log = [{sequence: 1, kind: 'card_bought', player_id: 'alice', card_id: cardId, price: 3}];
  if (kind === 'hero') {
    const pile = next.supplies.find(pile => pile.zone_id === zone);
    pile.cards[0].count = 0; pile.top_card_id = 'TS-0301'; pile.remaining = 4;
  }
  const ui = await page({view, animationsEnabled: true, post: () => next});
  await ui.click('match-deck-response-village:buy'); const source = supplyCard(ui, zone);
  const lift = source.children[0]; lift.getBoundingClientRect = () => ({left: 123, top: 208, width: 160, height: 224, right: 283, bottom: 432});
  source.fire('click'); await settle();
  const flights = ui.animations.filter(animation => animation.element.className === 'card-flight');
  assert.equal(flights.length, 1); assert.equal(flights[0].element.style.left, '123px');
  assert.equal(flights[0].element.style.top, '208px'); assert.equal(flights[0].element.children[0].dataset.cardId, cardId);
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, true); assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  if (kind === 'hero') assert.equal(supplyCard(ui, zone).dataset.cardId, 'TS-0301');
  else assert.equal(ui.get(`match-public-village-cards-pile-${zone}`).children[0].children[1].textContent, '∞');
  ui.setView(next); await ui.click('refresh-match');
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-flight').length, 1, 'same version cannot replay a purchase');
  await ui.advance(300); assert.equal(ui.get('match-deck-discard-count').textContent, '1');
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false);
  assert.deepEqual(responseButtons(ui).map(node => node.textContent), ['结束回合']);
  assert.equal(posts(ui).length, 1, 'automatic stages never require extra browser commands'); ui.cleanup();
});

for (const [kind, depleted, effect] of [['hero', false, false], ['hero', true, false], ['basic', false, false], ['village', true, false], ['village', true, true]])
test(`committed supply motion flies into discard with the table locked: ${kind}, depleted ${depleted}, effect ${effect}`, async () => {
  // Same gain payload as the exported 沙鲁林魔术师 purchase (sequence 67),
  // not merely the legacy public card_bought event used by the old tests above.
  const cardId = kind === 'hero' ? 'TS-0402' : kind === 'basic' ? 'TS-0004' : 'TS-0221';
  const zone = kind === 'hero' ? 'hero_supply:TS-0160' : `${kind}_supply:test`;
  const before = villageView('VILLAGE_BUY', [{type: 'FinishBuying'}]); before.version = 6;
  before.history = {cursor: 6, epoch: 2, can_undo: true, can_jump: true, entries: []};
  before.cards[cardId] = {...before.cards['TS-0300'], card_id: cardId, image_url: `/cards/${cardId}.png`, name: kind === 'hero' ? '沙鲁林魔术师' : '供应卡牌'};
  before.supplies = [{zone_id: zone, kind, name: '测试供应', top_card_id: cardId, remaining: depleted ? 1 : 6, infinite: kind === 'basic',
    cards: [{card_id: cardId, count: depleted ? 1 : 6}]}];
  const next = structuredClone(before); next.version = 7; next.history.cursor = 7;
  next.turn.subphase = 'ACTION_END'; next.legal_commands = [{type: 'FinishTurn'}];
  const record = {instance_id: 'CI-000101', card_id: cardId}; next.discard = [record];
  next.event_log = [{sequence: 67, kind: effect ? 'effect_card_gained' : 'card_bought', player_id: 'alice', card_id: cardId,
    ...(effect ? {source: zone, destination: 'discard'} : {price: 8, gold_remaining: 0})}];
  next.card_motion = [deckMotion(67, [{kind: 'gain', source: effect ? zone : 'supply', destination: 'discard', cards: [record]}])];
  if (kind !== 'basic') {
    next.supplies[0].remaining--; next.supplies[0].cards[0].count--;
    if (depleted) next.supplies[0].top_card_id = null;
  }
  const ui = await page({view: before, animationsEnabled: true}); await ui.click('match-public-village-tab');
  supplyCard(ui, zone).children[0].getBoundingClientRect = () => ({left: 123, top: 208, width: 160, height: 224, right: 283, bottom: 432});
  ui.setView(next); await ui.click('refresh-match');
  const flights = () => ui.animations.filter(animation => animation.element.className === 'card-flight');
  assert.equal(flights().length, 1); assert.equal(flights()[0].element.style.left, '123px');
  assert.equal(flights()[0].element.children[0].dataset.cardId, cardId);
  assert.equal(ui.get('match-public-root').inert, true);
  assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, true);
  await ui.click('refresh-match'); assert.equal(flights().length, 1, 'duplicate REST/realtime snapshots cannot replay the flight');
  await ui.advance(1500);
  assert.equal(ui.get('match-public-root').inert, false);
  assert.equal(ui.get('match-deck-discard-count').textContent, '1');
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false);
  assert.equal(flights().length, 1); ui.cleanup();
});

for (const kind of ['basic', 'village']) test(`mandatory merchant gain flies from ${kind} supply into discard with no skip or regular purchase`, async () => {
  const cardId = kind === 'basic' ? 'TS-0004' : 'TS-0221', zone = `${kind}_supply:merchant`;
  const view = commandView({type: 'ResolveEffectPurchase', options: [{card_id: cardId, price: kind === 'basic' ? 2 : 4}], may_skip: false});
  view.version = 2;
  view.turn.chosen_action = 'village'; view.turn.subphase = 'VILLAGE_ABILITIES';
  view.cards[cardId] = {...view.cards['TS-0001'], card_id: cardId, name: kind === 'basic' ? '应急干粮' : '商人', image_url: `/cards/${cardId}.png`};
  view.supplies = [{zone_id: zone, kind, top_card_id: cardId, infinite: kind === 'basic', remaining: kind === 'basic' ? null : 1,
    cards: [{card_id: cardId, count: kind === 'basic' ? null : 1}]}];
  const next = structuredClone(view); next.version++; next.pending_choice = null;
  next.legal_commands = [{type: 'FinishAbilities'}]; next.discard = [{instance_id: 'CI-gained', card_id: cardId}];
  next.event_log = [{sequence: 1, kind: 'effect_card_gained', player_id: 'alice', card_id: cardId, source: zone, destination: 'discard'}];
  if (kind === 'village') Object.assign(next.supplies[0], {top_card_id: null, remaining: 0, cards: []});
  const before = structuredClone(view); before.version = 1; before.pending_choice = null; before.legal_commands = [{type: 'FinishAbilities'}];
  const ui = await page({view: before, animationsEnabled: true, post: () => next});
  await ui.click('match-public-village-tab');
  const source = supplyCard(ui, zone);
  source.children[0].getBoundingClientRect = () => ({left: 127, top: 209, width: 160, height: 224, right: 287, bottom: 433});
  ui.setView(view); await ui.click('refresh-match'); await settle();
  assert.deepEqual(posts(ui)[0].body.command, {type: 'ResolveEffectPurchase', card_id: cardId});
  const flights = ui.animations.filter(animation => animation.element.className === 'card-flight');
  assert.equal(flights.length, 1); assert.equal(flights[0].element.style.left, '127px');
  assert.equal(flights[0].element.children[0].dataset.cardId, cardId);
  assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  await ui.advance(300); assert.equal(ui.get('match-deck-discard-count').textContent, '1');
  if (kind === 'basic') assert.equal(ui.get(`match-public-village-cards-pile-${zone}`).children[0].children[1].textContent, '∞');
  assert.equal(posts(ui).length, 1); ui.cleanup();
});

test('automatic entry into upgrade does not replace the opponent purchase announcement', () => {
  const previous = villageView('VILLAGE_BUY', []); previous.viewer_player_id = 'bob';
  const next = structuredClone(previous); next.version++; next.turn.subphase = 'VILLAGE_UPGRADE';
  const events = [{sequence: 1, kind: 'card_bought', player_id: 'alice', card_id: 'TS-0300'},
    {sequence: 2, kind: 'village_upgrade_started', player_id: 'alice'}];
  assert.deepEqual(playerActivity(next, previous, events), {playerId: 'alice', text: '购买了 卡牌2'});
  next.turn.subphase = 'ACTION_END';
  assert.deepEqual(playerActivity(next, previous, events), {playerId: 'alice', text: '购买了 卡牌2'});
});

test('purchase requests lock repeated clicks and recover the same targeting and command ID after a network failure', async () => {
  const view = villageView('VILLAGE_BUY', [{type: 'BuyCard', card_ids: ['TS-0002'], options: [{card_id: 'TS-0002', price: 3}]}, {type: 'FinishBuying'}]);
  let calls = 0;
  const ui = await page({view, post: () => {if (++calls === 1) throw new TypeError('offline'); return {...view, version: 2};}});
  await ui.click('match-deck-response-village:buy'); const card = supplyCard(ui, 'village_supply:test');
  card.fire('click'); card.fire('click'); await settle();
  assert.equal(posts(ui).length, 1); assert.equal(card.dataset.glowing, 'true');
  card.fire('click'); await settle();
  assert.equal(posts(ui).length, 2); assert.equal(posts(ui)[0].body.command_id, posts(ui)[1].body.command_id); ui.cleanup();
});

test('upgrade highlights only eligible hand heroes and submits a sole legal upgrade directly, including exact XP', async () => {
  const view = villageView('VILLAGE_UPGRADE', [{type: 'UpgradeHero', options: [{source_instance_id: 'CI-1', target_card_id: 'TS-0300', xp_cost: 2}]}, {type: 'FinishUpgrading'}]);
  const next = structuredClone(view); next.version++; next.viewer_resources.xp = 0;
  next.hand = next.hand.filter(card => card.instance_id !== 'CI-1'); next.turn.subphase = 'ACTION_END'; next.legal_commands = [{type: 'FinishTurn'}];
  const ui = await page({view, post: () => next});
  assert.deepEqual(glowing(ui), []); await ui.click('match-deck-response-village:upgrade'); assert.deepEqual(glowing(ui), ['CI-1']);
  handCards(ui)[1].fire('click'); assert.equal(posts(ui).length, 0);
  handCards(ui)[0].fire('click'); await settle();
  assert.deepEqual(posts(ui)[0].body.command, {type: 'UpgradeHero', source_instance_id: 'CI-1', target_card_id: 'TS-0300'});
  assert.equal(ui.get('match-deck-xp-value').textContent, '0'); assert.equal(ui.get('match-deck-response-village:upgrade').isConnected, false);
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false); ui.cleanup();
});

test('a committed hero upgrade evolves instead of playing its destruction event, and refresh does not replay it', async () => {
  const view = villageView('VILLAGE_UPGRADE', [{type: 'UpgradeHero', options: [{source_instance_id: 'CI-1', target_card_id: 'TS-0300', xp_cost: 3}]}, {type: 'FinishUpgrading'}]);
  view.viewer_resources.xp = 3;
  const next = structuredClone(view); next.version++; next.viewer_resources.xp = 0;
  next.turn.subphase = 'ACTION_END'; next.legal_commands = [{type: 'FinishTurn'}];
  next.hand = next.hand.filter(card => card.instance_id !== 'CI-1'); next.discard = [{instance_id: 'CI-evolved', card_id: 'TS-0300'}];
  next.event_log = [{sequence: 1, kind: 'card_destroyed', player_id: 'alice', card_id: 'TS-0001'},
    {sequence: 2, kind: 'hero_upgraded', player_id: 'alice', source_card_id: 'TS-0001', target_card_id: 'TS-0300', xp_cost: 3}];
  const ui = await page({view, animationsEnabled: true, post: () => next});
  await ui.click('match-deck-response-village:upgrade'); handCards(ui)[0].fire('click'); await settle();
  assert.equal(ui.get('match-deck-card-motion-layer').children[0].className, 'card-upgrade');
  assert.equal(ui.animations.some(animation => animation.element.className === 'card-destruction'), false);
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, true);
  ui.setView(next); await ui.click('refresh-match');
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-upgrade').length, 1);
  await ui.advance(1700);
  assert.equal(ui.get('match-deck-discard-count').textContent, '1'); assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false);
  assert.equal(ui.get('match-deck-xp-value').textContent, '0'); assert.equal(ui.get('match-deck-card-motion-layer').children.length, 0);
  assert.equal(posts(ui).length, 1); ui.cleanup();
});

test('militia with several upgrade paths asks for the exact target, and a stale upgrade menu cannot send', async () => {
  const view = villageView('VILLAGE_UPGRADE', [{type: 'UpgradeHero', options: ['TS-0300', 'TS-0301'].map(target_card_id => ({source_instance_id: 'CI-1', target_card_id, xp_cost: 2}))}, {type: 'FinishUpgrading'}]);
  const ui = await page({view}); await ui.click('match-deck-response-village:upgrade'); handCards(ui)[0].fire('click');
  await settle();
  assert.equal(ui.get('match-public-village-tab').dataset.attention, 'true'); assert.equal(posts(ui).length, 0);
  await ui.click('match-public-village-tab'); supplyCard(ui, 'hero_supply:test').fire('click');
  const options = ui.all.filter(node => node.tagName === 'button' && node.id?.includes('browse-') && node.dataset.cardId);
  assert.equal(options.length, 2);
  await settle();
  assert.equal(ui.get('match-card-actions').hidden, true);
  const preview = options[0];
  preview.fire('pointerenter'); ui.key(' '); assert.equal(ui.get('match-public-village-cards-inspect').hidden, false); ui.release();
  const next = structuredClone(view); next.version++; next.legal_commands = [{type: 'FinishUpgrading'}];
  ui.setView(next); await ui.click('refresh-match'); options[1].fire('click'); assert.equal(posts(ui).length, 0); ui.cleanup();
  const chosen = await page({view, post: () => ({...next, version: 3})});
  await chosen.click('match-deck-response-village:upgrade'); handCards(chosen)[0].fire('click');
  await chosen.click('match-public-village-tab'); supplyCard(chosen, 'hero_supply:test').fire('click');
  chosen.all.find(node => node.tagName === 'button' && node.dataset.cardId === 'TS-0301' && node.id.includes('browse-')).fire('click'); await settle();
  assert.equal(posts(chosen)[0].body.command.target_card_id, 'TS-0301'); chosen.cleanup();
});

test('waiting or unavailable village views expose no targeting or effect menu', async () => {
  for (const updates of [{actor_player_id: 'bob'}, {unavailable_reason: '规则版本已变化'}]) {
    const view = Object.assign(villageView('VILLAGE_ABILITIES', [{type: 'ActivateAbility', options: [{source_instance_id: 'CI-1', ability_id: 'TS-0001-A01'}]}, {type: 'FinishAbilities'}]), updates);
    const ui = await page({view}); assert.deepEqual(glowing(ui), []); handCards(ui)[0].fire('click');
    assert.equal(ui.get('match-card-actions').hidden, true); assert.equal(responseButtons(ui).length, 0); assert.equal(posts(ui).length, 0); ui.cleanup();
  }
});

test('dungeon completion submits only the team, then the third stage selects and declares a hall target', async () => {
  const {view, f} = battleView(); Object.assign(view.turn, {chosen_action: 'dungeon', subphase: 'DUNGEON_PREPARE'});
  const declare = structuredClone(view); declare.version++; declare.turn.subphase = declare.turn.timing_window = 'DUNGEON_DECLARE';
  declare.legal_commands = [{type: 'DeclareBattleTarget', instance_ids: f.hall}, {type: 'ReviseBattleTeam'}];
  f.state.game_version++; f.state.subphase = 'DUNGEON_DECLARE';
  f.state.battle_context.battle_team = {hero_instance_ids: [f.hand[0]], support_instance_ids: []};
  declare.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  const next = structuredClone(declare); next.version++; next.turn.subphase = 'ACTION_END'; next.battle_preparation = null; next.legal_commands = [{type: 'FinishTurn'}];
  const ui = await page({view, post: (_url, body) => body.command.type === 'SubmitBattleTeam' ? declare : next});
  assert.deepEqual(responseButtons(ui).map(node => node.textContent), ['使用效果', '完成']);
  const target = () => ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0];
  assert.equal(target().dataset.glowing, 'false'); target().fire('click'); assert.equal(posts(ui).length, 0);
  cardAction(ui, f.hand[0], '出阵');
  await ui.click('match-public-village-tab');
  await ui.click('match-deck-response-SubmitBattleTeam');
  assert.equal(posts(ui)[0].body.command.type, 'SubmitBattleTeam'); assert.equal(posts(ui)[0].body.command.draft.target_instance_id, null);
  assert.deepEqual(posts(ui)[0].body.command.draft.support_instance_ids, []);
  assert.match(ui.get('match-deck-player-response').textContent, /宣言战斗/);
  assert.match(ui.get('match-deck-player-response').textContent, /请选择地下城大厅中的战斗目标/);
  assert.equal(ui.get('match-public-dungeon-panel').hidden, false);
  assert.equal(target().dataset.glowing, 'true');
  handCard(ui, f.hand[0]).fire('click'); assert.equal(handCard(ui, f.hand[0]).dataset.selected, 'true');
  target().fire('click'); await settle();
  assert.equal(posts(ui).length, 1, 'selecting a target must not declare battle');
  assert.equal(target().dataset.selected, 'true');
  assert.match(ui.get('match-deck-player-response').textContent, /攻击阶层 1 ：队伍预计攻击总和/);
  assert.ok(descendants(ui.get('match-deck-player-response')).some(node => node.className === 'combat-value-adjusted'));
  await ui.click('match-deck-response-battle:confirm');
  assert.deepEqual(posts(ui)[1].body.command, {type: 'DeclareBattleTarget', target_instance_id: f.hall[0]});
  assert.deepEqual(responseButtons(ui).map(node => node.textContent), ['结束回合']); ui.cleanup();
});

test('reconnecting during declaration uses the committed team and can return to preparation', async () => {
  const {view, f} = battleView(); view.turn.subphase = view.turn.timing_window = f.state.subphase = 'DUNGEON_DECLARE';
  f.state.battle_context.battle_team = {hero_instance_ids: [], support_instance_ids: [f.hand[2]]};
  view.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  view.legal_commands = [{type: 'DeclareBattleTarget', instance_ids: f.hall}, {type: 'ReviseBattleTeam'}];
  const next = structuredClone(view); next.version++; next.turn.subphase = 'DUNGEON_PREPARE'; next.legal_commands = [{type: 'SubmitBattleTeam'}];
  const ui = await page({view, post: () => next});
  assert.equal(handCard(ui, f.hand[0]).dataset.selected, 'false');
  assert.equal(handCard(ui, f.hand[2]).dataset.selected, 'true'); assert.match(combatText(ui), /魔法攻击 3/);
  await ui.click('match-deck-response-ReviseBattleTeam');
  assert.deepEqual(posts(ui)[0].body.command, {type: 'ReviseBattleTeam'});
  assert.deepEqual(responseButtons(ui).map(node => node.textContent), ['使用效果', '完成']); ui.cleanup();
});

test('the effects toggle highlights abilities without changing combat participation', async () => {
  const {view, f} = battleView(); Object.assign(view.turn, {chosen_action: 'dungeon', subphase: 'DUNGEON_PREPARE'});
  view.legal_commands.push({type: 'ActivateAbility', options: [{source_instance_id: f.hand[0], ability_id: 'TS-0001-A01'}]});
  view.abilities['TS-0001-A01'] = {source_card_id: 'TS-0001', source_line: '地下城：抽 1 张牌。'};
  const ui = await page({view}), hero = handCards(ui).find(card => card.dataset.instanceId === f.hand[0]);
  assert.equal(hero.dataset.glowing, 'false'); assert.equal(hero.dataset.selected, 'false');
  hero.fire('click'); assert.equal(hero.dataset.selected, 'true');
  await ui.click('match-deck-response-battle:effects'); assert.equal(hero.dataset.glowing, 'true'); hero.fire('click');
  assert.equal(hero.dataset.selected, 'true');
  assert.equal(commandButtons(ui, 'ActivateAbility').length, 1);
  assert.equal(descendants(ui.get('match-card-actions')).some(node => node.dataset.participation), false);
  ui.get('match-card-actions-close').fire('click'); await ui.click('match-deck-response-battle:effects'); hero.fire('click');
  assert.equal(hero.dataset.selected, 'false'); assert.equal(handCards(ui).length, 3);
  assert.equal(posts(ui).length, 0); ui.cleanup();
});

test('spell toggles are local and cancellable; only activating its ability sends a command', async () => {
  const {view, f} = battleView(), spell = f.hand[2];
  view.legal_commands.push({type: 'UseSpell', instance_ids: [spell]}, {type: 'ActivateAbility', options: [{source_instance_id: spell, ability_id: 'TS-0272-A01'}]});
  view.abilities['TS-0272-A01'] = {source_card_id: 'TS-0272', source_line: '地下城：测试主动效果。'};
  const next = structuredClone(view); next.version++; next.legal_commands = next.legal_commands.filter(command => command.type !== 'ActivateAbility');
  const ui = await page({view, post: () => next});
  handCard(ui, spell).fire('click'); await settle();
  assert.equal(ui.get('match-card-actions').hidden, true);
  assert.equal(posts(ui).length, 0, 'even a stale view advertising UseSpell must not make selection a command');
  assert.match(combatText(ui), /魔法攻击 3/); assert.equal(handCard(ui, spell).dataset.selected, 'true');
  assert.equal(ui.get('battle-team-panel').hidden, true);
  cardAction(ui, spell, '取消使用'); assert.match(combatText(ui), /魔法攻击 0/);
  cardAction(ui, spell, '使用'); assert.equal(posts(ui).length, 0);
  await ui.click('match-deck-response-battle:effects'); handCard(ui, spell).fire('click');
  assert.equal(commandButtons(ui, 'ActivateAbility').length, 1); commandButtons(ui, 'ActivateAbility')[0].fire('click'); await settle();
  assert.equal(posts(ui)[0].body.command.type, 'ActivateAbility'); assert.equal(handCards(ui).length, 3); ui.cleanup();
});

test('rapid first-time spell and hero selections never wait for the network with auto-sort enabled', async () => {
  const {view, f} = battleView(), first = f.hand[2], second = f.add('TS-0272');
  view.hand.push({instance_id: second, card_id: 'TS-0272'});
  view.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  // Compatibility with a snapshot from before UseSpell was retired.
  view.legal_commands.push({type: 'UseSpell', instance_ids: [first, second]});
  let reply;
  const ui = await page({view, autoSort: true, post: () => new Promise(resolve => {reply = resolve;})});
  for (const id of [first, second, f.hand[0]]) {
    handCard(ui, id).fire('click');
    assert.equal(handCard(ui, id).dataset.selected, 'true');
    assert.equal(ui.get('match-deck-response-SubmitBattleTeam').disabled, false);
  }
  assert.equal(posts(ui).length, 0, 'preselection must never create an in-flight request');
  assert.match(combatText(ui), /魔法攻击 6/); assert.match(combatText(ui), /攻击 1/);
  handCard(ui, first).fire('click'); assert.equal(handCard(ui, first).dataset.selected, 'false');
  assert.match(combatText(ui), /魔法攻击 3/);
  assert.deepEqual(view.battle_preparation.context.state.used_cards ?? [], []);
  ui.get('match-deck-response-SubmitBattleTeam').fire('click');
  assert.equal(posts(ui).length, 1);
  assert.equal(posts(ui)[0].body.command.type, 'SubmitBattleTeam');
  assert.deepEqual(posts(ui)[0].body.command.draft.support_instance_ids, [second]);
  assert.deepEqual(posts(ui)[0].body.command.draft.hero_instance_ids, [f.hand[0]]);
  assert.equal(ui.get('match-deck-response-SubmitBattleTeam').disabled, true, 'final submission still waits for authority');
  handCard(ui, first).fire('click'); assert.equal(handCard(ui, first).dataset.selected, 'false');
  reply(view); await settle(); ui.cleanup();
});

test('ordinary equipment edits stay local and contribute only when the hero participates', async () => {
  const {view, f} = battleView(), [hero, weapon] = f.hand;
  const next = structuredClone(view); next.version++;
  f.state.game_version++; f.state.battle_context.equipped_weapon_by_hero = {[hero]: weapon};
  next.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  next.legal_commands = [{type: 'SubmitBattleTeam', target_instance_ids: f.hall}];
  const ui = await page({view, post: () => next});
  cardAction(ui, weapon, '装备');
  assert.equal(ui.get('match-content').inert, false); assert.deepEqual(glowing(ui), [hero]);
  assert.match(ui.get('match-deck-player-response').textContent, /选择装备英雄/);
  handCard(ui, weapon).fire('click'); assert.equal(posts(ui).length, 0);
  handCard(ui, hero).fire('click'); await settle();
  assert.equal(posts(ui).length, 0, 'ordinary equip should not wait for the network');
  assert.equal(handCard(ui, hero).dataset.selected, 'false'); assert.equal(handCard(ui, weapon).dataset.selected, 'false');
  assert.equal(handCard(ui, weapon).dataset.equippedTo, hero); assert.match(combatText(ui), /攻击 0/);
  cardAction(ui, hero, '出阵'); assert.equal(handCard(ui, weapon).dataset.selected, 'true');
  assert.match(combatText(ui), /攻击 2/); assert.equal(handCards(ui).length, 3);
  cardAction(ui, weapon, '卸下装备'); assert.equal(handCard(ui, weapon).dataset.selected, 'false'); assert.equal(handCard(ui, weapon).dataset.equippedTo, undefined);
  cardAction(ui, weapon, '装备'); await ui.click('match-deck-response-pick:cancel');
  assert.equal(posts(ui).length, 0); assert.deepEqual(responseButtons(ui).map(button => button.textContent), ['使用效果', '完成']); ui.cleanup();
});

test('slow triggered equipment allows consecutive local participation edits and preserves them after acknowledgement', async () => {
  const {view, f} = battleView(), [hero, weapon, support] = f.hand;
  view.battle_preparation.options.immediate_equipment_instance_ids = [weapon];
  const next = structuredClone(view); next.version++;
  f.state.game_version++; f.state.battle_context.equipped_weapon_by_hero = {[hero]: weapon};
  next.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  let reply;
  const ui = await page({view, post: () => new Promise(resolve => {reply = resolve;})});
  handCard(ui, weapon).fire('click'); handCard(ui, hero).fire('click');
  assert.deepEqual(posts(ui)[0].body.command, {type: 'EquipWeapon', hero_instance_id: hero, weapon_instance_id: weapon});
  for (const id of [hero, support]) {handCard(ui, id).fire('click'); assert.equal(handCard(ui, id).dataset.selected, 'true');}
  handCard(ui, hero).fire('click'); assert.equal(handCard(ui, hero).dataset.selected, 'false');
  assert.equal(posts(ui).length, 1); assert.equal(ui.get('match-deck-response-SubmitBattleTeam').disabled, true);
  const gets = ui.requests.filter(request => request.options.method !== 'POST' && request.url.includes('/matches/')).length;
  ui.sockets[0].onmessage({data: JSON.stringify({type: 'match_changed', payload: {match_id: view.id, version: next.version}})});
  assert.equal(ui.requests.filter(request => request.options.method !== 'POST' && request.url.includes('/matches/')).length, gets);
  reply(next); await settle(); await settle();
  assert.equal(handCard(ui, support).dataset.selected, 'true'); assert.equal(handCard(ui, hero).dataset.selected, 'false');
  assert.equal(ui.requests.filter(request => request.options.method !== 'POST' && request.url.includes('/matches/')).length, gets,
    'the command response already satisfies its websocket invalidation');
  assert.equal(ui.get('match-deck-response-SubmitBattleTeam').disabled, false); ui.cleanup();
});

test('entering effects flushes an edited ordinary equipment plan once, not on every click', async () => {
  const {view, f} = battleView(), [hero, weapon] = f.hand;
  view.legal_commands.push({type: 'UpdatePreparationEquipment'});
  const next = structuredClone(view); next.version++;
  f.state.game_version++; f.state.battle_context.equipped_weapon_by_hero = {[hero]: weapon};
  next.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  const ui = await page({view, post: () => next});
  handCard(ui, weapon).fire('click'); handCard(ui, hero).fire('click');
  assert.equal(posts(ui).length, 0);
  await ui.click('match-deck-response-battle:effects');
  assert.deepEqual(posts(ui)[0].body.command, {type: 'UpdatePreparationEquipment', equipment: {[hero]: [weapon]}});
  await ui.click('match-deck-response-battle:effects'); await ui.click('match-deck-response-battle:effects');
  assert.equal(posts(ui).length, 1, 'unchanged equipment does not require a second sync'); ui.cleanup();
});

test('equipment accepted into a pending effect response survives until preparation resumes', async () => {
  const {view, f} = battleView(), [hero, weapon] = f.hand;
  view.battle_preparation.options.immediate_equipment_instance_ids = [weapon];
  const pending = structuredClone(view); pending.version++; pending.battle_preparation = null;
  pending.pending_choice = {kind: 'effect_value', player_id: 'alice', can_resolve: true};
  pending.legal_commands = [{type: 'ResolveValueChoice', options: ['pay']}];
  const done = structuredClone(view); done.version += 2;
  f.state.game_version += 2; f.state.battle_context.equipped_weapon_by_hero = {[hero]: weapon};
  done.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  const ui = await page({view, post: () => pending});
  handCard(ui, weapon).fire('click'); handCard(ui, hero).fire('click'); await settle();
  assert.equal(handCard(ui, weapon).dataset.equippedTo, hero, 'an accepted pending effect is not a rejected equip');
  ui.setView(done); ui.sockets[0].onmessage({data: JSON.stringify({type: 'match_changed', payload: {match_id: done.id, version: done.version}})});
  await settle(); await settle();
  assert.equal(handCard(ui, weapon).dataset.equippedTo, hero); ui.cleanup();
});

test('rejected immediate equip restores the prior equipment but keeps local participation edits', async () => {
  const {view, f} = battleView(), [hero, weapon] = f.hand;
  view.battle_preparation.options.immediate_equipment_instance_ids = [weapon];
  let reject;
  const ui = await page({view, post: () => new Promise((_resolve, fail) => {reject = fail;})});
  handCard(ui, weapon).fire('click'); handCard(ui, hero).fire('click'); handCard(ui, hero).fire('click');
  reject(new Error('offline')); await settle(); await settle();
  assert.equal(handCard(ui, hero).dataset.selected, 'true');
  assert.equal(handCard(ui, weapon).dataset.equippedTo, undefined);
  assert.equal(ui.get('match-deck-response-SubmitBattleTeam').disabled, false); ui.cleanup();
});

test('resolving a dungeon ability preserves the local team while updating unused abilities and the preview', async () => {
  const {view, f} = battleView(), hero = f.hand[0];
  view.legal_commands.push({type: 'ActivateAbility', options: [{source_instance_id: hero, ability_id: 'TS-0001-A01'}]});
  view.abilities['TS-0001-A01'] = {source_card_id: 'TS-0001', source_line: '地下城：测试主动效果。'};
  const pending = structuredClone(view); pending.version++; pending.battle_preparation = null;
  pending.pending_choice = {kind: 'test', player_id: 'alice', can_resolve: true};
  pending.legal_commands = [{type: 'ResolveChoice', instance_ids: [hero], min_count: 1, max_count: 1}];
  const done = structuredClone(view); done.version += 2; done.legal_commands = [{type: 'SubmitBattleTeam', target_instance_ids: f.hall}];
  const ui = await page({view, post: (_url, body) => body.command.type === 'ActivateAbility' ? pending : done});
  cardAction(ui, hero, '出阵'); ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0].fire('click');
  await ui.click('match-deck-response-battle:effects');
  handCard(ui, hero).fire('click'); commandButtons(ui, 'ActivateAbility')[0].fire('click'); await settle();
  await settle(); assert.equal(ui.get('match-content').inert, false);
  assert.deepEqual(posts(ui).map(row => row.body.command.type), ['ActivateAbility', 'ResolveChoice']);
  assert.deepEqual(glowing(ui), []); assert.equal(handCard(ui, hero).dataset.selected, 'true');
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0].dataset.active, 'false');
  await ui.click('match-deck-response-SubmitBattleTeam');
  assert.deepEqual(posts(ui).at(-1).body.command.draft.hero_instance_ids, [hero]);
  assert.equal(posts(ui).at(-1).body.command.draft.target_instance_id, null); ui.cleanup();
});

test('a spell-only team can submit with no heroes, and its source remains in the hand', async () => {
  const {view, f} = battleView(), ui = await page({view});
  cardAction(ui, f.hand[2], '使用');
  ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0].fire('click');
  assert.equal(posts(ui).length, 0); assert.equal(handCards(ui).length, 3);
  await ui.click('match-deck-response-SubmitBattleTeam');
  assert.deepEqual(posts(ui)[0].body.command.draft.hero_instance_ids, []);
  assert.deepEqual(posts(ui)[0].body.command.draft.support_instance_ids, [f.hand[2]]); ui.cleanup();
});

test('strength penalties highlight their source then ask for a hero directly in the hand', async () => {
  const {view, f} = battleView(), [hero, source] = f.hand;
  view.legal_commands.push({type: 'AssignStrengthPenalty', instance_ids: [source], hero_instance_ids: [hero]});
  const ui = await page({view, post: () => ({...fixture(), version: 2})});
  assert.deepEqual(glowing(ui), []); cardAction(ui, source, '分配力量惩罚');
  assert.deepEqual(glowing(ui), [hero]); assert.match(ui.get('match-deck-player-response').textContent, /承受力量惩罚/);
  handCard(ui, hero).fire('click'); await settle();
  assert.deepEqual(posts(ui)[0].body.command, {type: 'AssignStrengthPenalty', instance_id: source, hero_instance_id: hero}); ui.cleanup();
});

test('disease attack-type assignments use response buttons after clicking the highlighted source', async () => {
  const {view, f} = battleView(), source = f.hand[0];
  view.legal_commands.push({type: 'AssignDiseasePenalty', instance_ids: [source], attack_types: ['attack', 'magic_attack']});
  const ui = await page({view, post: () => ({...fixture(), version: 2})});
  cardAction(ui, source, '分配疾病惩罚');
  assert.equal(ui.get('match-card-actions').hidden, true);
  assert.deepEqual(responseButtons(ui).map(button => button.textContent), ['扣除攻击', '扣除魔法攻击', '取消']);
  await ui.click('match-deck-response-pick:action:1');
  assert.deepEqual(posts(ui)[0].body.command, {type: 'AssignDiseasePenalty', instance_id: source, attack_type: 'magic_attack'}); ui.cleanup();
});

test('new preparation snapshots drop departed team members without auto-selecting newly drawn heroes', async () => {
  const {view, f} = battleView(), ui = await page({view}), [hero, , spell] = f.hand;
  cardAction(ui, hero, '出阵'); cardAction(ui, spell, '使用');
  const newHero = f.add('TS-0001');
  f.state.zones['player:alice:hand'] = f.state.zones['player:alice:hand'].filter(id => id !== hero); f.state.game_version++;
  f.state.zones['player:alice:discard'].push(hero);
  const next = structuredClone(view); next.version++;
  next.hand = f.state.zones['player:alice:hand'].map(id => ({instance_id: id, card_id: f.state.instances[id].card_id}));
  next.discard = [{instance_id: hero, card_id: 'TS-0001'}];
  next.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  ui.setView(next); await ui.click('refresh-match');
  assert.equal(handCard(ui, newHero).dataset.selected, 'false'); assert.equal(handCard(ui, spell).dataset.selected, 'true');
  assert.equal(ui.get('battle-team-panel').hidden, true);
  assert.equal(posts(ui).length, 0); ui.cleanup();
});

test('mandatory trophies and diseases stay selected with a separate border and cannot be toggled off', async () => {
  const {view, f} = battleView();
  const disease = f.add('TS-0714'), trophy = f.add('TS-0476');
  view.hand = f.state.zones['player:alice:hand'].map(id => ({instance_id: id, card_id: f.state.instances[id].card_id}));
  view.battle_preparation = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  const ui = await page({view});
  for (const id of [disease, trophy]) {
    const card = handCard(ui, id); assert.equal(card.dataset.forced, 'true'); assert.equal(card.dataset.selected, 'true');
    card.fire('click'); assert.equal(card.dataset.selected, 'true');
  }
  const pending = structuredClone(view); pending.version++; pending.battle_preparation = null;
  pending.pending_choice = {kind: 'test', player_id: 'alice', can_resolve: true};
  pending.legal_commands = [{type: 'ResolveValueChoice', options: [0, 1]}];
  ui.setView(pending); await ui.click('refresh-match');
  assert.equal(handCard(ui, disease).dataset.forced, 'true'); assert.equal(handCard(ui, trophy).dataset.selected, 'true');
  assert.equal(handCard(ui, f.hand[0]).dataset.selected, 'false'); assert.equal(posts(ui).length, 0); ui.cleanup();
});

function dungeonVisualViews(feature = null) {
  const before = fixture(); before.turn.chosen_action = 'dungeon'; before.turn.subphase = 'DUNGEON_PREPARE'; before.legal_commands = [];
  before.dungeons[0].deck_count = 10;
  before.dungeons[0].hall.push({rank: 2, instance_id: 'hall-2', card_id: 'TS-0476'}, {rank: 3, instance_id: 'hall-3', card_id: 'TS-0476'});
  const final = structuredClone(before); final.version++; final.turn.subphase = 'ACTION_END'; final.legal_commands = [{type: 'FinishTurn'}];
  final.cards['TS-0477'] = {...final.cards['TS-0476'], card_id: 'TS-0477', name: '新怪物'};
  final.discard = [{instance_id: 'CI-3', card_id: 'TS-0476'}];
  final.dungeons[0].hall = [{rank: 1, instance_id: 'hall-2', card_id: 'TS-0476'}, {rank: 2, instance_id: 'hall-3', card_id: 'TS-0476'}, {rank: 3, instance_id: 'hall-new', card_id: 'TS-0477'}];
  final.dungeons[0].deck_count = feature ? 8 : 9;
  final.event_log = [{sequence: 1, kind: 'monster_defeated', player_id: 'alice', card_id: 'TS-0476', xp_gained: 1}];
  if (feature) {
    final.cards['TS-0700'] = {...final.cards['TS-0001'], card_id: 'TS-0700', name: feature === 'treasure' ? '测试宝藏' : '测试陷阱',
      subcategory: feature === 'treasure' ? '宝藏' : '陷阱', tags: [feature === 'treasure' ? '宝藏' : '陷阱']};
    final.event_log.push({sequence: 2, kind: feature === 'treasure' ? 'treasure_claimed' : 'trap_revealed',
      ...(feature === 'treasure' ? {player_id: 'alice'} : {rank: 3}), card_id: 'TS-0700', hall_zone: 'hall:main', origin: 'deck'});
    if (feature === 'treasure') final.players[0].control = [{instance_id: 'treasure-new', card_id: 'TS-0700'}];
    else {final.hand = final.hand.filter(card => card.instance_id !== 'CI-1'); final.event_log.push({sequence: 3, kind: 'card_destroyed', player_id: 'alice', card_id: 'TS-0001'},
      {sequence: 4, kind: 'card_destroyed', card_id: 'TS-0700', cause: 'trap_resolved'},
      {sequence: 5, kind: 'trap_removed', card_id: 'TS-0700', hall_zone: 'hall:main', rank: 3, hall_rank_count: 3});}
  }
  final.event_log.push({sequence: final.event_log.length + 1, kind: 'hall_card_entered', card_id: 'TS-0477', rank: 3, hall_zone: 'hall:main'});
  return {before, final};
}

for (const protectedHero of [false, true]) test(`zero-strength cleanup animates before monster departure: protection ${protectedHero}`, async () => {
  const {before, final} = dungeonVisualViews();
  before.turn.subphase = 'DUNGEON_DECLARE';
  before.hand[0].statuses = [{kind: 'destroy', source_name: '摧毁标记', description: '本场战斗结束后摧毁'}];
  final.hand = final.hand.filter(card => card.instance_id !== 'CI-1');
  if (protectedHero) final.discard.unshift({instance_id: 'CI-1', card_id: 'TS-0001'});
  final.event_log = [{kind: 'battle_resolved', target_card_id: 'TS-0476', outcome: 'win'},
    {kind: protectedHero ? 'card_destruction_replaced' : 'card_destroyed', player_id: 'alice', card_id: 'TS-0001',
      cause: 'after_battle', ...(protectedHero ? {source: 'hand', destination: 'discard'} : {})},
    ...final.event_log].map((event, i) => ({...event, sequence: i + 1}));
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match');
  assert.match(ui.get('match-deck-response-progress').textContent, /4\/5 结算战斗/);
  if (protectedHero) {
    const first = ui.animations.find(animation => animation.element.className === 'card-flight');
    assert.equal(first.element.children[0].dataset.cardId, 'TS-0001');
    assert.equal(ui.animations.some(animation => animation.element.className === 'card-destruction'), false);
  } else {
    assert.equal(ui.get('match-deck-card-motion-layer').children[0].className, 'card-destruction');
    assert.equal(ui.animations.some(animation => animation.element.className === 'card-flight'), false);
  }
  await ui.advance(10000);
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-destruction').length, protectedHero ? 0 : 1);
  assert.equal(ui.get('match-deck-discard-count').textContent, protectedHero ? '2' : '1');
  assert.match(ui.get('match-deck-response-progress').textContent, /5\/5 结束回合/);
  await ui.click('refresh-match');
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-destruction').length, protectedHero ? 0 : 1); ui.cleanup();
});

function extraRankBattleViews(won = true, lane = 'main') {
  const {before, final} = dungeonVisualViews();
  before.cards['TS-0571'] = {...before.cards['TS-0476'], card_id: 'TS-0571', name: '额外阶层怪物'};
  before.dungeons[0].id = lane;
  before.dungeons[0].hall[0].card_id = 'TS-0571';
  before.dungeons[0].rank_count = 4;
  before.dungeons[0].hall.push({rank: 4, instance_id: 'hall-4', card_id: 'TS-0476'});
  final.cards = structuredClone(before.cards); final.dungeons = [{...structuredClone(before.dungeons[0]), rank_count: 3,
    deck_count: before.dungeons[0].deck_count + (won ? 0 : 1),
    hall: before.dungeons[0].hall.slice(1).map((card, i) => ({...card, rank: i + 1}))}];
  final.discard = won ? [{instance_id: 'CI-3', card_id: 'TS-0571'}] : [];
  final.event_log = [{sequence: 1, kind: won ? 'monster_defeated' : 'monster_returned_to_deck', card_id: 'TS-0571',
    ...(won ? {player_id: 'alice'} : {deck_zone: `dungeon:${lane}`, position: 'bottom'}), hall_zone: `hall:${lane}`, rank: 1, hall_rank_count: 3}];
  return {before, final};
}

const rankGhosts = ui => ui.all.filter(node => node.className === 'dungeon-rank-ghost' && node.isConnected);
const publicFlights = ui => ui.animations.filter(animation => animation.element.className === 'card-flight');

for (const won of [true, false]) test(`an extra rank disappears only after its monster flies ${won ? 'into discard' : 'back to the dungeon'}`, async () => {
  const {before, final} = extraRankBattleViews(won), ui = await page({view: before, animationsEnabled: true});
  ui.setView(final); await ui.click('refresh-match');
  assert.equal(publicFlights(ui).length, 1);
  assert.equal(publicFlights(ui)[0].element.children[0].dataset.cardId, 'TS-0571');
  assert.equal(rankGhosts(ui).length, 0, 'the slot remains until departure finishes');
  assert.equal(ui.get('match-public-dungeon-cards-deck-main-slot').dataset.count, '10');
  await ui.advance(250);
  assert.equal(rankGhosts(ui).length, 1); assert.equal(rankGhosts(ui)[0].dataset.rank, '4');
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-4').isConnected, false);
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0].dataset.instanceId, 'hall-2');
  assert.equal(ui.get('match-public-dungeon-cards-deck-main-slot').dataset.count, won ? '10' : '11');
  await ui.advance(1000);
  assert.equal(rankGhosts(ui).length, 0); assert.equal(publicFlights(ui).length, 1, 'shrinking a full hall must not invent a refill');
  assert.equal(ui.get('match-deck-discard-count').textContent, won ? '1' : '0');
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false); ui.cleanup();
});

test('a loss returns the monster before the remaining hall advances and a new card flips in', async () => {
  const {before, final} = dungeonVisualViews(); final.discard = []; final.dungeons[0].deck_count = 10;
  final.event_log[0] = {sequence: 1, kind: 'monster_returned_to_deck', card_id: 'TS-0476', hall_zone: 'hall:main',
    deck_zone: 'dungeon:main', rank: 1, position: 'bottom', hall_rank_count: 3};
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match');
  assert.equal(publicFlights(ui).length, 1); assert.equal(publicFlights(ui)[0].element.children[0].dataset.cardId, 'TS-0476');
  await ui.advance(250); assert.equal(publicFlights(ui).length, 2);
  assert.equal(publicFlights(ui)[1].element.children[0].dataset.cardId, 'TS-0477');
  await ui.advance(2000); assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-3').children[1].children[0].dataset.instanceId, 'hall-new');
  ui.cleanup();
});

test('a newly revealed extra-rank monster opens its slot before the following card is drawn', async () => {
  const {before, final} = dungeonVisualViews(); before.dungeons[0].hall = before.dungeons[0].hall.slice(0, 2);
  before.cards['TS-0571'] = {...before.cards['TS-0476'], card_id: 'TS-0571', name: '额外阶层怪物'};
  final.cards = structuredClone(before.cards); final.discard = [];
  final.dungeons[0] = {...before.dungeons[0], rank_count: 4, deck_count: 8, hall: [...before.dungeons[0].hall,
    {rank: 3, instance_id: 'new-extra', card_id: 'TS-0571'}, {rank: 4, instance_id: 'new-four', card_id: 'TS-0476'}]};
  final.event_log = [{sequence: 1, kind: 'hall_card_entered', card_id: 'TS-0571', hall_zone: 'hall:main', rank: 3, hall_rank_count: 4},
    {sequence: 2, kind: 'hall_card_entered', card_id: 'TS-0476', hall_zone: 'hall:main', rank: 4, hall_rank_count: 4}];
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match');
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-4').isConnected, true);
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-4').children[1].children[0].className, 'hall-empty');
  assert.ok(ui.animations.some(animation => animation.element.id === 'match-public-dungeon-cards-main-rank-4'));
  assert.equal(publicFlights(ui).length, 1);
  await ui.advance(250); assert.equal(publicFlights(ui).length, 2);
  await ui.advance(2000); assert.equal(ui.get('match-public-dungeon-cards-main-rank-4').children[1].children[0].dataset.instanceId, 'new-four');
  ui.cleanup();
});

test('extra rank changes and retreat target only their named dungeon in a flying-spire game', async () => {
  const {before, final} = extraRankBattleViews(false, 'b');
  const a = {id: 'a', deck_count: 7, rank_count: 3, hall: [{rank: 1, instance_id: 'a-kept', card_id: 'TS-0476'}]};
  before.dungeons.unshift(a); final.dungeons.unshift(structuredClone(a));
  const ui = await page({view: before, animationsEnabled: true}), kept = ui.get('match-public-dungeon-cards-a-rank-1').children[1].children[0];
  ui.setView(final); await ui.click('refresh-match'); await ui.advance(250);
  assert.equal(rankGhosts(ui).length, 1); assert.equal(ui.get('match-public-dungeon-cards-b-rank-4').isConnected, false);
  assert.equal(ui.get('match-public-dungeon-cards-deck-a-slot').dataset.count, '7');
  assert.equal(ui.get('match-public-dungeon-cards-deck-b-slot').dataset.count, '11');
  await ui.advance(1000); assert.equal(ui.get('match-public-dungeon-cards-a-rank-1').children[1].children[0], kept); ui.cleanup();
});

test('interrupting a shrinking hall cleans its ghost slots and cannot restore stale ranks later', async () => {
  const {before, final} = extraRankBattleViews(), ui = await page({view: before, animationsEnabled: true});
  ui.setView(final); await ui.click('refresh-match'); await ui.advance(250); assert.equal(rankGhosts(ui).length, 1);
  ui.window.fire('blur'); await settle(); assert.equal(rankGhosts(ui).length, 0);
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-4').isConnected, false);
  await ui.advance(3000); assert.equal(ui.get('match-public-dungeon-cards-main-rank-4').isConnected, false);
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false); ui.cleanup();
});

test('an empty rank change without a departure event still animates the layout', async () => {
  const {before, final} = dungeonVisualViews(); before.dungeons[0].rank_count = 4;
  final.dungeons = structuredClone(before.dungeons); final.dungeons[0].rank_count = 3; final.discard = []; final.event_log = [];
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match');
  assert.equal(rankGhosts(ui).length, 1); assert.equal(publicFlights(ui).length, 0);
  await ui.advance(1000); assert.equal(rankGhosts(ui).length, 0); assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false); ui.cleanup();
});

function diseaseViews() {
  const before = fixture(); before.turn.chosen_action = 'village'; before.turn.subphase = 'VILLAGE_ABILITIES'; before.legal_commands = [{type: 'FinishAbilities'}];
  const pending = structuredClone(before); pending.version++;
  pending.abilities['TS-0423-A02'] = {source_card_id: 'TS-0423', source_line: '将疾病交给另一位玩家。'};
  pending.pending_choice = {kind: 'disease_replacement', player_id: 'alice', can_resolve: true, stage: 'recipient', ability_id: 'TS-0423-A02'};
  pending.pending_disease = {gain_id: 'DG-1', card_id: 'TS-0714', player_id: 'alice'};
  pending.legal_commands = [{type: 'ResolveDiseaseReplacement', stage: 'recipient', options: ['bob'], may_decline: true}];
  pending.event_log = [{sequence: 1, kind: 'disease_gain_started', gain_id: 'DG-1', card_id: 'TS-0714', player_id: 'alice', destination: 'discard'}];
  const done = structuredClone(before); done.version += 2; done.pending_disease = null;
  done.discard = [{instance_id: 'disease-new', card_id: 'TS-0714'}];
  done.event_log = [...pending.event_log, {sequence: 2, kind: 'disease_gain_completed', gain_id: 'DG-1', card_id: 'TS-0714', player_id: 'alice', destination: 'discard'}];
  return {before, pending, done};
}

for (const mode of ['visible', 'offscreen', 'village', 'different-card']) test(`disease origin temporarily frames its actual source, then restores the viewport: ${mode}`, async () => {
  const {before, done} = diseaseViews(); done.version = 2;
  Object.assign(done.event_log[0], {source_card_id: mode === 'different-card' ? 'TS-0477' : 'TS-0476', source_hall_zone: 'hall:main', source_rank: 1});
  const ui = await page({view: before, animationsEnabled: true});
  const target = ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0];
  const body = descendants(target).find(node => node.className === 'card-body');
  const left = mode === 'offscreen' ? -700 : 280;
  body.getBoundingClientRect = () => ({left, top: 200, width: 144, height: 201, right: left + 144, bottom: 401});
  if (mode === 'village') await ui.click('match-public-village-tab');
  ui.setView(done); await ui.click('refresh-match');
  assert.equal(diseaseBirths(ui).length, 1);
  const birth = diseaseBirths(ui)[0];
  assert.equal(birth.element.style.left === `${left}px`, mode !== 'different-card');
  await ui.advance(760);
  if (mode === 'visible') {
    const flight = ui.animations.find(animation => animation.element.className === 'card-flight');
    assert.ok(flight); assert.equal(flight.element.style.left, '280px');
    assert.equal(flight.element.children[0].dataset.cardId, 'TS-0714');
    assert.equal(ui.get('match-deck-discard-count').textContent, '0');
    await ui.advance(250); assert.equal(ui.get('match-deck-discard-count').textContent, '0', 'hold disease at center before arrival');
  }
  await ui.advance(2000); assert.equal(ui.get('match-deck-discard-count').textContent, '1');
  if (mode === 'village') assert.equal(ui.get('match-public-village-tab').getAttribute('aria-selected'), 'true');
  assert.equal(diseaseBirths(ui).length, 1); ui.cleanup();
});

for (const elapsed of [200, 800, 1100]) test(`interrupting monster-origin disease animation at ${elapsed}ms settles delivery once`, async () => {
  const {before, done} = diseaseViews(); done.version = 2;
  Object.assign(done.event_log[0], {source_card_id: 'TS-0476', source_hall_zone: 'hall:main', source_rank: 1});
  const ui = await page({view: before, animationsEnabled: true});
  const target = ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0];
  descendants(target).find(node => node.className === 'card-body').getBoundingClientRect = () => ({left: 280, top: 200, width: 144, height: 201, right: 424, bottom: 401});
  ui.setView(done); await ui.click('refresh-match'); await ui.advance(elapsed);
  ui.window.fire('blur'); await settle();
  assert.equal(ui.get('match-deck-discard-count').textContent, '1');
  assert.equal(ui.all.some(node => node.className === 'card-flight' && node.isConnected), false);
  assert.equal(ui.all.some(node => node.className === 'public-card-spotlight' && !node.hidden), false);
  await ui.advance(2000); assert.equal(ui.get('match-deck-discard-count').textContent, '1');
  assert.equal(diseaseBirths(ui).length, 1); ui.cleanup();
});

test('disease is generated at center before flying to discard, without switching the public tab or exposing a shuffle', async () => {
  const {before, done} = diseaseViews(); done.version = 2;
  const ui = await page({view: before, animationsEnabled: true}); await ui.click('match-public-village-tab');
  ui.setView(done); await ui.click('refresh-match');
  assert.equal(diseaseBirths(ui).length, 1); assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  assert.equal(ui.get('match-deck-response-FinishAbilities').disabled, true);
  await ui.advance(760);
  assert.equal(ui.get('match-deck-card-motion-layer').children[0].children[0].dataset.cardId, 'TS-0714');
  await ui.advance(300);
  assert.equal(ui.get('match-deck-discard-count').textContent, '1'); assert.equal(diseaseBirths(ui).length, 1);
  assert.equal(ui.get('match-public-village-tab').attributes['aria-selected'], 'true');
  assert.equal(ui.get('match-deck-response-FinishAbilities').disabled, false); ui.cleanup();
});

test('a pending disease stays at center, highlights only legal players and can be skipped into the own discard pile', async () => {
  const {before, pending, done} = diseaseViews();
  const ui = await page({view: before, animationsEnabled: true, post: () => done});
  ui.setView(pending); await ui.click('refresh-match');
  assert.equal(playerRow(ui, 'bob').children[0].disabled, true);
  await ui.advance(760);
  assert.equal(playerRow(ui, 'bob').dataset.selectable, 'true'); assert.equal(playerRow(ui, 'alice').dataset.selectable, 'false');
  assert.deepEqual(responseButtons(ui).map(button => button.textContent), ['跳过']);
  assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  const center = ui.all.find(node => node.className === 'public-card-spotlight' && !node.hidden); assert.ok(center);
  center.children[0].fire('pointerenter'); ui.key(' ');
  assert.ok(ui.all.some(node => node.className.split(' ').includes('game-card-inspection') && !node.hidden)); ui.release();
  await ui.click('refresh-match'); assert.equal(diseaseBirths(ui).length, 1);
  playerRow(ui, 'alice').children[0].fire('click'); assert.equal(posts(ui).length, 0);
  await ui.click('match-deck-response-effect:0');
  assert.deepEqual(posts(ui)[0].body.command, {type: 'ResolveDiseaseReplacement', source_instance_id: null, recipient_id: null});
  await ui.advance(300);
  assert.equal(ui.get('match-deck-discard-count').textContent, '1'); assert.equal(diseaseBirths(ui).length, 1);
  assert.equal(playerRow(ui, 'bob').dataset.selectable, undefined);
  assert.equal(ui.all.some(node => node.className === 'public-card-spotlight' && !node.hidden), false); ui.cleanup();
});

test('disease redirection selects the player row and flies to that player without entering the sender discard', async () => {
  const {before, pending, done} = diseaseViews(); done.discard = [];
  done.event_log = [...pending.event_log, {sequence: 2, kind: 'disease_redirected', gain_id: 'DG-1', card_id: 'TS-0714', from_player_id: 'alice', to_player_id: 'bob'},
    {sequence: 3, kind: 'disease_gain_completed', gain_id: 'DG-1', card_id: 'TS-0714', player_id: 'bob', destination: 'discard'}];
  const ui = await page({view: before, animationsEnabled: true, post: () => done});
  ui.setView(pending); await ui.click('refresh-match'); await ui.advance(760);
  playerRow(ui, 'bob').children[0].fire('click'); await settle();
  assert.deepEqual(posts(ui)[0].body.command, {type: 'ResolveDiseaseReplacement', source_instance_id: null, recipient_id: 'bob'});
  assert.equal(ui.get('match-public-player-browser').hidden, true);
  await ui.advance(400); assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  assert.equal(diseaseBirths(ui).length, 1); assert.equal(ui.all.some(node => node.className === 'public-card-spotlight' && !node.hidden), false); ui.cleanup();
});

test('reconnecting during a disease response restores its public central card without replaying generation or exposing other actors controls', async () => {
  const {pending} = diseaseViews(); pending.actor_player_id = 'bob'; pending.pending_choice.player_id = 'bob'; pending.pending_choice.can_resolve = false;
  pending.pending_disease.player_id = 'bob'; pending.legal_commands = [];
  const ui = await page({view: pending, animationsEnabled: true});
  assert.equal(diseaseBirths(ui).length, 0); assert.equal(responseButtons(ui).length, 0);
  assert.ok(ui.all.some(node => node.className === 'public-card-spotlight' && !node.hidden));
  playerRow(ui, 'alice').children[0].fire('click'); assert.equal(posts(ui).length, 0); ui.cleanup();
});

test('cancelling a match clears a pending central disease and player selection without waiting for another command', async () => {
  const {pending} = diseaseViews(), ui = await page({view: pending, animationsEnabled: true});
  assert.ok(ui.all.some(node => node.className === 'public-card-spotlight' && !node.hidden));
  const cancelled = structuredClone(pending); cancelled.version++; cancelled.status = 'cancelled'; cancelled.pending_choice = null; cancelled.pending_disease = null; cancelled.legal_commands = [];
  ui.setView(cancelled); await ui.click('refresh-match');
  assert.equal(ui.all.some(node => node.className === 'public-card-spotlight' && !node.hidden), false);
  assert.equal(playerRow(ui, 'bob').dataset.selectable, undefined); ui.cleanup();
});

test('automatic plague removal generates and destroys the disease without a discard arrival', async () => {
  const {before, done} = diseaseViews(); done.version = 2; done.discard = [];
  done.event_log[1] = {sequence: 2, kind: 'disease_gain_destroyed', gain_id: 'DG-1', card_id: 'TS-0714'};
  done.event_log.push({sequence: 3, kind: 'card_destroyed', card_id: 'TS-0714', player_id: 'alice', cause: 'disease_gain'});
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(done); await ui.click('refresh-match');
  await ui.advance(760); assert.ok(ui.animations.some(animation => animation.element.className === 'card-destruction'));
  await ui.advance(5000); assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-destruction').length, 1);
  assert.equal(diseaseBirths(ui).length, 1); assert.equal(ui.get('match-deck-response-FinishAbilities').disabled, false); ui.cleanup();
});

for (const auxiliary of [false, true]) test(`Tyxr selection destroys the hero, gains the monster and reveals treasure before refill: auxiliary tab ${auxiliary}`, async () => {
  const {before, final} = dungeonVisualViews('treasure');
  before.cards['TS-0666'] = {...before.cards['TS-0476'], card_id: 'TS-0666', name: '远古泰尔'};
  before.cards['TS-0700'] = final.cards['TS-0700']; final.cards = structuredClone(before.cards);
  before.hand[1].card_id = 'TS-0001'; final.hand = [structuredClone(before.hand[1])];
  before.dungeons[0].hall[0].card_id = 'TS-0666'; final.discard[0].card_id = 'TS-0666'; final.event_log[0].card_id = 'TS-0666';
  before.pending_choice = {kind: 'effect_select', player_id: 'alice', can_resolve: true, ability_id: 'TS-0666-A02'};
  before.legal_commands = [{type: 'ResolveChoice', instance_ids: ['CI-1', 'CI-2'], min_count: 1, max_count: 1}];
  final.pending_choice = null;
  final.event_log = [{kind: 'battle_resolved', target_card_id: 'TS-0666', outcome: 'win', rank: 1, health: 10},
    {kind: 'card_destroyed', card_id: 'TS-0001', player_id: 'alice'}, ...final.event_log].map((event, i) => ({...event, sequence: i + 1}));
  if (auxiliary) {
    before.players[0].control = [{instance_id: 'old-treasure', card_id: 'TS-0700'}];
    final.players[0].control.unshift({instance_id: 'old-treasure', card_id: 'TS-0700'});
  }
  let finish;
  const ui = await page({view: before, animationsEnabled: true, post: () => new Promise(resolve => {finish = () => resolve(final);} )});
  handCard(ui, 'CI-1').fire('click'); await settle();
  assert.equal(posts(ui).length, 1);
  if (auxiliary) await ui.click('match-deck-treasures-tab');
  finish(); await settle();
  assert.ok(ui.animations.some(animation => animation.element.className === 'card-destruction'));
  assert.equal(ui.animations.some(animation => animation.element.className === 'card-flight'), false, 'hero must finish destruction before monster movement');
  assert.match(ui.get('match-deck-response-progress').textContent, /4\/5 结算战斗/);
  assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  await ui.click('refresh-match'); await ui.advance(10000);
  const animations = ui.animations.filter(animation => ['card-destruction', 'card-flight'].includes(animation.element.className));
  assert.equal(animations[0].element.className, 'card-destruction');
  assert.equal(animations.filter(animation => animation.element.className === 'card-destruction').length, 1);
  assert.equal(animations.filter(animation => animation.element.className === 'card-flight').length, 4);
  assert.deepEqual(handCards(ui).map(card => card.dataset.instanceId), ['CI-2']);
  assert.equal(ui.get('match-deck-discard-count').textContent, '1');
  assert.equal(ui.get('match-deck-treasures-tab').attributes['aria-selected'], 'true');
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-3').children[1].children[0].dataset.instanceId, 'hall-new');
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false); ui.cleanup();
});

function trapViews() {
  const {before, final} = dungeonVisualViews('trap'), pending = structuredClone(final);
  pending.hand = structuredClone(before.hand); pending.turn.subphase = 'BATTLE_AFTER_EFFECTS';
  pending.pending_choice = {kind: 'trap_activation', player_id: 'alice', can_resolve: true};
  pending.legal_commands = [{type: 'ResolveTrap', instance_ids: ['hall-trap']}];
  pending.event_log = final.event_log.slice(0, 2);
  pending.dungeons[0].hall = [...final.dungeons[0].hall.slice(0, 2), {rank: 3, instance_id: 'hall-trap', card_id: 'TS-0700'}];
  pending.dungeons[0].deck_count = 9; final.version++;
  return {before, pending, final};
}
const trapCard = ui => ui.get('match-public-dungeon-cards-main-rank-3').children[1].children[0];
const shownSpotlight = ui => ui.all.find(node => node.className === 'public-card-spotlight' && !node.hidden);
const dismissals = ui => ui.animations.filter(animation => animation.element.className === 'public-card-spotlight'
  && animation.keyframes.some(frame => frame.filter === 'saturate(0) blur(3px)'));

test('a trap enters the hall and requires a deliberate click, even as the only legal target', async () => {
  const {before, pending, final} = trapViews();
  const ui = await page({view: before, animationsEnabled: true, post: () => final});
  ui.setView(pending); await ui.click('refresh-match');
  assert.equal(posts(ui).length, 0);
  await ui.advance(250); assert.equal(posts(ui).length, 0);
  await ui.advance(2000);
  assert.equal(posts(ui).length, 0); assert.equal(shownSpotlight(ui), undefined);
  assert.equal(trapCard(ui).dataset.instanceId, 'hall-trap'); assert.equal(trapCard(ui).dataset.glowing, 'true');
  assert.deepEqual(responseButtons(ui), []);
  await ui.click('match-public-village-tab'); assert.equal(ui.get('match-public-dungeon-tab').dataset.attention, 'true');
  await ui.click('match-public-dungeon-tab');
  trapCard(ui).fire('click'); await settle();
  assert.deepEqual(posts(ui).map(row => row.body.command), [{type: 'ResolveTrap', instance_id: 'hall-trap'}]);
  await ui.advance(8000); assert.equal(posts(ui).length, 1); ui.cleanup();
});

test('a trap stays in the hall through its choice, then fades there after the victim is destroyed and before refill', async () => {
  const {before, pending: waiting, final} = trapViews(), pending = structuredClone(waiting);
  pending.version++; final.version++;
  pending.pending_choice = {kind: 'effect_select', player_id: 'alice', can_resolve: true};
  pending.legal_commands = [{type: 'ResolveChoice', instance_ids: ['CI-1', 'CI-2'], min_count: 1, max_count: 1}];
  const ui = await page({view: before, animationsEnabled: true, post: (_url, body) => body.command.type === 'ResolveTrap' ? pending : final});
  ui.setView(waiting); await ui.click('refresh-match'); await ui.advance(2000);
  trapCard(ui).fire('click'); await settle();
  assert.equal(trapCard(ui).dataset.instanceId, 'hall-trap');
  assert.equal(ui.animations.some(animation => animation.element.className === 'card-destruction'), false);
  assert.equal(shownSpotlight(ui), undefined); assert.deepEqual(glowing(ui), ['CI-1', 'CI-2']);
  handCard(ui, 'CI-1').fire('click'); await settle();
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-destruction').length, 1);
  assert.equal(trapCard(ui).dataset.instanceId, 'hall-trap'); assert.equal(dismissals(ui).length, 0);
  await ui.advance(8000);
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-destruction').length, 1);
  assert.equal(dismissals(ui).length, 1);
  assert.equal(shownSpotlight(ui), undefined); assert.equal(trapCard(ui).dataset.instanceId, 'hall-new');
  assert.match(ui.get('match-deck-response-progress').textContent, /5\/5 结束回合/); ui.cleanup();
  for (const actor of [true, false]) {
    const view = structuredClone(waiting);
    if (!actor) {view.viewer_player_id = 'bob'; view.pending_choice.can_resolve = false; view.legal_commands = [];}
    const reconnected = await page({view, animationsEnabled: true});
    assert.equal(shownSpotlight(reconnected), undefined); assert.equal(trapCard(reconnected).dataset.instanceId, 'hall-trap');
    assert.equal(trapCard(reconnected).dataset.glowing, String(actor));
    assert.equal(reconnected.animations.length, 0); assert.equal(posts(reconnected).length, 0);
    if (!actor) {trapCard(reconnected).fire('click'); await settle(); assert.equal(posts(reconnected).length, 0);}
    reconnected.cleanup();
  }
});

test('a single mandatory effect target auto-resolves only after the trap has been clicked', async () => {
  const {pending: waiting, final} = trapViews(), pending = structuredClone(waiting); pending.version++; final.version++;
  pending.pending_choice = {kind: 'effect_select', player_id: 'alice', can_resolve: true};
  pending.legal_commands = [{type: 'ResolveChoice', instance_ids: ['CI-1'], min_count: 1, max_count: 1}];
  const ui = await page({view: waiting, animationsEnabled: true, post: (_url, body) => body.command.type === 'ResolveTrap' ? pending : final});
  assert.equal(posts(ui).length, 0); trapCard(ui).fire('click'); await settle();
  assert.deepEqual(posts(ui).map(row => row.body.command), [{type: 'ResolveTrap', instance_id: 'hall-trap'}, {type: 'ResolveChoice', instance_ids: ['CI-1']}]);
  await ui.advance(8000); assert.equal(posts(ui).length, 2); ui.cleanup();
});

for (const versionGap of [1, 2, 4]) test(`battle victory flies the defeated monster before refill and never replays a refresh: version gap ${versionGap}`, async () => {
  const {before, final} = dungeonVisualViews(), ui = await page({view: before, animationsEnabled: true});
  final.version = before.version + versionGap;
  // Real DOMRect geometry lives on prototype getters, unlike a plain test object.
  class BrowserRect {
    get left() {return 111;} get top() {return 132;} get width() {return 160;} get height() {return 224;}
    get right() {return this.left + this.width;} get bottom() {return this.top + this.height;}
  }
  const source = ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0];
  descendants(source).find(node => node.className === 'card-body').getBoundingClientRect = () => new BrowserRect();
  ui.setView(final); await ui.click('refresh-match');
  assert.equal(ui.get('match-deck-discard-count').textContent, '0'); assert.equal(ui.get('match-deck-response-FinishTurn').disabled, true);
  assert.equal(ui.get('match-deck-card-motion-layer').children[0].children[0].dataset.cardId, 'TS-0476');
  assert.equal(ui.get('match-deck-card-motion-layer').children[0].style.left, '111px');
  assert.equal(ui.get('match-deck-card-motion-layer').children[0].style.width, '160px');
  await ui.click('refresh-match'); assert.equal(ui.animations.filter(animation => animation.element.className === 'card-flight').length, 1);
  await ui.advance(250); assert.equal(ui.get('match-deck-discard-count').textContent, '1');
  await ui.advance(2000);
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0].dataset.instanceId, 'hall-2');
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-3').children[1].children[0].dataset.instanceId, 'hall-new');
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false);
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-flight').length, 2); ui.cleanup();
});

test('game results wait for the last monster flight and hall refill before becoming modal', async () => {
  const {before, final} = dungeonVisualViews();
  final.status = 'finished'; final.actor_player_id = null; final.legal_commands = [];
  final.turn.phase = 'SETTLING'; final.turn.subphase = 'GAME_END';
  final.result = {winner_ids: ['alice'], tie_break: null, players: {
    alice: {victory_points: 12, card_victory_points: 9, experience_points: 3, thunderstones: 1, eliminated: false},
    bob: {victory_points: 8, card_victory_points: 6, experience_points: 2, thunderstones: 0, eliminated: false},
  }};
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match');
  const dialog = descendants(ui.get('match-overlays')).find(node => node.className.split(' ').includes('game-results'));
  assert.equal(dialog.hidden, true); assert.equal(ui.get('match-content').inert, false);
  await ui.advance(250); assert.equal(dialog.hidden, true);
  await ui.advance(3000); assert.equal(dialog.hidden, false); assert.equal(ui.get('match-content').inert, true);
  assert.equal(ui.get('match-deck-discard-count').textContent, '1'); ui.cleanup();
});

test('a claimed treasure is revealed centrally, switches to the treasure tab and flies into control before the hall refill', async () => {
  const {before, final} = dungeonVisualViews('treasure'), ui = await page({view: before, animationsEnabled: true});
  ui.setView(final); await ui.click('refresh-match'); await ui.advance(250);
  const spotlight = ui.all.find(node => node.className === 'public-card-spotlight' && !node.hidden);
  assert.ok(spotlight); assert.equal(ui.get('match-deck-response-FinishTurn').disabled, true);
  await ui.advance(750);
  assert.equal(ui.get('match-deck-treasures-tab').attributes['aria-selected'], 'true');
  assert.equal(ui.get('match-deck-card-motion-layer').children[0].children[0].dataset.instanceId, 'treasure-new');
  await ui.advance(3000);
  assert.equal(ui.get('match-deck-treasures-track').children.filter(card => card.dataset.instanceId === 'treasure-new').length, 1);
  assert.equal(ui.get('match-deck-discard-count').textContent, '1'); assert.equal(handCards(ui).some(card => card.dataset.instanceId === 'treasure-new'), false);
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false); ui.cleanup();
});

test('coalesced trap events never show it at center; interruptions snap to the committed result', async () => {
  const {before, final} = dungeonVisualViews('trap'), ui = await page({view: before, animationsEnabled: true});
  ui.setView(final); await ui.click('refresh-match'); await ui.advance(250);
  assert.equal(shownSpotlight(ui), undefined);
  assert.equal(ui.animations.some(animation => animation.element.className === 'card-destruction'), false);
  await ui.advance(750);
  assert.equal(ui.get('match-deck-card-motion-layer').children[0].className, 'card-destruction');
  ui.window.fire('blur'); await settle();
  assert.deepEqual(handCards(ui).map(card => card.dataset.instanceId), ['CI-2']);
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-3').children[1].children[0].dataset.instanceId, 'hall-new');
  assert.equal(ui.get('match-deck-card-motion-layer').children.length, 0); assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false);
  await ui.advance(5000); assert.deepEqual(handCards(ui).map(card => card.dataset.instanceId), ['CI-2']); ui.cleanup();
});

test('a trap can destroy the monster just gained into discard before the next hall card is revealed', async () => {
  const {before, final} = dungeonVisualViews('trap'); final.hand = structuredClone(before.hand); final.discard = [];
  final.event_log.find(event => event.kind === 'card_destroyed').card_id = 'TS-0476';
  final.event_log[0].hall_zone = 'hall:main'; final.event_log[0].rank = 1;
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match');
  await ui.advance(250); assert.equal(ui.get('match-deck-discard-count').textContent, '1');
  await ui.advance(750); assert.equal(ui.get('match-deck-card-motion-layer').children[0].className, 'card-destruction');
  await ui.advance(8000); assert.equal(ui.get('match-deck-discard-count').textContent, '0');
  assert.deepEqual(handCards(ui).map(card => card.dataset.instanceId), ['CI-1', 'CI-2']);
  assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false); ui.cleanup();
});

test('a newer snapshot cancels the old treasure presentation and cannot later reintroduce that treasure', async () => {
  const {before, final} = dungeonVisualViews('treasure'), ui = await page({view: before, animationsEnabled: true});
  ui.setView(final); await ui.click('refresh-match'); await ui.advance(300);
  const newer = structuredClone(final); newer.version++; newer.players[0].control = []; newer.event_log.push({sequence: 5, kind: 'card_destroyed', player_id: 'alice', card_id: 'TS-0700'});
  ui.setView(newer); await ui.click('refresh-match'); await ui.advance(6000);
  assert.equal(ui.get('match-deck-treasures-tab').hidden, true); assert.equal(ui.get('match-deck-response-FinishTurn').disabled, false);
  assert.equal(ui.all.some(node => node.className === 'public-card-spotlight' && !node.hidden), false); ui.cleanup();
});

test('flying-spire refill animates the named dungeon while the other hall stays unchanged', async () => {
  const {before, final} = dungeonVisualViews();
  before.dungeons[0].id = 'a'; final.dungeons[0].id = 'a';
  const b = {id: 'b', deck_count: 4, hall: [{rank: 1, instance_id: 'b-monster', card_id: 'TS-0476'}]};
  before.dungeons.push(b); final.dungeons = [structuredClone(before.dungeons[0]), {id: 'b', deck_count: 3, hall: [{rank: 1, instance_id: 'b-new', card_id: 'TS-0477'}]}];
  final.discard = [{instance_id: 'b-monster', card_id: 'TS-0476'}];
  final.event_log[0].hall_zone = 'hall:b'; final.event_log[0].rank = 1;
  Object.assign(final.event_log.at(-1), {hall_zone: 'hall:b', rank: 1});
  const ui = await page({view: before, animationsEnabled: true}); ui.setView(final); await ui.click('refresh-match'); await ui.advance(3000);
  assert.equal(ui.get('match-public-dungeon-cards-a-rank-1').children[1].children[0].dataset.instanceId, 'CI-3');
  assert.equal(ui.get('match-public-dungeon-cards-b-rank-1').children[1].children[0].dataset.instanceId, 'b-new');
  assert.equal(ui.get('match-deck-discard-count').textContent, '1'); ui.cleanup();
});

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
    ['dungeon', 'BATTLE_COMMIT', null, 2, '构建战斗队伍'],
    ['dungeon', 'DUNGEON_DECLARE', null, 3, '宣言战斗'],
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
  eligible.fire('pointerenter'); ui.key(' '); assert.equal(ui.get('match-deck-inspect-overlay').hidden, false); ui.release();
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
  await settle(); assert.match(ui.get('match-deck-player-response').textContent, /连接失败/); assert.deepEqual(glowing(ui), ['CI-1', 'CI-2']);
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

test('table hand clicks update local battle preview while hall targets stay inactive during preparation', async () => {
  const {view, f} = battleView(), ui = await page({view});
  const [hero, , spell] = f.hand;
  const card = id => handCards(ui).find(card => card.dataset.instanceId === id);
  assert.equal(card(hero).dataset.selected, 'false');
  cardAction(ui, hero, '出阵'); assert.equal(card(hero).dataset.selected, 'true');
  assert.match(combatText(ui), /攻击 1/);
  cardAction(ui, spell, '使用'); assert.match(combatText(ui), /魔法攻击 3/);
  cardAction(ui, hero, '撤回出阵');
  assert.match(combatText(ui), /攻击 0/);
  ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0].fire('click');
  assert.equal(ui.get('match-public-dungeon-cards-main-rank-1').children[1].children[0].dataset.active, 'false');
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
  assert.equal(bubble.textContent, '展示了手牌'); assert.equal(bubble.dataset.playerId, 'bob');
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

test('draw and discard browsers retain probe sorting, Space inspection and external snapshot updates', async () => {
  const view = graphicalView(), ui = await page({view});
  ui.get('match-deck-draw-pile').children.find(node => node.dataset.instanceId).fire('click'); await settle();
  const cards = () => descendants(ui.get('match-deck-pile-browser-grid')).filter(node => node.className === 'physical-card' && !node.hidden);
  assert.deepEqual(cards().map(card => card.dataset.cardId), ['TS-0001', 'TS-0301']);
  cards()[0].fire('pointerenter'); ui.key(' '); assert.equal(ui.get('match-deck-inspect-overlay').hidden, false); ui.release();
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
