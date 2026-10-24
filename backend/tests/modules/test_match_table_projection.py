"""Graphical table inventories, reveal lifetime and complete supply metadata."""

from copy import deepcopy
import json
import unittest

from backend.app.modules.matches.projection import build_match_view
from backend.tests.support.match_projection import sample_match


class MatchTableProjectionTests(unittest.TestCase):
    def test_active_hand_is_public_in_all_actions_including_new_cards_then_refill_is_private(self):
        for phase in ('TURN_START', 'VILLAGE_ABILITIES', 'VILLAGE_BUY', 'REST', 'DUNGEON_PREPARE', 'ACTION_END'):
            with self.subTest(phase=phase):
                match = sample_match(); match.state.update(subphase=phase, turn_hand_public=True)
                # A card gained/drawn during this turn is public without another show effect.
                match.state['zones']['player:alice:hand'].append('secret-alice-draw')
                match.state['zones']['player:alice:draw'] = []
                match.events.append({'kind': 'cards_drawn', 'player_id': 'alice', 'instance_ids': ['secret-alice-draw']})
                public = build_match_view(match, 2)['players'][0]['cards']['hand']
                self.assertEqual([item['card_id'] for item in public], ['TS-0001', 'TS-0002'])
                self.assertTrue(all(item['revealed'] for item in public))
                match.state.update(subphase='TURN_END_EFFECTS', turn_hand_public=False)
                hidden = build_match_view(match, 2)['players'][0]['cards']['hand']
                self.assertTrue(all(not item['revealed'] and 'card_id' not in item for item in hidden))
                match.events.append({'kind': 'cards_shown', 'player_id': 'alice', 'instance_ids': ['secret-alice-draw']})
                partial = build_match_view(match, 2)['players'][0]['cards']['hand']
                self.assertFalse(partial[0]['revealed']); self.assertTrue(partial[1]['revealed'])
                self.assertEqual(partial[1]['card_id'], 'TS-0002')

    def test_destruction_is_public_and_names_the_card_and_former_player(self):
        match = sample_match()
        match.events.append({'kind': 'card_destroyed', 'sequence': 3, 'instance_id': 'secret-bob-hand',
                             'card_id': 'TS-0004', 'source': 'player:bob:hand', 'destination': 'destroyed', 'reason': 'private-reason'})
        event = build_match_view(match, 1)['event_log'][-1]
        self.assertEqual(event, {'kind': 'card_destroyed', 'sequence': 3, 'card_id': 'TS-0004', 'player_id': 'bob'})
        self.assertIn('TS-0004', build_match_view(match, 1)['cards'])

    def test_inventories_are_order_independent_and_opponent_hand_is_masked(self):
        match = sample_match()
        match.state['zones']['player:alice:draw'].append('alice-discard')
        match.state['zones']['player:alice:discard'] = []
        match.state['zones']['player:bob:draw'].append('secret-bob-discard')
        match.state['zones']['player:bob:discard'] = []
        before = deepcopy(match.state)
        first = build_match_view(match, 1)
        for zone in ('player:alice:draw', 'player:bob:draw'):
            match.state['zones'][zone].reverse()
        second = build_match_view(match, 1)
        self.assertEqual(first['draw'], second['draw'])
        self.assertEqual(first['players'], second['players'])
        self.assertEqual([item['card_id'] for item in first['draw']], ['TS-0002', 'TS-0003'])
        bob = first['players'][1]['cards']
        self.assertEqual(bob['hand'], [{'instance_id': 'hidden:bob:0', 'revealed': False}])
        self.assertEqual([item['card_id'] for item in bob['draw']], ['TS-0005', 'TS-0006'])
        self.assertNotIn('secret-bob-', json.dumps(bob))
        self.assertNotIn('TS-0004', first['cards'])
        self.assertNotIn('TS-0008', first['cards'])
        self.assertEqual(before['instances'], match.state['instances'])

    def test_shown_hand_is_public_only_until_it_leaves_and_is_drawn_again(self):
        for event_kind in ('cards_shown', 'dungeon_hand_revealed'):
            with self.subTest(event_kind=event_kind):
                match = sample_match()
                match.events.append({'kind': event_kind, 'player_id': 'bob', 'instance_ids': ['secret-bob-hand']})
                shown = build_match_view(match, 1)['players'][1]['cards']['hand'][0]
                self.assertEqual(shown, {'instance_id': 'secret-bob-hand', 'card_id': 'TS-0004', 'revealed': True})
                match.events += [
                    {'kind': 'card_moved', 'instance_id': 'secret-bob-hand', 'source': 'player:bob:hand', 'destination': 'player:bob:discard'},
                    {'kind': 'cards_drawn', 'instance_ids': ['secret-bob-hand'], 'player_id': 'bob'},
                ]
                hidden = build_match_view(match, 1)['players'][1]['cards']['hand'][0]
                self.assertEqual(hidden, {'instance_id': 'hidden:bob:0', 'revealed': False})
                # Public log may retain the previously shown card title, never its hidden instance.
                self.assertNotIn('secret-bob-hand', json.dumps(build_match_view(match, 1)))

    def test_supply_preserves_sold_out_hero_levels_village_hero_stack_and_empty_piles(self):
        match = sample_match()
        match.catalog_snapshot['setup_index'] = {'groups': [
            {'kind': 'hero', 'randomizer_id': 'TS-0001', 'members': ['TS-0010', 'TS-0011', 'TS-0012']},
            {'kind': 'village', 'randomizer_id': 'TS-0002', 'members': ['TS-0005', 'TS-0006']},
        ]}
        match.state['zones']['village_supply:TS-0002'] = []
        match.state['zones']['village_supply:TS-0003'] = []
        supplies = {item['zone_id']: item for item in build_match_view(match, 1)['supplies']}
        hero = supplies['hero_supply:TS-0001']
        self.assertEqual(hero['cards'], [{'card_id': 'TS-0010', 'count': 0}, {'card_id': 'TS-0011', 'count': 1}, {'card_id': 'TS-0012', 'count': 2}])
        self.assertEqual(hero['top_card_id'], 'TS-0011')
        self.assertEqual(supplies['village_supply:TS-0002']['cards'], [{'card_id': 'TS-0005', 'count': 0}, {'card_id': 'TS-0006', 'count': 0}])
        empty = supplies['village_supply:TS-0003']
        self.assertEqual(empty['cards'], [{'card_id': 'TS-0003', 'count': 0}])
        self.assertIsNone(empty['top_card_id'])

    def test_own_aside_cards_and_empty_extra_hall_rank_are_projected(self):
        match = sample_match()
        match.state['zones']['player:alice:aside'] = ['alice-discard']
        match.state['zones']['player:alice:discard'] = []
        match.state['zones']['hall:main'] += [None, None, None]
        view = build_match_view(match, 1)
        self.assertEqual(view['aside'], [{'instance_id': 'alice-discard', 'card_id': 'TS-0003'}])
        self.assertEqual(view['dungeons'][0]['rank_count'], 4)
