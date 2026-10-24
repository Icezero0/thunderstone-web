"""Upgrade a nonempty pre-match SQLite database without losing existing users/rooms."""

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from alembic import command
from alembic.config import Config

from backend.app.core.config import get_settings
from backend.app.core.paths import PROJECT_ROOT
from backend.app.core.startup import _upgrade_database
from backend.tests.support.setup import config


class MatchMigrationTests(unittest.TestCase):
    def test_upgrade_0003_preserves_accounts_rooms_readiness_and_foreign_keys(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'existing-0003.db'
            with patch.dict(os.environ, {'THUNDERSTONE_DATABASE_URL': f'sqlite+aiosqlite:///{path.as_posix()}'}):
                get_settings.cache_clear()
                try:
                    command.upgrade(Config(str(PROJECT_ROOT / 'backend/alembic.ini')), '0003_waiting_rooms')
                    rules = config()
                    rules['counts']['village_groups'] = 7
                    with closing(sqlite3.connect(path)) as db:
                        db.execute('PRAGMA foreign_keys=ON')
                        db.executemany('INSERT INTO users(id,email,username,hashed_password,token_version) VALUES(?,?,?,?,?)', [
                            (101, 'alice@example.test', '旧房主', 'retained-test-hash-a', 3),
                            (202, 'bob@example.test', '已准备玩家', 'retained-test-hash-b', 5),
                            (303, 'carol@example.test', '未准备玩家', 'retained-test-hash-c', 0)])
                        db.executemany('INSERT INTO rooms(id,name,host_user_id,status,version,config_version,config) VALUES(?,?,?,?,?,?,?)', [
                            ('retained-room', '已有房间', 101, 'waiting', 19, 7, json.dumps(rules, ensure_ascii=False)),
                            ('closed-room', '历史房间', 101, 'closed', 4, 2, json.dumps(config()))])
                        db.executemany('INSERT INTO room_players(id,room_id,user_id,ready_config_version) VALUES(?,?,?,?)', [
                            (1, 'retained-room', 101, 7), (2, 'retained-room', 202, 7), (3, 'retained-room', 303, None)])
                        db.commit()
                        users = db.execute('SELECT * FROM users ORDER BY id').fetchall()
                        rooms = db.execute('SELECT * FROM rooms ORDER BY id').fetchall()
                        memberships = db.execute('SELECT * FROM room_players ORDER BY id').fetchall()
                    # Same migration entry point used at normal application startup.
                    _upgrade_database()
                    with closing(sqlite3.connect(path)) as db:
                        db.execute('PRAGMA foreign_keys=ON')
                        self.assertEqual(db.execute('SELECT version_num FROM alembic_version').fetchone()[0], '0007_room_visibility')
                        self.assertEqual(db.execute('SELECT * FROM users ORDER BY id').fetchall(),
                                         [(*row, None) for row in users])
                        columns = 'id,name,host_user_id,status,version,config_version,config,created_at,updated_at'
                        self.assertEqual(db.execute(f'SELECT {columns} FROM rooms ORDER BY id').fetchall(), rooms)
                        self.assertEqual(db.execute('SELECT * FROM room_players ORDER BY id').fetchall(), memberships)
                        self.assertEqual(db.execute('SELECT active_match_id FROM rooms').fetchall(), [(None,), (None,)])
                        self.assertEqual(db.execute('SELECT is_public FROM rooms').fetchall(), [(1,), (1,)])
                        self.assertEqual(db.execute('SELECT COUNT(*) FROM matches').fetchone()[0], 0)
                        self.assertEqual(db.execute('SELECT COUNT(*) FROM match_commands').fetchone()[0], 0)
                        self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
                        with self.assertRaises(sqlite3.IntegrityError):
                            db.execute("UPDATE room_players SET room_id='missing-room' WHERE id=1")
                        db.rollback()
                        with self.assertRaises(sqlite3.IntegrityError):
                            db.execute("UPDATE rooms SET active_match_id='missing-match' WHERE id='retained-room'")
                        db.rollback()
                        self.assertEqual(db.execute('SELECT * FROM room_players ORDER BY id').fetchall(), memberships)
                finally:
                    get_settings.cache_clear()


if __name__ == '__main__':
    unittest.main()
