"""User-reviewed monster symbols and notes, exercised in the current TS engine."""
from dataclasses import asdict, replace
import hashlib
import json
from pathlib import Path
import unittest

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.app.integrations.game_engine.shared.client import client
from backend.app.integrations.game_engine.shared.projection import calculation_input
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.turn import apply_command
from devtools.monster_audit import monster_audit_data
from tests.mechanic_cases import Fixture
from tests.test_setup_engine import config, request

ROOT = Path(__file__).resolve().parents[1]


class MonsterReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.cards = cls.snapshot.cards
        cls.rules = load_ruleset(cls.cards)
        settings = config()
        settings['selection']['dungeon_features']['mode'] = 'manual'
        req = request(settings, seed='monster-reviewed-symbols')
        req.update(player_ids=['alice', 'bob'], first_player={'mode': 'fixed', 'player_id': 'alice'})
        cls.base = start_game(req, snapshot=cls.snapshot)['state']

    def fixture(self):
        f = Fixture(self.base, self.cards, self.rules, self.rules.mechanics[0])
        f.tx.ruleset = self.rules
        f.tx.state['active_settings'] = []
        for zone in list(f.tx.state['zones']):
            if zone.startswith(('hall:', 'dungeon:')):
                f.tx.state['zones']['destroyed'].extend(f.tx.state['zones'][zone])
                f.tx.state['zones'][zone] = []
        return f

    def command(self, f, **command):
        return apply_command(f.tx.state, {'player_id': 'alice', **command}, snapshot=self.snapshot, effects=f.tx.ruleset)

    def activate(self, f, card_id):
        source = f.add(card_id)
        return self.command(f, type='ActivateAbility', ability_id=card_id + '-A01', source_instance_id=source)

    def calc(self, f, target=None, rank=1):
        return client.call('combat_values', {'input': calculation_input(f.tx.state, f.cards, f.tx.ruleset, target),
                                            'rank': rank, 'target': target})

    def event_plan(self, f, event):
        return client.call('plan_event_dispatch', {
            'evaluation': {'state': f.tx.state, 'cards': f.cards, 'mechanics': [asdict(m) for m in self.rules.mechanics]},
            'abilities': [asdict(a) for a in self.rules.abilities], 'listeners': [], 'scheduled': [],
            'event': event, 'turn_number': f.tx.state['turn_number'], 'repeatable_ability_ids': []})

    def test_every_monster_ability_has_a_symbol_decision_and_hand_scope_matches_it(self):
        audit = monster_audit_data()
        records = json.loads((ROOT / 'data/effects/monster-symbols.json').read_text(encoding='utf-8'))
        exported = ROOT / records['source_review']
        self.assertEqual(hashlib.sha256(exported.read_bytes()).hexdigest(), records['source_sha256'])
        entries = {a['ability_id']: a for c in audit['cards'] for a in c['abilities']}
        self.assertEqual(set(entries), set(records['abilities']))
        self.assertEqual(sum(r['symbol'] == 'present' for r in records['abilities'].values()), 36)
        for ability_id, entry in entries.items():
            with self.subTest(ability=ability_id):
                self.assertEqual(any(s.startswith('hand') for s in entry['scope_ids']),
                                 records['abilities'][ability_id]['symbol'] == 'present')
                self.assertFalse(entry['needs_symbol_check'])
                self.assertEqual(records['abilities'][ability_id]['applied_fingerprint'], entry['fingerprint'])
        # A pending UI status does not erase an explicit positive symbol review.
        self.assertEqual(records['abilities']['TS-0511-A01']['symbol'], 'present')

    def test_unmarked_light_is_only_applied_against_its_monster_and_not_from_hand_or_adjacent_hall(self):
        for card_id, amount in [('TS-0495', 1), ('TS-0566', -1), ('TS-0568', -1), ('TS-0570', -2), ('TS-0650', -1)]:
            with self.subTest(card=card_id):
                f = self.fixture()
                f.add('TS-0003')
                f.add(card_id, 'hall:main')
                baseline = self.calc(f)
                against = self.calc(f, self.cards[card_id])
                self.assertEqual(against['light'] - baseline['light'], amount)
                f.add(card_id)
                in_hand = self.calc(f)
                self.assertEqual(in_hand['light'] - baseline['light'], int(self.cards[card_id]['wiki_光照'] or 0))

    def test_swifttail_strength_penalty_applies_to_hand_heroes_only_when_it_is_the_target(self):
        f = self.fixture()
        hero = f.add('TS-0001')
        f.add('TS-0660')
        before = self.calc(f)
        against = self.calc(f, self.cards['TS-0660'])
        self.assertEqual(before['hero_strength'][hero], int(self.cards['TS-0001']['wiki_力量']))
        self.assertEqual(against['hero_strength'][hero], before['hero_strength'][hero] - 1)

    def test_blink_dog_light_penalty_is_in_preview_before_attack_eligibility(self):
        f = self.fixture()
        f.add('TS-0003')
        trace = self.calc(f, self.cards['TS-0650'])
        self.assertEqual(trace['light'], 0)
        self.assertFalse(trace['can_attack'])
        f.add('TS-0003')
        self.assertTrue(self.calc(f, self.cards['TS-0650'])['can_attack'])

    def test_swifttail_penalty_drops_overweight_weapons_before_battle_effects(self):
        f = self.fixture()
        hero = f.add('TS-0001')
        strength = int(self.cards['TS-0001']['wiki_力量'])
        weapon_card = next(c['card_id'] for c in self.cards.values()
                           if '武器' in c['tags'].split('|') and c['wiki_重量'] == str(strength))
        weapon = f.add(weapon_card)
        target = f.add('TS-0660', 'hall:main')
        f.tx.state['battle_context']['equipped_weapon_by_hero'] = {hero: weapon}
        f.tx.ruleset = replace(self.rules, abilities=(), mechanics=tuple(m for m in self.rules.mechanics if m.id == 'TS-0660-A01'))
        result = self.command(f, type='DeclareBattleTarget', target_instance_id=target)
        events = result['events']
        dropped = next(i for i, e in enumerate(events) if e['kind'] == 'weapon_dropped' and e['weapon_instance_id'] == weapon)
        declared = next(i for i, e in enumerate(events) if e['kind'] == 'battle_target_declared')
        self.assertLess(dropped, declared)
        self.assertEqual(next(e for e in events if e['kind'] == 'battle_resolved')['calculation']['equipped_pairs'], [])

    def test_strength_queries_include_current_target_continuous_penalties(self):
        f = self.fixture()
        hero = f.add('TS-0001')
        target = f.add('TS-0660', 'hall:main')
        f.tx.state['battle_context']['target_instance_id'] = target
        strength = int(self.cards['TS-0001']['wiki_力量'])
        matches = client.call('effect_query', {'input': {'state': f.tx.state, 'cards': self.cards,
                                                        'mechanics': [asdict(m) for m in self.rules.mechanics]},
                                              'spec': {'zone': 'active_hand', 'tag': '英雄', 'strength_max': strength - 1}, 'bindings': {}})
        self.assertEqual(matches, [hero])

    def test_priest_or_mage_effects_do_not_require_an_additional_hero_tag(self):
        for ability_id in ['TS-0468-A02', 'TS-0585-A03']:
            with self.subTest(ability=ability_id):
                f = self.fixture()
                f.cards = {**self.cards, 'TS-0401': {**self.cards['TS-0401'], 'tags': '法师'}}
                f.tx.cards = f.cards
                source = f.add('TS-0401')
                ability = self.rules.by_id(ability_id)
                query = ability.body['condition']['exists'] if ability.body['op'] == 'if' else ability.body['query']
                actual = client.call('effect_query', {'input': {'state': f.tx.state, 'cards': f.cards, 'mechanics': []},
                                                     'spec': query, 'bindings': {}})
                self.assertEqual(actual, [source])

    def test_plaguebearer_ignores_its_own_defeat_and_each_other_copy_triggers(self):
        f = self.fixture()
        first = f.add('TS-0482', 'hall:main')
        second = f.add('TS-0482', 'hall:main')
        f.tx.state['event_context'] = {'source_instance_id': first}
        sources = [c['source_instance_id'] for c in self.event_plan(f, 'MONSTER_DEFEATED')['candidates']
                   if c['ability_id'] == 'TS-0482-A01']
        self.assertEqual(sources, [second])
        f.tx.state['event_context'] = {'source_instance_id': f.add('TS-0476', 'player:alice:discard')}
        sources = [c['source_instance_id'] for c in self.event_plan(f, 'MONSTER_DEFEATED')['candidates']
                   if c['ability_id'] == 'TS-0482-A01']
        self.assertEqual(sources, [first, second])

    def test_barkeeper_purchase_limit_does_not_follow_the_card_into_hand(self):
        f = self.fixture()
        f.add('TS-0528')
        f.tx.state['chosen_action'] = 'village'
        f.tx.state['subphase'] = 'VILLAGE_BUY'
        f.tx.state['turn_purchases'] = {'alice': 1}
        f.tx.state['players']['alice'].update(purchases_remaining=1, temporary_gold=100)
        f.add('TS-0210', 'village_supply:test')
        commands = client.call('legal_commands', {'state': f.tx.state, 'catalog': {'cards': self.cards, 'setup_index': self.snapshot.setup_index},
                                                 'ruleset': asdict(self.rules)})
        self.assertTrue(any(c['type'] == 'BuyCard' for c in commands))
        f.add('TS-0528', 'hall:main')
        commands = client.call('legal_commands', {'state': f.tx.state, 'catalog': {'cards': self.cards, 'setup_index': self.snapshot.setup_index},
                                                 'ruleset': asdict(self.rules)})
        self.assertFalse(any(c['type'] == 'BuyCard' for c in commands))

    def test_fire_wrath_cannot_be_chosen_by_banishment_before_combat(self):
        f = self.fixture()
        immune = f.add('TS-0506', 'hall:main')
        normal = [f.add('TS-0476', 'hall:main') for _ in range(2)]
        result = self.activate(f, 'TS-0268')
        self.assertEqual(result['state']['pending_choice']['candidate_instance_ids'], normal)
        self.assertIn(immune, result['state']['zones']['hall:main'])

    def test_spell_immunity_blocks_health_changes_but_not_unrelated_disease_effects(self):
        f = self.fixture()
        immune = f.add('TS-0506', 'hall:main')
        ordinary = f.add('TS-0476', 'hall:main')
        result = self.activate(f, 'TS-0271')
        health = result['state']['battle_context']['monster_health_modifiers']
        self.assertNotIn(immune, health)
        self.assertEqual(health[ordinary], -2)
        self.assertTrue(any(e['kind'] == 'disease_taken_from_supply' and e['player_id'] == 'bob' for e in result['events']))

    def test_light_items_use_the_tag_even_when_light_value_disagrees(self):
        for tags, light, expected in [('物品|光照|村庄', '0', True), ('物品|村庄', '2', False)]:
            with self.subTest(tags=tags, light=light):
                f = self.fixture()
                f.cards = {**self.cards, 'TS-0003': {**self.cards['TS-0003'], 'tags': tags, 'wiki_光照': light}}
                f.tx.cards = f.cards
                item = f.add('TS-0003')
                for ability_id in ['TS-0587-A01', 'TS-0633-A01']:
                    body = self.rules.by_id(ability_id).body
                    query = body['condition']['exists'] if body['op'] == 'if' else body['query']
                    actual = client.call('effect_query', {'input': {'state': f.tx.state, 'cards': f.cards, 'mechanics': []},
                                                         'spec': query, 'bindings': {}})
                    self.assertEqual(actual, [item] if expected else [])

    def test_hydra_discards_immediately_and_reshuffles_to_find_another_players_hero(self):
        f = self.fixture()
        source = f.add('TS-0463', 'hall:main')
        first = f.add('TS-0003', 'player:alice:draw')
        second = f.add('TS-0004', 'player:alice:draw')
        victim = f.add('TS-0001', 'player:alice:draw')
        remains = f.add('TS-0302', 'player:alice:draw')
        other = f.add('TS-0003', 'player:bob:draw')
        old_discard = f.add('TS-0001', 'player:bob:discard')
        f.tx.ruleset = replace(self.rules, abilities=(self.rules.by_id('TS-0463-A01'),), mechanics=())
        state = f.tx.state
        state['subphase'] = 'TURN_START'
        state['started_turn'] = state['turn_number']
        state['workflow_steps'] = [{'op': 'event', 'event': 'BREACH', 'context': {'source_instance_id': source}}]
        result = self.command(f, type='ChooseAction', action='dungeon')
        self.assertEqual(result['state']['zones']['player:alice:draw'], [remains])
        self.assertEqual(result['state']['zones']['player:alice:discard'], [first, second])
        self.assertIn(victim, result['state']['zones']['destroyed'])
        self.assertIn(old_discard, result['state']['zones']['destroyed'])
        self.assertCountEqual(result['state']['zones']['player:bob:discard'] + result['state']['zones']['player:bob:draw'], [other])
        moves = [e for e in result['events'] if e['kind'] == 'card_moved']
        for item in [first, second]:
            self.assertTrue(any(e.get('instance_id') == item and e.get('destination') == 'player:alice:discard' for e in moves))
        events = result['events']
        for item, following in [(first, second), (second, victim)]:
            discarded_at = next(i for i, e in enumerate(events) if e['kind'] == 'card_moved'
                                and e.get('instance_id') == item and e.get('destination') == 'player:alice:discard')
            revealed_at = next(i for i, e in enumerate(events) if e['kind'] == 'cards_revealed' and following in e['instance_ids'])
            self.assertLess(discarded_at, revealed_at)
        self.assertEqual([e['player_id'] for e in result['events'] if e['kind'] == 'player_deck_shuffled'], ['bob'])

    def test_tavern_brawl_reshuffles_opponents_discard_to_find_a_hero(self):
        f = self.fixture()
        source = f.add('TS-0216')
        own_hero = f.add('TS-0304')
        f.add('TS-0003', 'player:bob:draw')
        enemy_hero = f.add('TS-0001', 'player:bob:discard')
        state = f.tx.state
        state.update(subphase='VILLAGE_ABILITIES', timing_window='VILLAGE_ABILITIES', chosen_action='village', battle_context=None)
        result = self.command(f, type='ActivateAbility', ability_id='TS-0216-A01', source_instance_id=source)
        self.assertIsNone(result['state']['pending_choice'])
        self.assertIn(own_hero, result['state']['zones']['player:alice:discard'])
        self.assertIn(enemy_hero, result['state']['zones']['destroyed'])
        self.assertEqual(result['state']['players']['alice']['xp'], state['players']['alice']['xp'] + 1)
        self.assertTrue(any(e['kind'] == 'player_deck_shuffled' and e['player_id'] == 'bob' for e in result['events']))

    def test_repeated_traps_find_targets_in_discard_and_stop_with_a_partial_total(self):
        for card_id, target_card in [('TS-0689', 'TS-0001'), ('TS-0693', 'TS-0002')]:
            with self.subTest(card=card_id):
                f = self.fixture()
                source = f.add(card_id, 'revealed:main')
                f.add('TS-0003', 'player:alice:draw')
                f.add('TS-0004', 'player:bob:draw')
                victims = [f.add(target_card, 'player:bob:discard') for _ in range(2)]
                f.tx.ruleset = replace(self.rules, abilities=(self.rules.by_id(card_id + '-A01'),), mechanics=())
                state = f.tx.state
                state.update(subphase='TURN_START', started_turn=state['turn_number'])
                state['workflow_steps'] = [{'op': 'event', 'event': 'TRAP_REVEALED', 'context': {'source_instance_id': source}}]
                result = self.command(f, type='ChooseAction', action='village')
                self.assertTrue(set(victims) <= set(result['state']['zones']['destroyed']))
                completed = next(e for e in result['events'] if e['kind'] == 'trap_reveal_cycle_completed')
                self.assertEqual(completed['destroyed_count'], 2)
                self.assertEqual(sum(e['kind'] == 'effect_search_stopped' for e in result['events']), 1)
                self.assertTrue(any(e['kind'] == 'player_deck_shuffled' and e['player_id'] == 'bob' for e in result['events']))


if __name__ == '__main__':
    unittest.main()
