"""Monster-tag effects include guardians and do not infer identity from categories."""
import unittest

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from tests.migration.reference.python_engine.effects.attachments import attach
from tests.migration.reference.python_engine.effects.combat import is_monster, stat
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from tests.migration.reference.python_engine.effects.economy import printed_gold
from tests.migration.reference.python_engine.effects.hall import can_move_monster, relocate
from tests.migration.reference.python_engine.effects.hall_actions import exchange_hall, shuffle_hall_top, swap_hall
from tests.migration.reference.python_engine.effects.runtime import _query
from backend.app.integrations.game_engine.scoring import score_game
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.turn import apply_command, legal_commands
from tests.migration.reference.python_engine.turn.operations import TurnError
from tests.migration.reference.python_engine.turn.workflow import queue_steps
from tests.mechanic_cases import Fixture
from tests.test_setup_engine import config, request
from scripts.audit_effect_identity import collect


class MonsterIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.cards = cls.snapshot.cards
        cls.rules = load_ruleset(cls.cards)
        settings = config()
        settings['selection']['dungeon_features']['mode'] = 'manual'
        req = request(settings, seed='monster-tag-effects')
        req.update(player_ids=['alice', 'bob'], first_player={'mode': 'fixed', 'player_id': 'alice'})
        cls.base = start_game(req, snapshot=cls.snapshot)['state']

    def fixture(self):
        f = Fixture(self.base, self.cards, self.rules, self.rules.mechanics[0])
        f.tx.ruleset = self.rules
        state = f.tx.state
        for zone in list(state['zones']):
            if zone.startswith(('hall:', 'dungeon:')):
                state['zones']['destroyed'].extend(state['zones'][zone])
                state['zones'][zone] = []
        for _ in range(3):
            f.add('TS-0476', 'hall:main')
        for _ in range(6):
            f.add('TS-0476', 'dungeon:main')
            f.add('TS-0003', 'player:alice:draw')
        return f

    def activate(self, fixture, ability_id, source_id):
        state = fixture.tx.state
        return apply_command(state, {'type': 'ActivateAbility', 'player_id': 'alice',
            'expected_version': state['game_version'], 'ability_id': ability_id,
            'source_instance_id': source_id}, snapshot=self.snapshot)

    def test_identity_and_semantic_query_are_tag_only_for_every_guardian(self):
        f = self.fixture()
        guardians = [f.add(card_id) for card_id, card in self.cards.items() if card['subcategory'] == '守护者']
        ordinary = f.add('TS-0476')
        self.assertEqual(_query(f.tx, {'zone': 'active_hand', 'semantic_type': 'monster'}), guardians + [ordinary])
        for item in guardians + [ordinary]:
            self.assertTrue(is_monster(f.tx.card(item)))
        untagged = {**self.cards['TS-0476'], 'tags': '九头蛇|龙'}
        self.assertFalse(is_monster(untagged))
        self.assertTrue(is_monster({**untagged, 'subcategory': '', 'tags': '其他|怪物'}))

    def test_published_effects_have_no_category_based_monster_predicate(self):
        _, rows = collect()
        self.assertFalse([row for row in rows if row['field'] == 'subcategory' and row['value'] == '怪物'])
        tag_queries = []
        def walk(value):
            if isinstance(value, dict):
                if value.get('tag') == '怪物':
                    tag_queries.append(value)
                for child in value.values():
                    walk(child)
            elif isinstance(value, (list, tuple)):
                for child in value:
                    walk(child)
        from dataclasses import asdict
        for ability in self.rules.abilities:
            walk(asdict(ability))
        self.assertGreaterEqual(len(tag_queries), 56)

    def test_prophet_counts_guardian_in_hand_and_draws_twice(self):
        f = self.fixture()
        source = f.add('TS-0428')
        f.add('TS-0674')
        result = self.activate(f, 'TS-0428-A03', source)
        draw = next(event for event in result['events'] if event['kind'] == 'effect_draw')
        self.assertEqual(draw['requested'], 2)

    def test_tracker_activation_and_necromancer_victory_point_sum_include_guardian(self):
        f = self.fixture()
        tracker = f.add('TS-0319')
        necromancer = f.add('TS-0419')
        guardian = f.add('TS-0673')
        options = [option for command in legal_commands(f.tx.state, snapshot=self.snapshot)
                   for option in command.get('options', []) if isinstance(option, dict)]
        self.assertIn({'ability_id': 'TS-0319-A02', 'source_instance_id': tracker}, options)
        result = self.activate(f, 'TS-0419-A02', necromancer)
        self.assertEqual(result['state']['battle_context']['modifiers']['magic_attack'], stat(f.tx.card(guardian), 'vp'))

    def test_guardian_can_pay_monster_destruction_cost(self):
        f = self.fixture()
        source = f.tx.state['zones']['hall:main'][0]
        f.tx.state['instances'][source]['card_id'] = 'TS-0473'
        guardian = f.add('TS-0674')
        f.tx.state['battle_context']['modifiers'] = {'attack': 100, 'light': 100}
        result = apply_command(f.tx.state, {'type': 'DeclareBattleTarget', 'player_id': 'alice',
                               'target_instance_id': source}, snapshot=self.snapshot)
        events = list(result['events'])
        for _ in range(4):
            choice = result['state']['pending_choice']
            if choice is None:
                break
            command = {'player_id': choice['player_id']}
            if choice['kind'] == 'effect_value':
                command.update(type='ResolveValueChoice', value='pay')
            else:
                self.assertEqual(choice['kind'], 'effect_select')
                self.assertIn(guardian, choice['candidate_instance_ids'])
                command.update(type='ResolveChoice', instance_ids=[guardian])
            result = apply_command(result['state'], command, snapshot=self.snapshot)
            events.extend(result['events'])
        self.assertIsNone(result['state']['pending_choice'])
        self.assertIn(guardian, result['state']['zones']['destroyed'])
        self.assertEqual(next(event for event in events if event['kind'] == 'battle_resolved')['outcome'], 'win')

    def test_disease_can_attach_to_guardian(self):
        f = self.fixture()
        guardian = f.add('TS-0673', 'hall:main:rank0')
        disease = f.add('TS-0714')
        attach(f.tx, disease, guardian, 'disease_before', owner='alice')
        self.assertEqual(f.tx.state['zones']['attached:' + guardian], [disease])
        self.assertEqual(f.tx.state['attachments'][guardian][0]['instance_id'], disease)

    def test_heart_of_doom_destroys_guardian_trophies_on_dungeon_entry(self):
        f = self.fixture()
        guardian = f.add('TS-0674')
        ordinary = f.add('TS-0476')
        f.add('TS-0683', 'hall:main:rank0')
        state = f.tx.state
        state.update(subphase='TURN_START', timing_window='TURN_START_BEFORE', chosen_action=None, battle_context=None)
        result = apply_command(state, {'type': 'ChooseAction', 'player_id': 'alice', 'action': 'dungeon'}, snapshot=self.snapshot)
        self.assertIn(guardian, result['state']['zones']['destroyed'])
        self.assertIn(ordinary, result['state']['zones']['destroyed'])

    def test_monster_gold_zero_and_fewest_monsters_scoring_include_guardians(self):
        f = self.fixture()
        f.tx.state['active_settings'] = ['TS-0189']
        guardian = {**self.cards['TS-0674'], 'wiki_金币值': '3'}
        self.assertEqual(printed_gold(f.tx, guardian), 0)
        self.assertEqual(printed_gold(f.tx, {**guardian, 'tags': '守护者'}), 3)
        # Equal one-monster counts: a guardian must prevent the old false "fewest" bonus.
        state = {'player_order': ['alice', 'bob'], 'players': {'alice': {}, 'bob': {}},
                 'instances': {'stone': {'card_id': 'TS-0713', 'owner_player_id': 'alice'},
                               'guardian': {'card_id': 'TS-0674', 'owner_player_id': 'alice'},
                               'monster': {'card_id': 'TS-0476', 'owner_player_id': 'bob'}}}
        result = score_game(state, self.cards, self.rules)
        entry = next(card for card in result['players']['alice']['cards'] if card['instance_id'] == 'stone')
        self.assertEqual(entry['victory_points'], stat(self.cards['TS-0713'], 'vp'))

    def test_rank_zero_guardians_return_to_the_real_deck_without_refilling(self):
        for card_id in ('TS-0673', 'TS-0674', 'TS-0675', 'TS-0676', 'TS-0677',
                        'TS-0678', 'TS-0680', 'TS-0681', 'TS-0683'):
            with self.subTest(card_id=card_id):
                f = self.fixture()
                guardian = f.add(card_id, 'hall:main:rank0')
                original_hall = list(f.tx.state['zones']['hall:main'])
                self.assertTrue(can_move_monster(f.tx, guardian))
                self.assertEqual(relocate(f.tx, guardian, 'dungeon_bottom'), [])
                self.assertEqual(f.tx.state['zones']['dungeon:main'][-1], guardian)
                self.assertEqual(f.tx.state['zones']['hall:main'], original_hall)
                self.assertNotIn('dungeon:main:rank0', f.tx.state['zones'])

    def test_immovable_guardians_can_only_leave_when_defeated(self):
        for card_id in ('TS-0679', 'TS-0682'):
            with self.subTest(card_id=card_id):
                f = self.fixture()
                guardian = f.add(card_id, 'hall:main:rank0')
                xp_before = f.tx.player['xp']
                self.assertFalse(can_move_monster(f.tx, guardian))
                with self.assertRaises(TurnError):
                    relocate(f.tx, guardian, 'dungeon_bottom')
                self.assertNotIn(guardian, _query(f.tx, {'zone': 'hall', 'tag': '怪物', 'movable': True}))
                steps = relocate(f.tx, guardian, 'discard', defeat=True)
                self.assertIn(guardian, f.tx.state['zones']['player:alice:discard'])
                self.assertEqual(f.tx.player['xp'] - xp_before, int(self.cards[card_id]['defeat_xp_reward']))
                self.assertEqual(steps[0]['context']['rank'], 0)
                self.assertFalse(any(step['op'] == 'refill_hall' for step in steps))

    def test_rank_zero_shuffle_returns_guardian_to_dungeon_top(self):
        f = self.fixture()
        guardian = f.add('TS-0674', 'hall:main:rank0')
        top = list(f.tx.state['zones']['dungeon:main'][:3])
        self.assertEqual(shuffle_hall_top(f.tx, guardian, 3), [])
        self.assertCountEqual(f.tx.state['zones']['dungeon:main'][:4], top + [guardian])
        self.assertNotIn('dungeon:main:rank0', f.tx.state['zones'])

    def test_rank_zero_does_not_participate_in_ordinary_repositioning(self):
        f = self.fixture()
        first = f.add('TS-0673', 'hall:main:rank0')
        second = f.add('TS-0674', 'hall:main:rank0')
        ordinary = f.tx.state['zones']['hall:main'][0]
        replacement = f.add('TS-0476')
        for operation in (lambda: relocate(f.tx, first, 'rank3'),
                          lambda: swap_hall(f.tx, first, second),
                          lambda: exchange_hall(f.tx, first, replacement),
                          lambda: exchange_hall(f.tx, ordinary, first)):
            with self.assertRaises(TurnError):
                operation()
        self.assertEqual(_query(f.tx, {'zone': 'hall', 'tag': '怪物', 'adjacent_to_var': 'first'}, {'first': first}), [])

    def test_bow_and_exchange_selectors_exclude_rank_zero(self):
        for ability_id, source_card in (('TS-0232-A02', 'TS-0232'), ('TS-0362-A03', 'TS-0362')):
            with self.subTest(ability_id=ability_id):
                f = self.fixture()
                source = f.add(source_card)
                guardian = f.add('TS-0674', 'hall:main:rank0')
                if source_card == 'TS-0362':
                    f.add('TS-0476')
                result = self.activate(f, ability_id, source)
                choice = result['state']['pending_choice']
                self.assertIsNotNone(choice)
                self.assertTrue(choice['candidate_instance_ids'])
                self.assertNotIn(guardian, choice['candidate_instance_ids'])
                self.assertTrue(all(item in result['state']['zones']['hall:main'] for item in choice['candidate_instance_ids']))

    def test_direct_defeat_spell_includes_immovable_rank_zero_guardian(self):
        f = self.fixture()
        source = f.add('TS-0266')
        f.add('TS-0428')
        guardian = f.add('TS-0679', 'hall:main:rank0')
        result = self.activate(f, 'TS-0266-A01', source)
        self.assertIn(guardian, result['state']['pending_choice']['candidate_instance_ids'])
        result = apply_command(result['state'], {'type': 'ResolveChoice', 'player_id': 'alice',
                               'instance_ids': [guardian]}, snapshot=self.snapshot)
        self.assertIn(guardian, result['state']['zones']['player:alice:discard'])
        self.assertEqual(result['state']['zones']['hall:main'], f.tx.state['zones']['hall:main'])

    def test_immovable_guardian_trophy_can_be_exchanged_from_hand_into_hall(self):
        f = self.fixture()
        source = f.add('TS-0362')
        guardian = f.add('TS-0679')
        target = f.tx.state['zones']['hall:main'][1]
        result = self.activate(f, 'TS-0362-A03', source)
        self.assertIn(target, result['state']['pending_choice']['candidate_instance_ids'])
        result = apply_command(result['state'], {'type': 'ResolveChoice', 'player_id': 'alice',
                               'instance_ids': [target]}, snapshot=self.snapshot)
        self.assertEqual(result['state']['zones']['hall:main'][1], guardian)
        self.assertIsNone(result['state']['instances'][guardian]['owner_player_id'])
        self.assertIn(target, result['state']['zones']['player:alice:hand'])

    def test_direct_defeat_of_heart_of_doom_still_ends_the_game(self):
        f = self.fixture()
        heart = f.add('TS-0683', 'hall:main:rank0')
        steps = relocate(f.tx, heart, 'discard', defeat=True)
        queue_steps(f.tx, steps)
        self.assertEqual(f.tx.state['phase'], 'SETTLING')
        self.assertEqual(f.tx.state['end_condition']['reason'], 'heart_of_doom_defeated')


if __name__ == '__main__':
    unittest.main()
