"""Rule identities use tags, including cards with multiple identities."""
from dataclasses import replace
import json
from pathlib import Path
import unittest

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from tests.migration.reference.python_engine.effects.attachments import attach
from tests.migration.reference.python_engine.effects.combat import is_disease, is_thunderstone, is_monster, is_village, stat
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from tests.migration.reference.python_engine.effects.purchase import offer
from tests.migration.reference.python_engine.effects.runtime import _query
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.scoring import score_game
from backend.app.integrations.game_engine.turn import apply_command
from tests.migration.reference.python_engine.turn.workflow import queue_steps
from scripts.audit_effect_identity import collect
from tests.mechanic_cases import Fixture
from tests.test_setup_engine import config, request


class SecondaryIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.cards = cls.snapshot.cards
        cls.rules = load_ruleset(cls.cards)
        settings = config()
        settings['selection']['dungeon_features']['mode'] = 'manual'
        req = request(settings, seed='secondary-identity')
        req.update(player_ids=['alice', 'bob'], first_player={'mode': 'fixed', 'player_id': 'alice'})
        cls.base = start_game(req, snapshot=cls.snapshot)['state']

    def fixture(self, changes):
        cards = {**self.cards, **{key: {**self.cards[key], **value} for key, value in changes.items()}}
        f = Fixture(self.base, cards, self.rules, self.rules.mechanics[0])
        f.tx.ruleset = self.rules
        for zone, pile in list(f.tx.state['zones'].items()):
            if zone.startswith(('hall:', 'dungeon:')):
                f.tx.state['zones']['destroyed'].extend(pile)
                pile.clear()
        for _ in range(3):
            f.add('TS-0476', 'hall:main')
        for _ in range(6):
            f.add('TS-0476', 'dungeon:main')
            f.add('TS-0003', 'player:alice:draw')
        return f

    def test_no_published_disease_or_stone_category_predicates_remain(self):
        _, rows = collect()
        self.assertFalse([row for row in rows if (row['field'], row['value']) in {
            ('card_type', '疾病牌'), ('exclude_card_type', '疾病牌'), ('subcategory', '雷霆之石')}])
        for predicate, card_id, field, category in (
                (is_disease, 'TS-0714', 'card_type', '疾病牌'),
                (is_thunderstone, 'TS-0707', 'subcategory', '雷霆之石')):
            card = self.cards[card_id]
            self.assertTrue(predicate({**card, field: ''}))
            self.assertFalse(predicate({**card, field: category, 'tags': ''}))

    def test_all_treasures_have_tag_and_ulbrick_setup_membership_is_unchanged(self):
        treasures = [card for card in self.cards.values() if card['subcategory'] == '宝藏']
        self.assertEqual(len(treasures), 13)
        self.assertTrue(all('宝藏' in card['tags'].split('|') for card in treasures))
        action = next(item for item in self.snapshot.setup_index['dungeon_features'] if item['feature_id'] == 'TS-0200')
        self.assertEqual(action['members'], ['TS-0694', 'TS-0695', 'TS-0696'])
        draft = json.loads(next((Path(__file__).resolve().parents[1] / 'docs').rglob(
            'thunderstone_card_rules_v0.3.2_engine.json')).read_text(encoding='utf-8'))
        for card in draft['cards']:
            if card['id'] in action['members']:
                self.assertEqual(card['tags'], self.cards[card['id']]['tags'].split('|'))

    def test_disease_destruction_returns_to_supply_by_tag(self):
        for tagged in (True, False):
            with self.subTest(tagged=tagged):
                f = self.fixture({'TS-0714': {'card_type': '村庄牌' if tagged else '疾病牌',
                                             'tags': '疾病' if tagged else ''}})
                disease = f.add('TS-0714')
                result = f.tx.destroy_card(disease)
                self.assertEqual(result['destination'], 'disease_supply' if tagged else 'destroyed')
                self.assertEqual(disease not in f.tx.state['instances'], tagged)

    def test_tagged_disease_can_attach_and_be_destroyed_by_healing_ability(self):
        f = self.fixture({'TS-0714': {'card_type': '村庄牌'}})
        disease = f.add('TS-0714')
        monster = f.tx.state['zones']['hall:main'][0]
        attach(f.tx, disease, monster, 'disease_before', owner='alice')
        self.assertIn(disease, f.tx.state['zones']['attached:' + monster])
        f = self.fixture({'TS-0714': {'card_type': '村庄牌'}})
        source = f.add('TS-0428')
        disease = f.add('TS-0714')
        result = apply_command(f.tx.state, {'type': 'ActivateAbility', 'player_id': 'alice',
            'ability_id': 'TS-0428-A02', 'source_instance_id': source},
            snapshot=replace(self.snapshot, cards=f.tx.cards))
        self.assertNotIn(disease, result['state']['instances'])
        self.assertEqual(next(event['requested'] for event in result['events'] if event['kind'] == 'effect_draw'), 2)

    def test_tagged_stone_at_rank_one_ends_the_game_without_category(self):
        f = self.fixture({'TS-0707': {'subcategory': ''}})
        stone = f.tx.state['zones']['hall:main'][0]
        f.tx.state['instances'][stone]['card_id'] = 'TS-0707'
        queue_steps(f.tx, [{'op': 'refill_hall', 'hall_zone': 'hall:main'}])
        self.assertEqual(f.tx.state['phase'], 'SETTLING')

    def test_guardian_returns_tagged_stone_without_category_to_deck(self):
        f = self.fixture({'TS-0707': {'subcategory': ''}})
        stone = f.tx.state['zones']['hall:main'][1]
        f.tx.state['instances'][stone]['card_id'] = 'TS-0707'
        f.add('TS-0678', 'hall:main:rank0')
        queue_steps(f.tx, [{'op': 'event', 'event': 'TURN_START'}])
        self.assertEqual(f.tx.state['zones']['dungeon:main'][-1], stone)
        self.assertNotIn(stone, f.tx.state['zones']['hall:main'])

    def test_heart_counts_as_both_monster_and_thunderstone_in_scoring(self):
        self.assertTrue(is_monster(self.cards['TS-0683']))
        self.assertTrue(is_thunderstone(self.cards['TS-0683']))
        state = {'player_order': ['alice', 'bob'], 'players': {'alice': {}, 'bob': {}},
                 'instances': {'heart': {'card_id': 'TS-0683', 'owner_player_id': 'alice'},
                               'fear': {'card_id': 'TS-0708', 'owner_player_id': 'alice'}}}
        result = score_game(state, self.cards, self.rules)
        self.assertEqual(result['players']['alice']['thunderstones'], 2)
        fear = next(item for item in result['players']['alice']['cards'] if item['instance_id'] == 'fear')
        self.assertEqual(fear['victory_points'], stat(self.cards['TS-0708'], 'vp') + 2)

    def test_village_catalog_boundary_and_dual_identity_are_explicit(self):
        fronts = {key for key, card in self.cards.items()
                  if card['slot_kind'] == 'front' and card['card_type'] != '游戏设置牌' and is_village(card)}
        expected = {key for key, card in self.cards.items() if card['card_type'] == '村庄牌'} | {
            'TS-0002', 'TS-0003', 'TS-0004'}
        self.assertEqual(fronts, expected)
        self.assertEqual(len(fronts), 95)
        draft = json.loads(next((Path(__file__).resolve().parents[1] / 'docs').rglob(
            'thunderstone_card_rules_v0.3.2_engine.json')).read_text(encoding='utf-8'))
        self.assertEqual({card['id'] for card in draft['cards'] if card['id'] in fronts}, fronts)
        for card in draft['cards']:
            if card['id'] in fronts:
                self.assertEqual(card['tags'], self.cards[card['id']]['tags'].split('|'))
        self.assertNotIn('TS-0001', fronts)
        self.assertFalse(any(is_village(card) for card in self.cards.values() if card['card_type'] == '英雄牌'))
        for key in ('TS-0261', 'TS-0300', 'TS-0301'):
            self.assertIn('英雄', self.cards[key]['tags'].split('|'))
            self.assertTrue(is_village(self.cards[key]))
        self.assertFalse(is_village({**self.cards['TS-0261'], 'tags': '英雄'}))
        f = self.fixture({})
        hero = f.add('TS-0261')
        self.assertIn(hero, _query(f.tx, {'zone': 'active_hand', 'semantic_type': 'hero'}))
        self.assertIn(hero, _query(f.tx, {'zone': 'active_hand', 'semantic_type': 'village'}))
        _, rows = collect()
        self.assertFalse([row for row in rows if (row['field'], row['value']) in {
            ('card_type', '村庄牌'), ('semantic_type', 'village')}])

    def test_village_purchase_includes_three_basics_and_village_heroes_but_not_militia(self):
        f = self.fixture({})
        f.add('TS-0261', 'village_supply:dual')
        f.add('TS-0304', 'hero_supply:ordinary:1')
        options = {row['card_id'] for row in offer(f.tx, {'tag': '村庄'}, 100)}
        self.assertTrue({'TS-0002', 'TS-0003', 'TS-0004', 'TS-0261'} <= options)
        self.assertNotIn('TS-0001', options)
        self.assertNotIn('TS-0304', options)
        merchant = {row['card_id'] for row in offer(f.tx, {'tag': '村庄', 'tags_none': ['英雄']}, 100)}
        self.assertNotIn('TS-0261', merchant)
        self.assertTrue({'TS-0002', 'TS-0003', 'TS-0004'} <= merchant)

    def test_chieftain_drum_accepts_each_tag_of_dual_identity_cards(self):
        for card_id, declaration, expected in (('TS-0261', 'village', 2), ('TS-0261', 'hero', 2),
                ('TS-0001', 'village', 0), ('TS-0001', 'hero', 2),
                ('TS-0003', 'village', 2), ('TS-0304', 'village', 0)):
            with self.subTest(card_id=card_id, declaration=declaration):
                f = self.fixture({})
                source = f.add('TS-0299')
                revealed = f.add(card_id, 'player:alice:draw')
                draw = f.tx.state['zones']['player:alice:draw']
                draw.remove(revealed)
                draw.insert(0, revealed)
                result = apply_command(f.tx.state, {'type': 'ActivateAbility', 'player_id': 'alice',
                    'ability_id': 'TS-0299-A01', 'source_instance_id': source}, snapshot=self.snapshot)
                result = apply_command(result['state'], {'type': 'ResolveValueChoice',
                    'player_id': 'alice', 'value': declaration}, snapshot=self.snapshot)
                self.assertIn(revealed, result['state']['zones']['player:alice:discard'])
                self.assertEqual(sum(event['requested'] for event in result['events']
                    if event['kind'] == 'effect_draw'), expected)

    def test_flame_dragon_can_destroy_a_basic_village_card(self):
        f = self.fixture({})
        target = f.tx.state['zones']['hall:main'][0]
        f.tx.state['instances'][target]['card_id'] = 'TS-0460'
        torch = f.add('TS-0003')
        militia = f.add('TS-0001')
        f.tx.state['battle_context']['modifiers'] = {'attack': 100, 'light': 100}
        result = apply_command(f.tx.state, {'type': 'DeclareBattleTarget', 'player_id': 'alice',
            'target_instance_id': target}, snapshot=self.snapshot)
        self.assertIn(torch, result['state']['zones']['destroyed'])
        self.assertNotIn(militia, result['state']['zones']['destroyed'])

    def test_strong_paw_counts_a_village_hero_and_preserves_ordinary_hero_supply(self):
        f = self.fixture({})
        for zone, pile in f.tx.state['zones'].items():
            if zone.startswith(('village_supply:', 'hero_supply:')):
                f.tx.state['zones']['destroyed'].extend(pile)
                pile.clear()
        target = f.tx.state['zones']['hall:main'][0]
        f.tx.state['instances'][target]['card_id'] = 'TS-0560'
        for card_id in ('TS-0261', 'TS-0003', 'TS-0001', 'TS-0304'):
            f.add(card_id)
        for _ in range(2):
            f.add('TS-0261', 'village_supply:dual')
            f.add('TS-0304', 'hero_supply:ordinary:1')
        f.tx.state['battle_context']['modifiers'] = {'attack': 100, 'light': 100}
        result = apply_command(f.tx.state, {'type': 'DeclareBattleTarget', 'player_id': 'alice',
            'target_instance_id': target}, snapshot=self.snapshot)
        self.assertEqual(len(result['state']['zones']['village_supply:dual']), 1)
        self.assertEqual(len(result['state']['zones']['hero_supply:ordinary:1']), 2)
        infinite = [event for event in result['events'] if event['kind'] == 'infinite_supply_destruction']
        self.assertEqual([event['card_id'] for event in infinite], ['TS-0003'])


if __name__ == '__main__':
    unittest.main()
