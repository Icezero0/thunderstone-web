"""Full setup, random-stream and error parity with the frozen Python engine."""
from copy import deepcopy
import unittest
from unittest.mock import patch

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.catalog.service import build_panel_catalog
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.app.integrations.game_engine.rules.service import validate_rules_config
from backend.app.integrations.game_engine.setup import SetupChoiceRequired, SetupError, SetupRng, start_game
from backend.app.integrations.game_engine.setup.builder import _Builder
from backend.app.integrations.game_engine.setup.state import validate_setup_state
from backend.tests.migration.reference.setup import service as reference, rules as old_rules
from backend.tests.migration.reference.setup.builder import _Builder as OldBuilder
from backend.tests.migration.reference.setup.random import SetupRng as OldRng
from backend.tests.test_setup_engine import config, request


class SharedSetupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.panel = build_panel_catalog(cls.snapshot.cards, cls.snapshot.setup_index)
        cls.current_rules = load_ruleset(cls.snapshot.cards)

    def reference_setup(self, frozen):
        # Setup only records the effect revision. The historical compiler must
        # not be taught DSL operators introduced after the migration.
        with patch.object(reference, 'load_ruleset', return_value=self.current_rules):
            return reference.start_game(frozen, snapshot=self.snapshot)

    def compare(self, frozen):
        before = deepcopy(frozen)
        try:
            expected = self.reference_setup(frozen)
        except SetupChoiceRequired as error:
            with self.assertRaises(SetupChoiceRequired) as actual:
                start_game(frozen, snapshot=self.snapshot)
            self.assertEqual(actual.exception.choice, error.choice)
            self.assertEqual(frozen, before)
            frozen = deepcopy(frozen)
            frozen['scenario_choices'] = {'two_dungeons': {
                'group_a_ids': error.choice['group_ids'][:2],
                'group_a_feature_ids': error.choice['feature_ids'][::2]}}
            expected = self.reference_setup(frozen)
        unchanged = deepcopy(frozen)
        result = start_game(frozen, snapshot=self.snapshot)
        self.assertEqual(result, expected)
        self.assertEqual(frozen, unchanged)
        return result

    def manual(self, environment=None):
        rules = config()
        rules['selection']['dungeon_features']['mode'] = 'manual'
        if environment:
            rules['selection']['environment']['fixed_card_ids'] = [environment]
        if environment == 'TS-0199':
            rules['selection']['guardian']['fixed_card_ids'] = ['TS-0683']
            rules['selection']['thunderstone']['fixed_card_ids'] = [item['id'] for item in self.panel['thunderstones']]
        return rules

    def test_random_stream_matches_reference_at_all_counter_widths(self):
        for seed in ('0', 'setup-test', '雷霆之石🐉', '-12', 'x' * 200, -(2 ** 100), 2 ** 100):
            for counter in (0, 1, 2 ** 53 - 1, 2 ** 53, 2 ** 100 + 7, 2 ** 128 - 200):
                actual, expected = SetupRng(seed), OldRng(seed)
                actual.counter = expected.counter = counter
                for size in (1, 2, 3, 17, 2 ** 53 + 13, 2 ** 255 + 1):
                    with self.subTest(seed=seed, counter=counter, size=size):
                        self.assertEqual(actual.randbelow(size), expected.randbelow(size))
                        self.assertEqual(actual.counter, expected.counter)
                left, right = list(map(str, range(30))), list(map(str, range(30)))
                actual.shuffle(left)
                expected.shuffle(right)
                self.assertEqual(left, right)
                self.assertEqual(actual.counter, expected.counter)
        for seed in ('', None, True, 1.5):
            with self.assertRaises(SetupError):
                SetupRng(seed)
        with self.assertRaises(SetupError):
            SetupRng('seed').randbelow(0)
        with self.assertRaises(SetupError):
            SetupRng('seed').randbelow(2 ** 256 + 1)

    def test_seeded_classic_setups_have_identical_complete_states_events_and_ids(self):
        for seed in [*map(str, range(20)), '雷霆之石🐉', -(2 ** 90), 2 ** 100]:
            with self.subTest(seed=seed):
                self.compare(request(seed=seed))
        frozen = request(self.manual(), seed='fixed-first')
        frozen.update(player_ids=['丙', '甲', '乙'], first_player={'mode': 'fixed', 'player_id': '乙'})
        self.assertEqual(self.compare(frozen)['state']['active_player_id'], '乙')

    def test_all_environments_and_manual_features_match_reference(self):
        for environment in self.panel['dungeon_cards']['environment']:
            rules = self.manual(environment['id'])
            with self.subTest(environment=environment['id']):
                self.compare(request(rules, seed='environment-parity'))
        for multiplier in range(1, 6):
            rules = self.manual()
            rules['instance_multipliers'] = dict.fromkeys(('village', 'hero', 'monster'), multiplier)
            rules['selection']['guardian']['fixed_card_ids'] = [self.panel['dungeon_cards']['guardian'][0]['id']]
            for kind in ('trap', 'treasure'):
                rules['selection'][kind]['fixed_group_ids'] = [item['id'] for item in self.panel['dungeon_groups'][kind]]
            with self.subTest(multiplier=multiplier):
                self.compare(request(rules, seed='all-features'))

    def test_every_monster_and_hero_group_including_reserves_and_special_diseases(self):
        for kind in ('monster', 'hero'):
            for group in self.panel['groups'][kind]:
                rules = self.manual()
                rules['selection'][kind]['fixed_randomizer_ids'] = [group['id']]
                with self.subTest(kind=kind, group=group['id']):
                    self.compare(request(rules, seed='group-parity'))

    def test_random_environments_trim_excess_groups_identically(self):
        environments = [item['id'] for item in self.panel['dungeon_cards']['environment']]
        for environment, kind, count in (('TS-0192', 'hero', 4), ('TS-0198', 'monster', 5)):
            rules = self.manual()
            rules['counts'][kind + '_groups'] = count
            rules['selection']['environment']['random_count'] = 1
            rules['selection'][kind]['fixed_randomizer_ids'] = [item['id'] for item in self.panel['groups'][kind][:count]]
            seed = next(str(i) for i in range(1000) if OldRng(str(i)).randbelow(len(environments)) == environments.index(environment))
            result = self.compare(request(rules, seed=seed))
            self.assertEqual(sum(item['kind'] == 'group_removed_by_environment' for item in result['events']), 1)

    def test_config_issue_paths_messages_and_order_match_for_malformed_inputs(self):
        for payload in (None, [], True, 1, 'bad', {}):
            self.assertEqual(validate_rules_config(payload, self.panel), old_rules.validate_rules_config(payload, self.panel))
        paths = [('mode',), ('counts',), ('selection',), ('instance_multipliers',)]
        paths += [('counts', kind + '_groups') for kind in ('village', 'hero', 'monster')]
        paths += [('instance_multipliers', kind) for kind in ('village', 'hero', 'monster')]
        paths += [('selection', kind, 'fixed_randomizer_ids') for kind in ('village', 'hero', 'monster')]
        paths += [('selection', 'dungeon_features', 'mode')]
        paths += [('selection', kind, key) for kind, key in (('guardian', 'fixed_card_ids'), ('environment', 'fixed_card_ids'),
                  ('trap', 'fixed_group_ids'), ('treasure', 'fixed_group_ids'), ('thunderstone', 'fixed_card_ids'))]
        paths += [('selection', kind, 'random_count') for kind in ('guardian', 'environment', 'trap', 'treasure')]
        for path in paths:
            for value in (None, True, False, 1.5, 'bad', [], {}, -1, 999):
                draft = config()
                target = draft
                for part in path[:-1]:
                    target = target[part]
                target[path[-1]] = value
                with self.subTest(path=path, value=value):
                    self.assertEqual(validate_rules_config(draft, self.panel), old_rules.validate_rules_config(draft, self.panel))

    def test_typed_setup_errors_preserve_issues_and_choice_payloads(self):
        invalid = request()
        invalid['config']['counts']['hero_groups'] = True
        with self.assertRaises(SetupError) as error:
            start_game(invalid, snapshot=self.snapshot)
        self.assertEqual(error.exception.issues, old_rules.validate_rules_config(invalid['config'], self.panel))
        invalid = request(self.manual('TS-0198'))
        invalid['scenario_choices'] = {'two_dungeons': {'group_a_ids': ['unknown', 'unknown'], 'group_a_feature_ids': []}}
        with self.assertRaisesRegex(SetupError, 'invalid two_dungeons allocation'):
            start_game(invalid, snapshot=self.snapshot)
        result = self.compare(request(self.manual(), seed='error-recovery'))
        validate_setup_state(result['state'], self.snapshot.cards)
        damaged = deepcopy(result['state'])
        damaged['zones']['player:alice:hand'].append(damaged['zones']['player:alice:draw'][0])
        with self.assertRaisesRegex(SetupError, 'duplicate or unknown'):
            validate_setup_state(damaged, self.snapshot.cards)

    def test_partial_builder_hall_steps_match_without_python_fallback(self):
        for treefolk in ('TS-0571', 'TS-0572', 'TS-0573', 'TS-0574', 'TS-0575'):
            for copies in (1, 2):
                current = _Builder(request(), self.snapshot.cards, self.snapshot.setup_index, self.panel)
                old = OldBuilder(request(), self.snapshot.cards, self.snapshot.setup_index, self.panel)
                for builder in (current, old):
                    builder.create(treefolk, 'dungeon:main', origin='parity', count=copies)
                    builder.create('TS-0476', 'dungeon:main', origin='parity', count=6)
                    builder.fill_hall('dungeon:main')
                self.assertEqual(current.zones, old.zones)
                self.assertEqual(current.instances, old.instances)
                self.assertEqual(current.events, old.events)
                self.assertEqual(len(current.zones['hall:main']), 3 + copies)


if __name__ == '__main__':
    unittest.main()
