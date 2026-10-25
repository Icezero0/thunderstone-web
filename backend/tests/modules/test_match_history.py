"""Real authenticated checkpoints, shared undo and host-only branch restoration."""
from uuid import uuid4
import unittest

from backend.tests.support.matches import MatchApiFixture
from backend.tests.support.setup import config


class MatchHistoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = MatchApiFixture()
        cls.f = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.__exit__(None, None, None)

    def create(self, tower=False):
        a, b = self.f.account("房主"), self.f.account("玩家")
        room = self.f.command(b, self.f.create(a), "join")
        rules = config(); rules["selection"]["dungeon_features"]["mode"] = "manual"
        if tower: rules['selection']['environment']['fixed_card_ids'] = ['TS-0198']
        room = self.f.save_config(a, room, rules)
        room = self.f.ready_all(room, a, b)
        view = self.f.successful(self.f.start(a, room, first_player={"mode": "fixed", "user_id": a["id"]}))
        return a, b, view

    def restore(self, account, view, **extra):
        return self.f.client.post(f"/api/v1/matches/{view['id']}/history/restore", headers=account['headers'],
            json={"expected_version": view['version'], "command_id": uuid4().hex, **extra})

    def play(self, account, view, type, **args):
        return self.f.successful(self.f.play(account, view, {"type": type, **args}))

    def test_other_player_undo_restores_full_state_and_next_undo_follows_parent(self):
        a, b, start = self.create()
        initial = self.f.stored_match(start['id'])['state']
        action = self.play(a, start, 'ChooseAction', action='rest')
        destroyed = self.play(a, action, 'RestDestroy', instance_id=action['hand'][0]['instance_id'])
        undone = self.f.successful(self.restore(b, destroyed))
        self.assertEqual(undone['history']['cursor'], action['history']['cursor'])
        self.assertEqual(len(undone['players'][0]['cards']['hand']), 6)
        again = self.f.successful(self.restore(b, undone))
        self.assertEqual(self.f.stored_match(start['id'])['state'], initial)
        self.assertGreater(again['version'], destroyed['version'])
        self.assertEqual(again['history']['epoch'], 2)
        self.assertFalse(again['history']['can_undo'])
        self.assertNotIn('rng_state', str(again['history']))

    def test_host_can_restore_abandoned_branch_but_other_player_cannot(self):
        a, b, view = self.create()
        original = self.play(a, view, 'ChooseAction', action='rest')
        restored = self.f.successful(self.restore(b, original))
        current = self.play(a, restored, 'ChooseAction', action='village')
        denied = self.restore(b, current, target_step=original['history']['cursor'])
        self.assertEqual(denied.status_code, 403)
        jumped = self.f.successful(self.restore(a, current, target_step=original['history']['cursor']))
        self.assertEqual(jumped['turn']['chosen_action'], 'rest')
        self.assertEqual(len(jumped['history']['entries']), 3)
        self.assertEqual(self.restore(a, current).status_code, 409)

    def test_retry_does_not_undo_twice_and_rng_is_restored(self):
        a, b, view = self.create()
        view = self.play(a, view, 'ChooseAction', action='rest')
        ready = self.play(a, view, 'SkipRestDestroy')
        ended = self.play(a, ready, 'FinishTurn')
        expected = self.f.stored_match(ended['id'])['state']
        command = {'expected_version': ended['version'], 'command_id': uuid4().hex}
        url = f"/api/v1/matches/{ended['id']}/history/restore"
        undo = self.f.successful(self.f.client.post(url, headers=b['headers'], json=command))
        retry = self.f.successful(self.f.client.post(url, headers=b['headers'], json=command))
        self.assertEqual(undo, retry)
        replayed = self.play(a, undo, 'FinishTurn')
        self.assertEqual(self.f.stored_match(replayed['id'])['state'], expected)
        outsider = self.f.account('局外人')
        self.assertEqual(self.restore(outsider, replayed).status_code, 403)

    def test_restoring_setup_choice_preserves_frozen_request_and_can_generate_identical_board(self):
        a, b, pending = self.create(tower=True)
        self.assertEqual(pending['status'], 'setup_pending')
        initial = self.f.stored_match(pending['id'])
        def choose(view):
            return self.f.successful(self.f.client.post(f"/api/v1/matches/{view['id']}/setup-choice", headers=a['headers'], json={
                'expected_version': view['version'], 'command_id': uuid4().hex,
                'group_a_ids': pending['setup_choice']['group_ids'][:2], 'group_a_feature_ids': []}))
        active = choose(pending)
        board = self.f.stored_match(active['id'])['state']
        restored = self.f.successful(self.restore(b, active))
        self.assertEqual(restored['status'], 'setup_pending')
        self.assertEqual(self.f.stored_match(active['id'])['setup_request'], initial['setup_request'])
        self.assertEqual(restored['setup_choice'], pending['setup_choice'])
        replayed = choose(restored)
        self.assertEqual(self.f.stored_match(replayed['id'])['state'], board)
