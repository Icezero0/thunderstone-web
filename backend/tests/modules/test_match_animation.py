"""Animation projection carries committed own movements without hidden order."""
from copy import deepcopy
import json
import unittest

from backend.app.modules.matches.animation_view import deck_motion_view
from backend.app.modules.matches.interaction_view import event_view
from backend.app.modules.matches.table_animation_view import table_motion_view
from backend.app.modules.matches.projection import build_match_view
from backend.tests.support.match_projection import sample_match
from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.app.integrations.game_engine.setup import start_game
from backend.app.integrations.game_engine.turn import apply_command
from backend.tests.support.effects.mechanic_cases import Fixture
from backend.tests.support.setup import config, request


class MatchAnimationTests(unittest.TestCase):
    def project(self, events, instances, viewer='alice', cards=None):
        return deck_motion_view(events, instances, viewer, cards or {}, lambda card: card)

    def test_battle_destruction_returned_to_supply_is_public_and_keeps_its_animation_position(self):
        # Regression: v236, battle 927 -> militia returned 930 -> monster 932.
        events = [
            {'sequence': 927, 'kind': 'battle_resolved', 'player_id': 'alice'},
            {'sequence': 929, 'kind': 'card_moved', 'instance_id': 'militia',
             'source': 'player:alice:hand', 'destination': 'basic_supply'},
            {'sequence': 930, 'kind': 'destruction_returned_to_supply', 'instance_id': 'militia',
             'card_id': 'TS-0001', 'source': 'player:alice:hand', 'destination': 'basic_supply', 'reason': 'after_battle'},
            {'sequence': 932, 'kind': 'monster_defeated', 'player_id': 'alice'},
        ]
        rows = self.project(events, {'militia': {'card_id': 'TS-0001'}})
        self.assertEqual(rows, [])  # Return flights never dissolve the card.
        for viewer in ('alice', 'bob'):
            flights = table_motion_view(events, {'militia': {'card_id': 'TS-0001'}}, viewer, {}, lambda card: card)
            self.assertEqual([row['sequence'] for row in flights], [930])
            step = flights[0]['steps'][0]
            self.assertEqual(step['destination'], {'kind': 'supply', 'zone_id': 'basic_supply:TS-0001', 'card_id': 'TS-0001'})
            self.assertEqual(step['card']['card_id'], 'TS-0001')
            self.assertEqual(step['source'], {'kind': 'owned', 'zone': 'hand'} if viewer == 'alice'
                             else {'kind': 'player', 'player_id': 'alice', 'zone': 'hand'})
            if viewer == 'bob': self.assertNotEqual(step['card']['instance_id'], 'militia')
        self.assertEqual(self.project(events, {}, viewer='bob'), [])
        public = event_view(events, {}, lambda card: card)
        self.assertEqual([row['sequence'] for row in public], [927, 930, 932])
        self.assertEqual(public[1], {'kind': 'destruction_returned_to_supply', 'sequence': 930,
                                    'card_id': 'TS-0001', 'player_id': 'alice', 'cause': 'after_battle'})
        events[2]['reason'] = 'hero_upgrade'
        self.assertEqual(table_motion_view(events, {'militia': {'card_id': 'TS-0001'}}, 'alice', {}, lambda card: card), [])
        self.assertEqual(self.project(events, {'militia': {'card_id': 'TS-0001'}}), [])
        self.assertEqual(event_view(events, {}, lambda card: card)[1]['cause'], 'hero_upgrade')

    def test_shuffle_order_and_other_players_draws_are_never_exposed(self):
        instances = {key: {'card_id': 'TS-0001'} for key in ['old', 'secret-first', 'secret-second', 'unseen-bob']}
        events = [
            {'sequence': 1, 'kind': 'player_deck_shuffled', 'player_id': 'alice', 'order': ['secret-second', 'secret-first']},
            {'sequence': 2, 'kind': 'cards_drawn', 'player_id': 'alice', 'instance_ids': ['old', 'secret-second']},
            {'sequence': 3, 'kind': 'cards_drawn', 'player_id': 'bob', 'instance_ids': ['unseen-bob']},
        ]
        result = self.project(events, instances)
        self.assertEqual(len(result), 1)
        steps = result[0]['steps']
        self.assertEqual([step['kind'] for step in steps], ['move', 'shuffle', 'move'])
        self.assertEqual(steps[0]['cards'][0]['instance_id'], 'old')
        self.assertEqual(steps[1], {'kind': 'shuffle'})
        self.assertNotIn('secret-first', json.dumps(result))
        self.assertNotIn('unseen-bob', json.dumps(result))
        reversed_order = deepcopy(events)
        reversed_order[0]['order'].reverse()
        self.assertEqual(result, self.project(reversed_order, instances))

    def test_turn_cleanup_is_batched_once_and_supply_gain_keeps_exact_identity(self):
        instances = {'a': {'card_id': 'TS-0001'}, 'b': {'card_id': 'TS-0002'}, 'new': {'card_id': 'TS-0003'}}
        events = [
            {'sequence': 1, 'kind': 'card_moved', 'instance_id': 'a', 'source': 'player:alice:hand', 'destination': 'player:alice:discard'},
            {'sequence': 2, 'kind': 'card_moved', 'instance_id': 'b', 'source': 'player:alice:hand', 'destination': 'player:alice:discard'},
            {'sequence': 3, 'kind': 'turn_hand_discarded', 'player_id': 'alice', 'instance_ids': ['a', 'b']},
            {'sequence': 4, 'kind': 'card_bought', 'player_id': 'alice', 'instance_id': 'new', 'card_id': 'TS-0003'},
        ]
        rows = self.project(events, instances)
        self.assertEqual([row['sequence'] for row in rows], [3, 4])
        self.assertEqual(len(rows[0]['steps'][0]['cards']), 2)
        self.assertEqual(rows[1]['steps'][0]['cards'][0]['instance_id'], 'new')
        self.assertEqual(self.project(events, instances, 'bob'), [])

    def test_own_zone_moves_are_projected_but_other_player_and_dungeon_moves_are_not(self):
        paths = [('discard', 'hand'), ('hand', 'draw'), ('hand', 'aside'), ('aside', 'hand'), ('draw', 'revealed_10'), ('revealed_10', 'discard')]
        events = [{'sequence': i + 1, 'kind': 'card_moved', 'instance_id': 'a',
                   'source': f'player:alice:{source}', 'destination': f'player:alice:{target}'} for i, (source, target) in enumerate(paths)]
        events += [{'sequence': 7, 'kind': 'card_moved', 'instance_id': 'b', 'source': 'dungeon:main', 'destination': 'revealed:main'},
                   {'sequence': 8, 'kind': 'card_moved', 'instance_id': 'b', 'source': 'player:bob:draw', 'destination': 'player:bob:hand'}]
        rows = self.project(events, {'a': {'card_id': 'TS-0001'}, 'b': {'card_id': 'private'}})
        self.assertEqual([row['sequence'] for row in rows], [1, 2, 3, 4, 5, 6])
        self.assertNotIn('private', json.dumps(rows))
        self.assertEqual(rows[-1]['steps'][0]['source'], 'revealed')

    def test_gain_notifications_deduplicate_but_a_later_gain_of_the_same_instance_is_preserved(self):
        base = {'player_id': 'alice', 'instance_id': 'weapon', 'source': 'village_supply:weapon', 'destination': 'player:alice:hand'}
        events = [dict(base, sequence=1, kind='effect_card_gained'), dict(base, sequence=2, kind='card_gained'),
                  {'sequence': 3, 'kind': 'card_moved', 'instance_id': 'weapon', 'source': 'player:alice:hand', 'destination': 'village_supply:weapon'},
                  dict(base, sequence=4, kind='card_gained')]
        rows = self.project(events, {'weapon': {'card_id': 'TS-0241'}})
        self.assertEqual([row['sequence'] for row in rows], [1, 4])
        self.assertEqual(rows[0]['steps'][0]['destination'], 'hand')

    def test_match_projection_sends_only_the_viewers_motion_and_public_hall_coordinates(self):
        match = sample_match()
        match.events = [
            {'sequence': 1, 'kind': 'cards_drawn', 'player_id': 'alice', 'instance_ids': ['alice-hand']},
            {'sequence': 2, 'kind': 'cards_drawn', 'player_id': 'bob', 'instance_ids': ['secret-bob-hand']},
            {'sequence': 3, 'kind': 'hall_cards_swapped', 'first': 'secret-first', 'second': 'secret-second',
             'hall_zone': 'hall:main', 'first_rank': 1, 'second_rank': 2},
            {'sequence': 4, 'kind': 'thunderstone_acquired', 'player_id': 'alice', 'instance_id': 'hall-monster',
             'hall_zone': 'hall:main', 'rank': 1, 'hall_rank_count': 3},
        ]
        for user, own, hidden in [(1, 'alice-hand', 'secret-bob-hand'), (2, 'secret-bob-hand', 'alice-hand')]:
            view = build_match_view(match, user)
            serialized = json.dumps(view['card_motion'])
            self.assertIn(own, serialized)
            self.assertNotIn(hidden, serialized)
            self.assertNotIn('secret-', json.dumps(view['event_log']))
            self.assertEqual(view['event_log'][2]['second_rank'], 2)
            self.assertEqual(view['event_log'][3]['rank'], 1)
        rows = event_view([{'sequence': 1, 'kind': 'card_destroyed', 'source': 'hero_supply:test',
                           'card_id': 'TS-0300', 'instance_id': 'private-hero'}], {}, lambda card: card)
        self.assertEqual(rows[0]['source_supply'], 'hero_supply:test')
        self.assertNotIn('private-hero', json.dumps(rows))

    def test_real_chieftains_drum_discard_then_draw_and_optional_shuffle(self):
        snapshot = load_catalog(); rules = load_ruleset(snapshot.cards)
        settings = config(); settings['selection']['dungeon_features']['mode'] = 'manual'
        base = start_game(request(settings, seed='drum-animation'), snapshot=snapshot)['state']
        for guess, remaining, discard in [('hero', 2, 0), ('village', 2, 0), ('hero', 0, 2), ('hero', 1, 2)]:
            with self.subTest(guess=guess, remaining=remaining):
                f = Fixture(base, snapshot.cards, rules, rules.mechanics[0]); f.tx.ruleset = rules
                drum = f.add('TS-0299')
                top = f.add('TS-0001', f'player:{f.player}:draw')
                for _ in range(remaining): f.add('TS-0002', f'player:{f.player}:draw')
                for _ in range(discard): f.add('TS-0003', f'player:{f.player}:discard')
                result = apply_command(f.tx.state, {'type': 'ActivateAbility', 'player_id': f.player,
                    'ability_id': 'TS-0299-A01', 'source_instance_id': drum}, snapshot=snapshot)
                result = apply_command(result['state'], {'type': 'ResolveValueChoice', 'player_id': f.player, 'value': guess}, snapshot=snapshot)
                motions = deck_motion_view(result['events'], result['state']['instances'], f.player, snapshot.cards, lambda card: card)
                steps = [step for row in motions for step in row['steps']]
                self.assertEqual((steps[0]['source'], steps[0]['destination']), ('draw', 'revealed'))
                self.assertEqual((steps[1]['source'], steps[1]['destination']), ('revealed', 'discard'))
                self.assertEqual(steps[0]['cards'][0]['instance_id'], top)
                draws = [step for step in steps if step.get('destination') == 'hand']
                self.assertEqual(sum(len(step['cards']) for step in draws), 2 if guess == 'hero' else 0)
                self.assertEqual(any(step['kind'] == 'shuffle' for step in steps), guess == 'hero' and remaining < 2)
