"""The finished status upgrade preserves a populated, actively referenced match."""

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


class MatchCommandMigrationTests(unittest.TestCase):
    def test_upgrade_0004_keeps_live_match_room_reference_and_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "existing-0004.db"
            with patch.dict(os.environ, {"THUNDERSTONE_DATABASE_URL": f"sqlite+aiosqlite:///{path.as_posix()}"}):
                get_settings.cache_clear()
                try:
                    command.upgrade(Config(str(PROJECT_ROOT / "backend/alembic.ini")), "0004_persistent_matches")
                    tables = ("users", "rooms", "room_players", "matches", "match_commands")
                    with closing(sqlite3.connect(path)) as db:
                        db.execute("PRAGMA foreign_keys=ON")
                        db.execute("INSERT INTO users(id,email,username,hashed_password,token_version) VALUES(1,?,?,?,3)",
                                   ("existing@example.test", "已有玩家", "retained-hash"))
                        db.execute("INSERT INTO rooms(id,name,host_user_id,status,version,config_version,config) VALUES(?,?,?,?,?,?,?)",
                                   ("room-old", "进行中的房间", 1, "playing", 10, 2, '{"preserved":"config"}'))
                        db.execute("INSERT INTO room_players(id,room_id,user_id,ready_config_version) VALUES(1,'room-old',1,2)")
                        db.execute("""INSERT INTO matches(id,room_id,host_user_id,status,version,frozen_players,
                            setup_request,setup_choice,state,events,catalog_snapshot,engine_version,effects_version)
                            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", ("match-old", "room-old", 1, "active", 6,
                            '[{"user_id":1,"player_id":"u-1","display_name":"已有玩家"}]',
                            '{"rng_seed":"keep-private-seed"}', None,
                            '{"game_version":5,"rng_state":{"counter":9},"zones":{"hidden":["private-card"]}}',
                            '[{"kind":"retained-event","sequence":7}]', '{"cards":{"retained":"catalogue"}}',
                            "old-engine", "old-effects"))
                        db.execute("UPDATE rooms SET active_match_id='match-old' WHERE id='room-old'")
                        db.execute("""INSERT INTO match_commands(user_id,command_id,operation,resource_id,
                            payload_hash,match_id,response_view) VALUES(1,?,?,?,?,?,?)""",
                            ("retained-command", "start", "room-old", "retained-hash", "match-old",
                             '{"id":"match-old","version":1,"status":"active"}'))
                        db.commit()
                        before = {table: db.execute(f"SELECT * FROM {table}").fetchall() for table in tables}
                        self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
                    _upgrade_database()
                    with closing(sqlite3.connect(path)) as db:
                        db.execute("PRAGMA foreign_keys=ON")
                        self.assertEqual(db.execute("SELECT version_num FROM alembic_version").fetchone()[0], "0010_match_event_batches")
                        for table in tables:
                            with self.subTest(table=table):
                                expected = [(*row, None, 0, None) for row in before[table]] if table == "matches" else [(*row, None, 0) for row in before[table]] if table == "users" else (
                                    [(*row, 1) for row in before[table]] if table == "rooms" else before[table])
                                self.assertEqual(db.execute(f"SELECT * FROM {table}").fetchall(), expected)
                        self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
                        db.execute("UPDATE matches SET status='finished' WHERE id='match-old'")
                        db.execute("UPDATE rooms SET active_match_id=NULL,status='waiting' WHERE id='room-old'")
                        db.commit()
                        with self.assertRaises(sqlite3.IntegrityError):
                            db.execute("UPDATE rooms SET active_match_id='missing-match' WHERE id='room-old'")
                        db.rollback()
                        with self.assertRaises(sqlite3.IntegrityError):
                            db.execute("UPDATE match_commands SET match_id='missing-match'")
                        db.rollback()
                        self.assertEqual(json.loads(db.execute("SELECT state FROM matches").fetchone()[0])["game_version"], 5)
                finally:
                    get_settings.cache_clear()
