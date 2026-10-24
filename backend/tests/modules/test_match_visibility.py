"""Real API isolation, private snapshot recovery and concurrent setup commands."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
import json
import sqlite3
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.modules.matches.table_projection import public_hand_instances
from backend.tests.support.matches import MatchApiFixture
from backend.tests.support.setup import config


def strings(value):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)
    elif isinstance(value, str):
        yield value


class MatchVisibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = MatchApiFixture()
        cls.f = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.__exit__(None, None, None)

    def ready_room(self, *, spire=False):
        alice, bob = self.f.account('Alice'), self.f.account('Bob')
        room = self.f.command(bob, self.f.create(alice), 'join')
        rules = config()
        rules['selection']['dungeon_features']['mode'] = 'manual'
        if spire:
            rules['selection']['environment']['fixed_card_ids'] = ['TS-0198']
            rules['selection']['guardian']['fixed_card_ids'] = ['TS-0673']
        room = self.f.save_config(alice, room, rules)
        return alice, bob, self.f.ready_all(room, alice, bob)

    def started(self, *, spire=False):
        alice, bob, room = self.ready_room(spire=spire)
        response = self.f.start(alice, room)
        self.assertEqual(response.status_code, 200, response.text)
        return alice, bob, room, response.json()

    def view(self, account, match_id, *, client=None):
        response = (client or self.f.client).get(f'/api/v1/matches/{match_id}', headers=account['headers'])
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def assert_private_snapshot_hidden(self, view, stored):
        exposed = set(strings(view))
        self.assertNotIn(stored['setup_request']['rng_seed'], exposed)
        forbidden = {'rng_state', 'rng_seed', 'seed', 'events', 'zones', 'instances', 'state',
                     'catalog_snapshot', 'setup_request', 'resolution_frames', 'workflow_steps',
                     'scheduled_effects', 'registered_triggers', 'next_instance_sequence',
                     'next_event_sequence', 'selected_thunderstones', 'frozen_config'}
        self.assertFalse(exposed & forbidden, exposed & forbidden)
        state = stored['state']
        if state is None:
            self.assertEqual(view['hand'], [])
            return
        viewer = view['viewer_player_id']
        hidden = set()
        revealed = public_hand_instances(stored['events'])
        for zone, pile in state['zones'].items():
            if zone.startswith(('dungeon:', 'monster_reserve:', 'village_supply:', 'hero_supply:')):
                hidden.update(pile)
            if zone.startswith('player:') and not zone.startswith(f'player:{viewer}:'):
                if zone.endswith(':hand'):
                    if not (state.get('turn_hand_public') and zone == f"player:{state['active_player_id']}:hand"):
                        hidden.update(set(pile) - revealed)
                elif zone.endswith((':draw', ':discard', ':aside')):
                    hidden.update(pile)
        self.assertFalse(hidden & exposed, hidden & exposed)
        self.assertEqual([card['instance_id'] for card in view['hand']], state['zones'][f'player:{viewer}:hand'])
        self.assertEqual(len(view['hand']), 6)

    def test_each_member_receives_own_cards_active_public_hand_and_public_board(self):
        alice, bob, _, started = self.started()
        stored = self.f.stored_match(started['id'])
        original = deepcopy(stored)
        views = [self.view(account, started['id']) for account in (alice, bob)]
        self.assertNotEqual(views[0]['viewer_player_id'], views[1]['viewer_player_id'])
        self.assertTrue(set(card['instance_id'] for card in views[0]['hand']).isdisjoint(
            card['instance_id'] for card in views[1]['hand']))
        for account, view in zip((alice, bob), views):
            self.assert_private_snapshot_hidden(view, stored)
            self.assertNotIn(account['email'], json.dumps(view))
            own = next(player for player in view['players'] if player['is_you'])
            self.assertEqual(own['user_id'], account['id'])
            self.assertTrue(all(player['hand_count'] == 6 and player['draw_count'] == 6 for player in view['players']))
            self.assertEqual(self.f.client.get('/api/v1/matches/current', headers=account['headers']).json()['match'], view)
        for field in ('supplies', 'dungeons', 'settings', 'disease_supply', 'turn'):
            self.assertEqual(views[0][field], views[1][field])
        self.assertEqual(self.f.stored_match(started['id']), original, 'GET must not advance or mutate authoritative state')

    def test_dungeon_preparation_is_private_and_restores_without_replaying_commands(self):
        alice, bob, _, match = self.started()
        accounts = {f'u-{account["id"]}': account for account in (alice, bob)}
        current = self.f.stored_match(match['id'])['state']['active_player_id']
        actor = accounts[current]
        other = next(account for pid, account in accounts.items() if pid != current)
        response = self.f.play(actor, match, {'type': 'ChooseAction', 'action': 'dungeon'})
        self.assertEqual(response.status_code, 200, response.text)
        own = response.json()
        self.assertEqual(own['turn']['subphase'], 'DUNGEON_PREPARE')
        self.assertTrue(own['legal_commands'])
        preparation = own['battle_preparation']
        self.assertIsNotNone(preparation)
        safe = preparation['context']['state']
        self.assertEqual(set(safe['players']), {current})
        self.assertTrue(all(zone == f'player:{current}:hand' or zone.startswith('hall:') for zone in safe['zones']))
        self.assertNotIn('rng_state', safe)
        stored = self.f.stored_match(match['id'])
        self.assert_private_snapshot_hidden({**own, 'battle_preparation': None}, stored)
        hidden = {item for zone, pile in stored['state']['zones'].items()
                  if zone.startswith('dungeon:') or zone.endswith(':draw') or
                  zone == f'player:u-{other["id"]}:hand' for item in pile}
        self.assertFalse(set(strings(preparation)) & hidden)
        waiting = self.view(other, match['id'])
        self.assertEqual(waiting['legal_commands'], [])
        self.assertIsNone(waiting['battle_preparation'])
        self.assertEqual(waiting['command_instances'], {})
        self.assert_private_snapshot_hidden(waiting, stored)
        with patch('backend.app.modules.matches.service.start_game', side_effect=AssertionError('must not rerun setup')):
            with TestClient(create_app()) as restored_client:
                self.assertEqual(self.view(actor, match['id'], client=restored_client), own)
                self.assertEqual(self.view(other, match['id'], client=restored_client), waiting)
        self.assertEqual(self.f.stored_match(match['id']), stored)

    def test_outsider_and_unauthenticated_requests_cannot_read_a_match(self):
        _, _, _, match = self.started()
        outsider = self.f.account('Outsider')
        route = f"/api/v1/matches/{match['id']}"
        self.assertEqual(self.f.client.get(route).status_code, 401)
        self.assertEqual(self.f.client.get('/api/v1/matches/current').status_code, 401)
        response = self.f.client.get(route, headers=outsider['headers'])
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(response.json()['error']['code'], 'match_forbidden')
        self.assertNotIn('hand', response.json())
        self.assertEqual(self.f.client.get('/api/v1/matches/current', headers=outsider['headers']).json(), {'match': None})
        self.assertEqual(self.f.client.get('/api/v1/matches/not-a-match', headers=outsider['headers']).status_code, 404)

    def test_flying_spire_pending_view_is_safe_and_survives_app_recreation(self):
        alice, bob, _, match = self.started(spire=True)
        self.assertEqual(match['status'], 'setup_pending')
        stored = self.f.stored_match(match['id'])
        self.assertIsNone(stored['state'])
        self.assertEqual(set(match['setup_choice']), {'kind', 'group_ids', 'feature_ids', 'group_a_count'})
        self.assertEqual(match['setup_choice']['group_a_count'], 2)
        self.assertEqual(len(match['setup_choice']['group_ids']), 4)
        self.assert_private_snapshot_hidden(match, stored)
        bob_view = self.view(bob, match['id'])
        self.assertFalse(bob_view['can_resolve_setup'])
        self.assertTrue(match['can_resolve_setup'])
        with patch('backend.app.modules.matches.service.start_game', side_effect=AssertionError('GET must not regenerate setup')):
            with TestClient(create_app()) as restarted:
                self.assertEqual(self.view(alice, match['id'], client=restarted), match)
                self.assertEqual(restarted.get('/api/v1/matches/current', headers=bob['headers']).json()['match'], bob_view)
        self.assertEqual(self.f.stored_match(match['id']), stored)

    def test_active_match_restores_exact_persisted_board_without_running_setup(self):
        alice, bob, _, match = self.started()
        before = self.f.stored_match(match['id'])
        views = {account['id']: self.view(account, match['id']) for account in (alice, bob)}
        with patch('backend.app.modules.matches.service.start_game', side_effect=AssertionError('restoring must read the saved state')):
            with TestClient(create_app()) as restarted:
                for account in (alice, bob):
                    restored = restarted.get('/api/v1/matches/current', headers=account['headers'])
                    self.assertEqual(restored.status_code, 200, restored.text)
                    self.assertEqual(restored.json()['match'], views[account['id']])
        self.assertEqual(self.f.stored_match(match['id']), before)

    def test_concurrent_distinct_start_commands_persist_only_one_match(self):
        alice, _, room = self.ready_room()
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda key: self.f.start(alice, room, command_id=key), [uuid4().hex, uuid4().hex]))
        self.assertEqual(sorted(response.status_code for response in results), [200, 409], [r.text for r in results])
        accepted = next(response.json() for response in results if response.status_code == 200)
        with closing(sqlite3.connect(self.f.db_path)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM matches WHERE room_id=?', (room['id'],)).fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT active_match_id FROM rooms WHERE id=?', (room['id'],)).fetchone()[0], accepted['id'])
        self.assertEqual(self.f.client.get('/api/v1/matches/current', headers=alice['headers']).json()['match'], accepted)

    def test_concurrent_identical_start_retries_reuse_one_saved_response(self):
        alice, _, room = self.ready_room()
        key = uuid4().hex
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: self.f.start(alice, room, command_id=key), range(2)))
        self.assertEqual([response.status_code for response in results], [200, 200], [r.text for r in results])
        self.assertEqual(results[0].json(), results[1].json())
        with closing(sqlite3.connect(self.f.db_path)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM matches WHERE room_id=?', (room['id'],)).fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM match_commands WHERE user_id=? AND command_id=?', (alice['id'], key)).fetchone()[0], 1)

    def test_concurrent_flying_spire_allocations_accept_only_one_version(self):
        alice, _, _, match = self.started(spire=True)
        frozen = self.f.stored_match(match['id'])
        groups, features = match['setup_choice']['group_ids'], match['setup_choice']['feature_ids']
        def allocate(ids):
            return self.f.client.post(f"/api/v1/matches/{match['id']}/setup-choice", headers=alice['headers'], json={
                'expected_version': match['version'], 'command_id': uuid4().hex,
                'group_a_ids': ids, 'group_a_feature_ids': features})
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(allocate, [groups[:2], groups[2:]]))
        self.assertEqual(sorted(response.status_code for response in results), [200, 409], [r.text for r in results])
        accepted = next(response.json() for response in results if response.status_code == 200)
        stored = self.f.stored_match(match['id'])
        self.assertEqual(stored['setup_request']['rng_seed'], frozen['setup_request']['rng_seed'])
        self.assertEqual(stored['version'], match['version'] + 1)
        self.assertEqual(accepted['status'], 'active')
        self.assertEqual({dungeon['id'] for dungeon in accepted['dungeons']}, {'a', 'b'})
        self.assert_private_snapshot_hidden(accepted, stored)
        self.assertEqual(self.view(alice, match['id']), accepted)


if __name__ == '__main__':
    unittest.main()
