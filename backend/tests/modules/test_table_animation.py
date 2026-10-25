"""Cross-area animations preserve observer privacy and committed movement order."""
import json
import unittest
from backend.app.modules.matches.animation_view import deck_motion_view
from backend.app.modules.matches.table_animation_view import table_motion_view
from backend.app.modules.matches.projection import build_match_view
from backend.tests.support.match_projection import sample_match


class TableAnimationTests(unittest.TestCase):
    def project(self, events, viewer='alice'):
        return table_motion_view(events, {'a': {'card_id': 'face-a'}, 'b': {'card_id': 'face-b'}}, viewer, {}, lambda card: card)

    def test_foreign_draws_hide_identity_and_shuffle_order_and_discard_is_not_duplicated(self):
        events = [
            {'sequence': 1, 'kind': 'player_deck_shuffled', 'player_id': 'bob', 'order': ['b', 'a']},
            {'sequence': 2, 'kind': 'cards_drawn', 'player_id': 'bob', 'instance_ids': ['b']},
            {'sequence': 3, 'kind': 'card_moved', 'instance_id': 'a', 'source': 'player:bob:hand', 'destination': 'player:bob:discard'},
            {'sequence': 4, 'kind': 'turn_hand_discarded', 'player_id': 'bob', 'instance_ids': ['a']},
        ]
        rows = self.project(events)
        self.assertEqual([row['kind'] for row in rows], ['player_shuffle_motion', 'table_card_motion', 'table_card_motion'])
        self.assertNotIn('card_id', rows[1]['steps'][0]['card'])
        self.assertNotIn('face-b', json.dumps(rows))
        self.assertEqual(rows[-1]['steps'][0]['card']['card_id'], 'face-a')
        self.assertEqual(rows[-1]['sequence'], 4)
        events[0]['order'].reverse()
        self.assertEqual(self.project(events), rows)

    def test_private_dungeon_peek_only_projects_faces_for_authorized_viewers(self):
        events = [
            {'sequence': 1, 'kind': 'card_moved', 'instance_id': 'a', 'source': 'dungeon:main', 'destination': 'revealed:main_1'},
            {'sequence': 2, 'kind': 'cards_revealed', 'zone': 'revealed:main_1', 'origin': 'dungeon:main', 'visible_to': ['alice'], 'instance_ids': ['a']},
        ]
        own = self.project(events)
        self.assertEqual(own[0]['steps'][0]['destination'], {'kind': 'owned', 'zone': 'revealed'})
        self.assertEqual(own[0]['steps'][0]['card']['card_id'], 'face-a')
        self.assertEqual(self.project(events, 'bob'), [])

    def test_attach_release_use_anchor_not_a_duplicate_aside_animation(self):
        events = [
            {'sequence': 1, 'kind': 'card_moved', 'instance_id': 'a', 'source': 'player:alice:hand', 'destination': 'player:alice:aside'},
            {'sequence': 2, 'kind': 'card_attached', 'instance_id': 'a', 'anchor_instance_id': 'b', 'attachment_kind': 'cage'},
        ]
        rows = self.project(events)
        self.assertEqual(rows[0]['steps'][0]['destination'], {'kind': 'attachment', 'anchor_id': 'b', 'attachment_kind': 'cage'})
        self.assertEqual(deck_motion_view(events, {'a': {'card_id': 'face-a'}}, 'alice', {}, lambda card: card), [])
        released = [{'sequence': 3, 'kind': 'card_moved', 'instance_id': 'a', 'source': 'player:alice:aside', 'destination': 'player:alice:discard'},
            {'sequence': 4, 'kind': 'attachment_released', 'anchor_instance_id': 'b', 'instance_ids': ['a']}]
        self.assertEqual(self.project(released)[0]['steps'][0]['source'], {'kind': 'attachment', 'anchor_id': 'b'})

    def test_full_chain_is_retained_and_exchange_has_both_public_endpoints(self):
        events = [{'sequence': i, 'kind': 'card_moved', 'instance_id': 'a', 'source': 'player:alice:hand', 'destination': 'player:bob:discard'} for i in range(1, 201)]
        self.assertEqual(len(self.project(events)), 200)
        rows = self.project([{'sequence': 201, 'kind': 'hall_monster_exchanged', 'target': 'a', 'replacement': 'b',
            'hall_zone': 'hall:main', 'origin': 'player:alice:hand', 'rank': 2}])
        self.assertEqual(len(rows[0]['steps']), 2)
        self.assertEqual(rows[0]['steps'][0]['source'], {'kind': 'hall', 'dungeon_id': 'main', 'rank': 2})
        self.assertEqual(rows[0]['steps'][1]['destination'], rows[0]['steps'][0]['source'])

    def test_temporary_tab_and_visible_attachments_do_not_expose_other_hidden_hands(self):
        match = sample_match()
        match.state['zones']['revealed:main_7'] = match.state['zones']['dungeon:main']; match.state['zones']['dungeon:main'] = []
        match.events = [{'sequence': 1, 'kind': 'cards_revealed', 'zone': 'revealed:main_7', 'visible_to': ['alice']}]
        match.state['attachments'] = {'hall-monster': [{'instance_id': 'alice-discard', 'kind': 'disease_after'}],
            'secret-bob-hand': [{'instance_id': 'secret-bob-draw', 'kind': 'cage'}]}
        own, other = build_match_view(match, 1), build_match_view(match, 2)
        self.assertEqual(own['revealed'][0]['instance_id'], 'secret-dungeon')
        self.assertEqual(other['revealed'], [])
        self.assertNotIn('secret-dungeon', json.dumps(other))
        self.assertEqual(own['dungeons'][0]['hall'][-1]['attachments'][0]['kind'], 'disease_after')
        self.assertNotIn('attachments', own['players'][1]['cards']['hand'][0])

    def test_destruction_has_exact_identity_only_for_viewers_with_access_to_the_temporary_zone(self):
        events = [{'sequence': 1, 'kind': 'cards_revealed', 'zone': 'player:bob:revealed_7', 'visible_to': ['alice', 'bob']},
            {'sequence': 2, 'kind': 'card_destroyed', 'instance_id': 'a', 'source': 'player:bob:revealed_7', 'reason': 'effect'}]
        instances = {'a': {'card_id': 'face-a'}}
        for player in ['alice', 'bob']:
            rows = deck_motion_view(events, instances, player, {}, lambda card: card)
            self.assertEqual(rows[0]['steps'], [{'kind': 'destroy', 'cards': [{'instance_id': 'a', 'card_id': 'face-a'}]}])
        self.assertEqual(deck_motion_view(events, instances, 'carol', {}, lambda card: card), [])
