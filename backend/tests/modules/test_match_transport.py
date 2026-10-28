"""Compact transport, disclosure boundaries and long-match event growth."""
import json
import unittest
from uuid import uuid4
from time import perf_counter
from statistics import median

from backend.tests.support.matches import MatchApiFixture
from backend.tests.support.setup import config


class MatchTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = MatchApiFixture()
        cls.f = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.__exit__(None, None, None)

    def test_long_match_uses_bounded_event_batches_and_private_prediction_projection(self):
        a, b = self.f.account(), self.f.account()
        room = self.f.command(b, self.f.create(a), 'join')
        rules = config(); rules['selection']['dungeon_features']['mode'] = 'manual'
        room = self.f.save_config(a, room, rules); room = self.f.ready_all(room, a, b)
        view = self.f.successful(self.f.start(a, room, first_player={'mode': 'fixed', 'user_id': a['id']}))
        url = f"/api/v1/matches/{view['id']}"
        view = self.f.successful(self.f.client.get(url + '?compact=true', headers=a['headers']))
        accounts = {row['player_id']: a if row['user_id'] == a['id'] else b for row in view['players']}
        sizes, timings = [], []
        for turn in range(24):
            actor = accounts[view['turn']['active_player_id']]
            for command in ({'type': 'ChooseAction', 'action': 'rest'}, {'type': 'SkipRestDestroy'}, {'type': 'FinishTurn'}):
                cursor = view['sync']['event_sequence']
                started = perf_counter()
                response = self.f.client.post(url + '/commands', headers=actor['headers'], json={
                    'expected_version': view['version'], 'command_id': uuid4().hex, 'command': command,
                    'sync': {'after_event': cursor, 'epoch': 0}})
                timings.append((perf_counter() - started) * 1000)
                view = self.f.successful(response)
                self.assertEqual(view['history']['entries'], [])
                self.assertTrue(all(e['sequence'] > cursor for e in view['event_log']))
                if command['type'] == 'ChooseAction':
                    prediction = view['action_prediction']
                    wire = json.dumps(prediction)
                    self.assertNotIn('rng_state', wire)
                    state = self.f.stored_match(view['id'])['state']
                    private_ids = {item for zone, pile in state['zones'].items() for item in pile if
                        zone.startswith('dungeon:') or zone.endswith(':draw') or
                        zone.endswith(':hand') and zone != f"player:{view['viewer_player_id']}:hand"}
                    self.assertFalse(private_ids.intersection(prediction['state']['instances']))
                    if turn == 0:
                        other = b if actor == a else a
                        other_view = self.f.successful(self.f.client.get(url + '?compact=true', headers=other['headers']))
                        self.assertNotIn('action_prediction', other_view)
                if command['type'] == 'FinishTurn':
                    sizes.append(len(response.content))
        full = self.f.client.get(url, headers=actor['headers'])
        self.f.successful(full)
        self.assertLess(sizes[-1], sizes[0] * 1.15)
        self.assertGreater(len(full.content), sizes[-1])
        print(f'\nTRANSPORT 24 turns: compact first/last={sizes[0]}/{sizes[-1]} bytes; '
              f'full final={len(full.content)} bytes; first/last 9 command median={median(timings[:9]):.1f}/{median(timings[-9:]):.1f} ms')
