"""Frozen Python versus shared TypeScript DSL contracts and pure evaluation."""
from copy import deepcopy
from dataclasses import asdict
import unittest

from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.effects.compiler import compile_ruleset, load_ruleset, EffectCompileError
from backend.tests.migration.reference.python_engine.effects.runtime import _query, _expr, _condition, EffectError
from backend.tests.migration.reference.python_engine.shared.evaluation import evaluation_input
from backend.tests.migration.reference.python_engine.shared.projection import calculation_input
from backend.tests.migration.reference.python_engine.turn.operations import Transition
from backend.tests.migration.reference import compiler as old_compiler, evaluation as reference


class SharedEffectsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cards = load_catalog().cards
        cls.rules = load_ruleset(cls.cards)

    def fixture(self):
        zones = {f"player:{player}:{part}": [] for player in ('alice', 'bob', 'carol')
                 for part in ('hand', 'draw', 'discard', 'control')}
        state = {'active_player_id': 'alice', 'player_order': ['alice', 'bob', 'carol'],
                 'players': {'alice': {'xp': 7, 'temporary_gold': 3},
                             'bob': {'xp': 2, 'temporary_gold': 0},
                             'carol': {'xp': 0, 'temporary_gold': 0, 'eliminated': True}},
                 'zones': zones, 'instances': {}, 'active_settings': [],
                 'chosen_action': 'dungeon', 'battle_context': {'equipped_weapon_by_hero': {'hero': 'weapon'}},
                 'rng_state': {'algorithm': 'sha256-counter-v1', 'seed': 'dsl-parity', 'counter': 0},
                 'used_cards': ['spell'], 'turn_defeated_monsters': ['trophy'],
                 'event_context': {'source_instance_id': 'm1', 'hero_instance_id': 'hero',
                                   'defeated_instance_id': 'trophy', 'supply_zone': 'village_supply:b', 'rank': 2, 'price': 6},
                 'effect_collections': {'ability:hero:saved': ['hero', 'spell']}}
        dragon = next(card_id for card_id, card in self.cards.items() if card['tags'] == '龙|红龙|怪物')
        for instance, card_id, zone in [
            ('hero', 'TS-0304', 'player:alice:hand'), ('militia', 'TS-0001', 'player:alice:hand'),
            ('weapon', 'TS-0002', 'player:alice:hand'), ('spell', 'TS-0272', 'player:alice:hand'),
            ('disease', 'TS-0714', 'player:alice:hand'), ('trophy', 'TS-0476', 'player:alice:hand'),
            ('bobhero', 'TS-0001', 'player:bob:hand'), ('bobweapon', 'TS-0002', 'player:bob:hand'),
            ('carolhero', 'TS-0304', 'player:carol:hand'), ('discarded', 'TS-0304', 'player:alice:discard'),
            ('bobdiscard', 'TS-0003', 'player:bob:discard'), ('control', 'TS-0003', 'player:alice:control'),
            ('bobcontrol', 'TS-0004', 'player:bob:control'), ('drawtop', 'TS-0004', 'player:alice:draw'),
            ('m1', dragon, 'hall:main'), ('m2', dragon, 'hall:main'), ('m3', 'TS-0476', 'hall:main'),
            ('m0', 'TS-0683', 'hall:main:rank0'), ('reveal', 'TS-0001', 'player:alice:revealed_test'),
            ('supplyB', 'TS-0002', 'village_supply:b'), ('supplyB2', 'TS-0002', 'village_supply:b'),
            ('supplyA', 'TS-0004', 'village_supply:a'), ('supplyhero', 'TS-0304', 'hero_supply:test:1')]:
            zones.setdefault(zone, []).append(instance)
            state['instances'][instance] = {'card_id': card_id, 'flags': {},
                'owner_player_id': zone.split(':')[1] if zone.startswith('player:') else None}
        state['instances']['militia']['flags']['pending_after_battle_destruction'] = True
        tx = Transition(state, self.cards, self.rules)
        bindings = {'source': 'hero', '_ability_id': 'ability', '_subject': 'bob',
                    '_dungeon': 'dungeon:main', '_reveal_zone': 'player:alice:revealed_test',
                    'one': 'hero', 'many': ['hero', 'militia'], 'allcards': list(state['instances']),
                    'neighbor': 'm2', 'number': 3, 'choice': 'yes', 'pile': 'supplyB'}
        return tx, bindings

    def test_preexisting_dsl_schema_still_compiles_identically(self):
        # New post-migration constructs are covered by current-engine tests;
        # keep the historical compiler frozen and compare its original schema.
        raw = {'schema_version': self.rules.schema_version, 'abilities': [],
               'mechanics': [asdict(m) for m in self.rules.mechanics
                             if m.op != 'battle_aura' and 'scope' not in m.params]}
        for ability in self.rules.abilities:
            if ability.id in ('TS-0463-A01', 'TS-0216-A01'):
                continue
            item = asdict(ability)
            item['conditions'] = list(item['conditions'])
            if item['kind'] == 'activated':
                item.pop('event')
                item['actions'] = list(item['actions'])
            else:
                item.pop('actions')
            raw['abilities'].append(item)
        frozen = old_compiler.compile_ruleset(raw, self.cards)
        self.assertEqual(asdict(compile_ruleset(raw, self.cards)), asdict(frozen))
        self.assertEqual(len(self.rules.abilities), 446)
        self.assertEqual(len(self.rules.mechanics), 227)

    def test_each_used_operation_rejects_unknown_fields_and_missing_required_fields(self):
        seen = set()
        for ability in self.rules.abilities:
            def walk(node, path=()):
                if not isinstance(node, dict):
                    return
                if 'op' in node and node['op'] not in seen:
                    seen.add(node['op'])
                    yield path
                for key, value in node.items():
                    if isinstance(value, dict):
                        yield from walk(value, (*path, key))
                    elif isinstance(value, list):
                        for index, child in enumerate(value):
                            yield from walk(child, (*path, key, index))
            for path in walk(ability.body):
                original = ability.body
                for part in path:
                    original = original[part]
                for mutation in ('unknown_field', *original):
                    raw = asdict(ability)
                    raw['conditions'] = list(raw['conditions'])
                    if raw['kind'] == 'activated':
                        raw.pop('event')
                        raw['actions'] = list(raw['actions'])
                    else:
                        raw.pop('actions')
                    node = raw['body']
                    for part in path:
                        node = node[part]
                    if mutation == 'unknown_field':
                        node['unexpected'] = True
                    else:
                        node.pop(mutation)
                    source = {'schema_version': 'thunderstone.effects/1', 'abilities': [raw]}
                    with self.subTest(ability=ability.id, path=path, mutation=mutation):
                        try:
                            old_compiler.compile_ruleset(source, self.cards)
                            expected = True
                        except old_compiler.EffectCompileError:
                            expected = False
                        try:
                            compile_ruleset(source, self.cards)
                            actual = True
                        except EffectCompileError:
                            actual = False
                        self.assertEqual(actual, expected)
                        if mutation in ('op', 'unknown_field'):
                            self.assertFalse(actual)
        self.assertGreater(len(seen), 50)
        for rule in self.rules.mechanics:
            source = {'schema_version': 'thunderstone.effects/1', 'abilities': [], 'mechanics': [asdict(rule)]}
            source['mechanics'][0]['params']['unexpected'] = 1
            with self.subTest(mechanic=rule.id):
                with self.assertRaises(old_compiler.EffectCompileError):
                    old_compiler.compile_ruleset(source, self.cards)
                with self.assertRaises(EffectCompileError):
                    compile_ruleset(source, self.cards)

    def test_every_query_zone_matches_reference_including_subject_and_eliminated_players(self):
        tx, bindings = self.fixture()
        before = deepcopy(tx.state)
        for zone in old_compiler.QUERY_ZONES:
            spec = {'zone': zone}
            if zone == 'bound':
                spec['var'] = 'many'
            if zone == 'collection':
                spec['collection'] = 'saved'
            with self.subTest(zone=zone):
                self.assertEqual(_query(tx, spec, bindings), reference._query(tx, spec, bindings))
        self.assertEqual(_query(tx, {'zone': 'other_hand'}, bindings), ['bobhero', 'bobweapon'])
        self.assertEqual(tx.state, before)

    def test_static_and_dynamic_filters_extrema_equipment_and_copies_match_reference(self):
        tx, bindings = self.fixture()
        filters = [
            {'tag': '英雄'}, {'tags_any': ['英雄', '法术']}, {'tags_none': ['英雄']},
            {'card_id': 'TS-0304'}, {'exclude_card_id': 'TS-0001'}, {'card_type': '村庄牌'},
            {'exclude_card_type': '基础牌'}, {'subcategory': '怪物'}, {'name': self.cards['TS-0002']['name']},
            {'gold_min': 1}, {'gold_max': 1}, {'gold_present': False}, {'cost_present': True}, {'vp_present': True},
            {'light_min': 1}, {'level_min': 1}, {'level_max': 1}, {'magic_min': 1}, {'magic_max': 1},
            {'weight_min': 1}, {'weight_max': 1}, {'vp_min': 1}, {'vp_max': 1},
            {'exclude_var': 'many'}, {'name_in_var': 'many'}, {'same_name_as_var': 'many'},
            {'semantic_type': 'hero'}, {'semantic_type': 'village'},
            {'without_weapon_tag': '锋利'}, {'in_hand': True}, {'in_hand': False},
            {'in_selected_dungeon': True}, {'adjacent_to_var': 'neighbor'}, {'movable': True},
            {'revealed_only': True}, {'exclude_pile_var': 'pile'}, {'rank': 0}, {'rank': 2},
            {'exclude_source': True}, {'strength_min': 2}, {'strength_max': 2}, {'duplicate_names': True},
            {'unmarked': True}, {'equipped': True}, {'equipped': False}, {'equipper_tags_any': ['英雄']},
            {'equipper_card_id': 'TS-0304'}, {'unused': True}, {'used': True}, {'used': False},
            {'in_discard': True}, {'in_discard': False}, {'equipment_space': True},
            {'same_family_as_event': True}, {'participating': True}, {'participating': False},
        ]
        filters += [{extreme: field} for extreme in ('max_by', 'min_by')
                    for field in ('strength', 'weight', 'attack', 'level', 'gold', 'pile_size', 'purchase_cost')]
        filters += [{'compare_stat': {'field': field, 'op': op, 'value': {'value': 'number'}}}
                    for field in ('vp', 'cost', 'health', 'level', 'strength', 'weight')
                    for op in ('le', 'lt', 'eq', 'ge', 'gt')]
        for copy in (None, {'card_ids': ['TS-0304'], 'full_card': False, 'preserve_attack': False},
                     {'card_ids': ['TS-0304'], 'full_card': True, 'preserve_attack': False}):
            tx.state['copied_heroes'] = {'militia': copy} if copy else {}
            for predicate in filters:
                spec = {'zone': 'bound', 'var': 'allcards', **predicate}
                with self.subTest(copy=copy, predicate=predicate):
                    self.assertEqual(_query(tx, spec, bindings), reference._query(tx, spec, bindings))

    def test_expression_operators_and_conditions_preserve_integer_and_short_circuit_semantics(self):
        tx, bindings = self.fixture()
        expressions = [-3, {'count': {'zone': 'active_hand', 'tag': '英雄'}},
                       {'sum': {'query': {'zone': 'active_hand'}, 'field': 'gold'}},
                       {'maximum': {'query': {'zone': 'active_hand'}, 'field': 'strength'}},
                       {'stat': {'var': 'one', 'field': 'strength'}}, {'resource': 'xp'},
                       {'resource': 'temporary_gold'}, {'context': 'rank'}, {'context': 'price'},
                       {'players': 'all'}, {'players': 'others'}, {'combat': 'attack'},
                       {'combat': 'magic_attack'}, {'combat': 'light'}, {'value': 'number'}]
        expressions += [{op: [-7, 3]} for op in ('add', 'mul', 'sub', 'div', 'min', 'max')]
        for expression in expressions:
            with self.subTest(expression=expression):
                self.assertEqual(_expr(tx, expression, bindings), reference._expr(tx, expression, bindings))
        self.assertEqual(_expr(tx, {'div': [-7, 3]}), -3)
        conditions = [{'all': [{'action_in': ['dungeon']}, {'exists': {'zone': 'subject_hand', 'tag': '英雄'}}]},
                      {'any': [{'action_in': ['village']}, {'not': {'setting_active': 'TS-0193'}}]},
                      {'choice_is': {'var': 'choice', 'option': 'yes'}}, {'subject_is_active': False}]
        conditions += [{'compare': {'left': {'resource': 'xp'}, 'op': op, 'right': 3}}
                       for op in ('eq', 'ne', 'lt', 'le', 'gt', 'ge')]
        for condition in conditions:
            self.assertEqual(_condition(tx, condition, bindings), reference._condition(tx, condition, bindings))
        guarded_error = {'compare': {'left': {'value': 'missing'}, 'op': 'eq', 'right': 0}}
        self.assertTrue(_condition(tx, {'any': [{'action_in': ['dungeon']}, guarded_error]}))
        self.assertFalse(_condition(tx, {'all': [{'action_in': ['rest']}, guarded_error]}))
        for expression in ({'div': [1, 0]}, {'mul': [10000, 2]}, {'value': 'missing'}, {'stat': {'var': 'many', 'field': 'strength'}}):
            with self.assertRaises(EffectError):
                _expr(tx, expression, bindings)
        for value in (True, 1.5, 10001):
            with self.assertRaises(EffectError):
                _expr(tx, {'value': 'number'}, {**bindings, 'number': value})
        tx.state['battle_context'] = None
        with self.assertRaisesRegex(EffectError, 'dungeon action'):
            _expr(tx, {'combat': 'attack'})

    def test_query_limit_and_private_evaluation_boundary(self):
        tx, bindings = self.fixture()
        evaluation = evaluation_input(tx)
        visible = calculation_input(tx)
        self.assertIn('player:bob:hand', evaluation['state']['zones'])
        self.assertNotIn('player:bob:hand', visible['state']['zones'])
        self.assertNotIn('bobhero', visible['state']['instances'])
        for key in ('rng_state', 'resolution_frames', 'pending_choice'):
            self.assertNotIn(key, evaluation['state'])
        evaluation['state']['zones']['player:bob:hand'].clear()
        self.assertEqual(tx.zone('hand', 'bob'), ['bobhero', 'bobweapon'])
        bindings['many'] = ['hero'] * 201
        with self.assertRaisesRegex(EffectError, 'too many candidates'):
            _query(tx, {'zone': 'bound', 'var': 'many'}, bindings)
        self.assertEqual(_query(tx, {'zone': 'active_hand', 'tag': '英雄'}), ['hero', 'militia'])


if __name__ == '__main__':
    unittest.main()
