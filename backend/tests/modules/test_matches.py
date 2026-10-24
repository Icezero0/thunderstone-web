"""Persisted setup through real authentication, migrations and TypeScript rules."""

from copy import deepcopy
from contextlib import closing
import sqlite3
import unittest
from unittest.mock import patch
from uuid import uuid4

from backend.app.integrations.game_engine.api import EffectCompileError, SharedEngineUnavailable
from backend.tests.support.matches import MatchApiFixture
from backend.tests.support.setup import config


class MatchApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = MatchApiFixture()
        cls.f = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.__exit__(None, None, None)

    def room(self, *, tower=False, ready=True):
        a,b = self.f.account("房主"),self.f.account("玩家")
        r=self.f.command(b,self.f.create(a),"join")
        c=config();c['selection']['dungeon_features']['mode']='manual'
        if tower:c['selection']['environment']['fixed_card_ids']=['TS-0198']
        r=self.f.save_config(a,r,c)
        if ready:r=self.f.ready_all(r,a,b)
        return a,b,r

    def current_room(self, account):
        return self.f.client.get('/api/v1/rooms/current',headers=account['headers']).json()['room']

    def test_private_start_and_cancel_keep_room_codes_out_of_public_notifications(self):
        host, guest, observer = self.f.account(), self.f.account(), self.f.account()
        room = self.f.command(guest, self.f.create(host, is_public=False), "join")
        settings = config(); settings["selection"]["dungeon_features"]["mode"] = "manual"
        room = self.f.ready_all(self.f.save_config(host, room, settings), host, guest)
        with self.f.client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "auth", "payload": {"token": observer["token"]}})
            self.assertEqual(ws.receive_json()["type"], "ack")
            match = self.f.successful(self.f.start(host, room))
            self.assertEqual(ws.receive_json(), {"v": 1, "type": "room_changed", "payload": {}})
            cancelled = self.f.client.post(f"/api/v1/matches/{match['id']}/cancel", headers=host["headers"],
                json={"expected_version": match["version"], "command_id": uuid4().hex})
            self.assertEqual(cancelled.status_code, 200)
            self.assertEqual(ws.receive_json(), {"v": 1, "type": "room_changed", "payload": {}})
        self.assertFalse(self.current_room(host)["is_public"])

    def choice(self, account, view, *, command_id=None, **overrides):
        raw=self.f.stored_match(view['id'])['setup_choice']
        data={'expected_version':view['version'],'command_id':command_id or uuid4().hex,
              'group_a_ids':raw['group_ids'][:2],'group_a_feature_ids':[]}
        data.update(overrides)
        return self.f.client.post(f"/api/v1/matches/{view['id']}/setup-choice",headers=account['headers'],json=data)

    def test_only_host_can_start_after_every_player_accepts_current_configuration(self):
        a,b,r=self.room(ready=False)
        denied=self.f.start(b,r)
        self.assertEqual(denied.status_code,403)
        self.assertEqual(self.f.start(a,r).json()['error']['code'],'players_not_ready')
        r=self.f.command(a,r,'ready',ready=True)
        self.assertEqual(self.f.start(a,r).status_code,409)
        r=self.f.command(b,r,'ready',ready=True)
        view=self.f.successful(self.f.start(a,r))
        self.assertEqual(view['status'],'active')
        saved=self.f.stored_match(view['id'])
        self.assertEqual([p['user_id'] for p in saved['frozen_players']],[a['id'],b['id']])
        self.assertEqual(saved['setup_request']['config'],r['config'])
        self.assertEqual(saved['setup_request']['first_player'],{'mode':'random'})
        self.assertEqual(len(saved['setup_request']['rng_seed']),64)
        self.assertTrue(saved['state']);self.assertTrue(saved['events'])
        locked=self.current_room(a)
        self.assertEqual((locked['status'],locked['active_match_id'],locked['version']),('playing',view['id'],r['version']+1))

    def test_fixed_first_player_and_untrusted_setup_fields(self):
        a,b,r=self.room(); outsider=self.f.account()
        self.assertEqual(self.f.start(a,r,first_player={'mode':'fixed','user_id':outsider['id']}).status_code,422)
        for extra in ({'rng_seed':'chosen'},{'player_ids':['intruder']},{'user_id':b['id']},{'state':{}}):
            result=self.f.client.post(f"/api/v1/rooms/{r['id']}/start",headers=a['headers'],json={
                'expected_version':r['version'],'command_id':uuid4().hex,**extra})
            self.assertEqual(result.status_code,422,result.text)
        view=self.f.successful(self.f.start(a,r,first_player={'mode':'fixed','user_id':b['id']}))
        saved=self.f.stored_match(view['id'])
        self.assertEqual(saved['state']['first_player_id'],f"u-{b['id']}")

    def test_stale_start_does_not_create_a_match_or_lock_room(self):
        a,b,r=self.room();stale={**r,'version':r['version']-1}
        result=self.f.start(a,stale)
        self.assertEqual(result.status_code,409)
        self.assertIsNone(self.current_room(a)['active_match_id'])
        with closing(sqlite3.connect(self.f.db_path)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM matches WHERE room_id=?',(r['id'],)).fetchone()[0],0)

    def test_start_retry_returns_original_response_and_command_key_cannot_change_payload(self):
        a,b,r=self.room();key=uuid4().hex
        first=self.f.successful(self.f.start(a,r,command_id=key))
        with patch('backend.app.modules.matches.service.calculate_setup',side_effect=AssertionError('must not rerun')):
            retry=self.f.successful(self.f.start(a,r,command_id=key))
        self.assertEqual(retry,first)
        changed=self.f.start(a,r,command_id=key,first_player={'mode':'fixed','user_id':b['id']})
        self.assertEqual(changed.status_code,409)
        self.assertEqual(changed.json()['error']['code'],'command_reused')
        self.assertEqual(self.current_room(a)['version'],r['version']+1)

    def test_engine_failure_rolls_back_room_and_command(self):
        a,b,r=self.room();key=uuid4().hex
        with patch('backend.app.modules.matches.service.rules_revision',side_effect=SharedEngineUnavailable('offline')):
            result=self.f.start(a,r,command_id=key)
        self.assertEqual(result.status_code,503)
        self.assertEqual(self.current_room(a),r)
        self.assertEqual(self.f.start(a,r,command_id=key).status_code,200)

    def test_playing_room_rejects_mutation_and_members_recover_its_match(self):
        a,b,r=self.room();view=self.f.successful(self.f.start(a,r));locked=self.current_room(a)
        for action,extra in [('ready',{'ready':False}),('leave',{}),('close',{}),('join',{})]:
            result=self.f.client.post(f"/api/v1/rooms/{r['id']}/{action}",headers=a['headers'],json={
                'expected_version':locked['version'],**extra})
            self.assertEqual(result.status_code,409,result.text)
            self.assertEqual(result.json()['error']['code'],'room_playing')
        result=self.f.client.patch(f"/api/v1/rooms/{r['id']}/config",headers=a['headers'],json={
            'expected_version':locked['version'],'config':r['config']})
        self.assertEqual(result.status_code,409)
        for account in (a,b):
            self.assertEqual(self.current_room(account)['active_match_id'],view['id'])
            self.assertEqual(self.f.client.get('/api/v1/matches/current',headers=account['headers']).json()['match']['id'],view['id'])

    def test_tower_choice_uses_frozen_request_and_catalog_then_retries_without_recalculation(self):
        a,b,r=self.room(tower=True);view=self.f.successful(self.f.start(a,r))
        self.assertEqual(view['status'],'setup_pending')
        before=self.f.stored_match(view['id']);key=uuid4().hex
        with patch('backend.app.modules.matches.service.load_catalog_snapshot',side_effect=AssertionError('use frozen snapshot')):
            complete=self.f.successful(self.choice(a,view,command_id=key))
        self.assertEqual((complete['status'],complete['version']),('active',2))
        after=self.f.stored_match(view['id'])
        self.assertEqual(after['catalog_snapshot'],before['catalog_snapshot'])
        for field in ('rng_seed','config','player_ids','first_player','catalog_version'):
            self.assertEqual(after['setup_request'][field],before['setup_request'][field])
        self.assertEqual(after['state']['selected_groups']['monster'],before['setup_choice']['group_ids'])
        # Explicit original request; the saved pending prompt has been cleared.
        payload={'expected_version':1,'command_id':key,'group_a_ids':before['setup_choice']['group_ids'][:2],
                 'group_a_feature_ids':[]}
        with patch('backend.app.modules.matches.service.calculate_setup',side_effect=AssertionError('must not rerun')):
            retry=self.f.client.post(f"/api/v1/matches/{view['id']}/setup-choice",headers=a['headers'],json=payload)
        self.assertEqual(retry.json(),complete)

    def test_setup_choice_rejects_wrong_host_version_and_group_without_mutation(self):
        a,b,r=self.room(tower=True);view=self.f.successful(self.f.start(a,r))
        before=self.f.stored_match(view['id'])
        self.assertEqual(self.choice(b,view).status_code,403)
        self.assertEqual(self.choice(a,view,expected_version=99).status_code,409)
        self.assertEqual(self.choice(a,view,group_a_ids=['invalid','also-invalid']).status_code,422)
        self.assertEqual(self.f.stored_match(view['id']),before)

    def test_setup_choice_rejects_rules_change_including_uncompilable_old_catalogue(self):
        a,b,r=self.room(tower=True);view=self.f.successful(self.f.start(a,r))
        before=self.f.stored_match(view['id'])
        for override in ({'return_value':{'engine_version':'changed','effects_version':before['effects_version']}},
                         {'side_effect':EffectCompileError('new effects require new cards')}):
            with self.subTest(override=override),patch('backend.app.modules.matches.service.rules_revision',**override):
                rejected=self.choice(a,view)
            self.assertEqual(rejected.status_code,409,rejected.text)
            self.assertEqual(rejected.json()['error']['code'],'match_rules_changed')
            self.assertEqual(self.f.stored_match(view['id']),before)

    def test_cancel_reopens_room_clears_ready_and_preserves_history_idempotently(self):
        for tower in (False,True):
            with self.subTest(tower=tower):
                a,b,r=self.room(tower=tower);view=self.f.successful(self.f.start(a,r))
                before=self.f.stored_match(view['id']);key=uuid4().hex
                url=f"/api/v1/matches/{view['id']}/cancel";payload={'expected_version':1,'command_id':key}
                self.assertEqual(self.f.client.post(url,headers=b['headers'],json=payload).status_code,403)
                result=self.f.successful(self.f.client.post(url,headers=a['headers'],json=payload))
                self.assertEqual((result['status'],result['version']),('cancelled',2))
                self.assertEqual(self.f.client.post(url,headers=a['headers'],json=payload).json(),result)
                room=self.current_room(a)
                self.assertEqual((room['status'],room['active_match_id'],room['version']),('waiting',None,r['version']+2))
                self.assertFalse(any(p['ready'] for p in room['players']))
                self.assertEqual(len(room['players']),2)
                self.assertIsNone(self.f.client.get('/api/v1/matches/current',headers=b['headers']).json()['match'])
                after=self.f.stored_match(view['id'])
                self.assertEqual(after['state'],before['state'])
                self.assertEqual(after['events'],before['events'])
                self.assertEqual(self.f.client.get(f"/api/v1/matches/{view['id']}",headers=b['headers']).status_code,200)
                next_view=self.f.successful(self.f.start(a,self.f.ready_all(room,a,b)))
                self.assertNotEqual(next_view['id'],view['id'])
