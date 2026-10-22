"""Cross-runtime regression, private-state projection and worker lifecycle."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.integrations.game_engine.catalog.repository import load_catalog
from backend.tests.migration.reference.python_engine.effects.combat import combat_values, monster_health, equipment_capacity
from backend.app.integrations.game_engine.effects.compiler import load_ruleset
from backend.tests.migration.reference.python_engine.effects.economy import printed_gold, purchase_price
from backend.app.integrations.game_engine.scoring import score_game
from backend.app.integrations.game_engine.shared.client import EngineClient, SharedEngineUnavailable, SharedRuleError
from backend.tests.migration.reference.python_engine.shared.projection import calculation_input, preview_context
from backend.tests.migration.reference.python_engine.turn.operations import Transition
from backend.tests.migration.reference import combat as reference, economy as old_economy, scoring as old_scoring


class SharedEngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.cards = cls.snapshot.cards
        cls.rules = load_ruleset(cls.cards)

    def fixture(self, hand=None, target="TS-0510", environment=None):
        hand = hand or ["TS-0304", "TS-0002", "TS-0272", "TS-0003", "TS-0714"]
        instances = {f"h{i}": {"card_id": card_id, "owner_player_id": "alice"} for i, card_id in enumerate(hand)}
        instances["monster"] = {"card_id": target, "owner_player_id": None}
        state = {"active_player_id": "alice", "player_order": ["alice", "bob"],
                 "players": {"alice": {"xp": 7}, "bob": {"xp": 0}},
                 "active_settings": [environment] if environment else [],
                 "zones": {"player:alice:hand": [f"h{i}" for i in range(len(hand))],
                           "hall:main": ["monster"]}, "instances": instances,
                 "battle_context": {"equipped_weapon_by_hero": {}},
                 "rng_state": {"algorithm": "sha256-counter-v1", "seed": "parity", "counter": 0},
                 "subphase": "DUNGEON_PREPARE", "pending_choice": None,
                 "game_version": 42, "catalog_version": self.snapshot.setup_index["cards_csv_sha256"],
                 "effects_version": self.rules.version}
        return Transition(state, self.cards, self.rules)

    def compare(self, tx, target_id=None):
        # Compare the original rule vocabulary only. The six user-corrected
        # target auras are verified against explicit business expectations in
        # test_monster_review, rather than the old mistaken implementation.
        tx.ruleset = replace(tx.ruleset, mechanics=tuple(m for m in tx.ruleset.mechanics if m.op != 'battle_aura'))
        before = deepcopy(tx.state)
        target = tx.card(target_id) if target_id else None
        for rank in (0, 1, 2, 3):
            self.assertEqual(combat_values(tx, rank, target), reference.combat_values(tx, rank, target))
            if target is not None:
                self.assertEqual(monster_health(tx, target, rank=rank, target_id=target_id),
                                 reference.monster_health(tx, target, rank=rank, target_id=target_id))
        self.assertEqual(tx.state, before)
        for instance_id in tx.zone("hand"):
            if "英雄" in tx.card(instance_id)["tags"].split("|"):
                self.assertEqual(equipment_capacity(tx, instance_id), reference.equipment_capacity(tx, instance_id))

    def test_every_playable_card_and_every_monster_match_python_reference(self):
        for card_id, card in self.cards.items():
            if card["slot_kind"] != "front":
                continue
            with self.subTest(card=card_id):
                if card["subcategory"] in ("怪物", "守护者"):
                    tx = self.fixture(target=card_id)
                    self.compare(tx, "monster")
                else:
                    tx = self.fixture(hand=["TS-0304", "TS-0002", "TS-0272", card_id])
                    if "英雄" in tx.card("h0")["tags"]:
                        tx.state["battle_context"]["equipped_weapon_by_hero"] = {"h0": "h1"}
                    self.compare(tx)
                self.assertEqual(printed_gold(tx, card), old_economy.printed_gold(tx, card))
                self.assertEqual(purchase_price(tx, card), old_economy.purchase_price(tx, card))

    def test_environments_copies_auras_modifiers_and_disease_assignment(self):
        for environment in (None, "TS-0193", "TS-0194", "TS-0199"):
            tx = self.fixture(environment=environment)
            tx.state["battle_context"].update(
                equipped_weapon_by_hero={"h0": "h1"}, modifiers={"attack": -3, "magic_attack": 1, "light": -2},
                card_modifiers={"h0": {"strength": -2, "attack": 1}},
                disease_penalty_assignments={"h4": "magic_attack"},
                convert_equipped_magic=True)
            self.compare(tx, "monster")
        tx = self.fixture(hand=["TS-0001", "TS-0002", "TS-0272"])
        tx.state["copied_heroes"] = {"h0": {"card_ids": ["TS-0304"], "full_card": False, "preserve_attack": False}}
        self.compare(tx, "monster")
        tx.state["copied_heroes"]["h0"]["full_card"] = True
        self.compare(tx, "monster")

    def test_scoring_matches_python_except_dual_identity_heart(self):
        tx = self.fixture()
        tx.state["instances"] = {card_id: {"card_id": card_id, "owner_player_id": "alice" if i % 2 else "bob"}
                                  for i, (card_id, card) in enumerate(self.cards.items())
                                  if card["slot_kind"] == "front" and card_id != "TS-0683"}
        # The frozen category-based scorer excludes the Heart from thunderstones.
        # Its intentional new dual-tag behavior has a dedicated business test.
        self.assertEqual(score_game(tx.state, self.cards, self.rules), old_scoring.score_game(tx.state, self.cards, self.rules))
        tx.state["players"]["bob"]["eliminated"] = True
        self.assertEqual(score_game(tx.state, self.cards, self.rules), old_scoring.score_game(tx.state, self.cards, self.rules))

    def test_preview_projection_has_no_hidden_zones_random_stream_or_effect_frames(self):
        tx = self.fixture()
        tx.state["instances"]["SECRET-CARD"] = {"card_id": "TS-0303", "owner_player_id": "bob"}
        tx.state["zones"]["player:bob:hand"] = ["SECRET-CARD"]
        tx.state["zones"]["player:alice:draw"] = ["SECRET-CARD"]
        tx.state["resolution_frames"] = [{"private": "SECRET-FRAME"}]
        tx.state["battle_context"]["private_extension"] = "SECRET-EXTENSION"
        before = deepcopy(tx.state)
        payload = preview_context(tx)
        encoded = json.dumps(payload)
        for secret in ("SECRET-CARD", "SECRET-FRAME", "SECRET-EXTENSION", "rng_state", "seed", "resolution_frames"):
            self.assertNotIn(secret, encoded)
        payload["state"]["zones"]["player:alice:hand"].clear()
        self.assertEqual(tx.state, before)
        tx.state["pending_choice"] = {"kind": "effect_select"}
        with self.assertRaisesRegex(ValueError, "uninterrupted"):
            preview_context(tx)

    def test_worker_reuses_process_handles_parallel_calls_and_restarts_after_exit(self):
        tx = self.fixture()
        input_data = calculation_input(tx)
        worker = EngineClient()
        try:
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda rank: worker.call("combat_values", {"input": input_data, "rank": rank}), range(4)))
            for rank, result in enumerate(results):
                self.assertEqual(result, reference.combat_values(tx, rank))
            old_pid = worker._process.pid
            worker.call("combat_values", {"input": input_data, "rank": 1})
            self.assertEqual(worker._process.pid, old_pid)
            worker._process.kill()
            worker._process.wait()
            worker.call("combat_values", {"input": input_data, "rank": 1})
            self.assertNotEqual(worker._process.pid, old_pid)
            with self.assertRaisesRegex(SharedRuleError, "visible dungeon hall"):
                worker.call("preview_battle", {"context": preview_context(tx), "target_id": "h0"})
            worker.call("combat_values", {"input": input_data, "rank": 1})
        finally:
            worker.close()
        self.assertIsNone(worker._process)

    def test_missing_build_is_explicit_and_browser_bundle_is_served(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = EngineClient(Path(temp))
            with self.assertRaisesRegex(SharedEngineUnavailable, "npm ci"):
                worker.call("combat_values", {})
        response = TestClient(app).get("/engine/engine.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("previewBattle", response.text)
        self.assertIn("javascript", response.headers["content-type"])

    def test_worker_timeout_and_protocol_errors_close_the_process(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "engine/dist").mkdir(parents=True)
            (root / "engine/dist/index.js").write_text("", encoding="utf-8")
            path = root / "backend/engine-worker/worker.mjs"
            path.parent.mkdir(parents=True)
            for script in ("setInterval(() => {}, 1000);", "process.stdout.write('null\\n');"):
                with self.subTest(script=script):
                    path.write_text(script, encoding="utf-8")
                    worker = EngineClient(root, timeout=0.1)
                    try:
                        with self.assertRaises(SharedEngineUnavailable):
                            worker.call("runtime_info", {})
                        self.assertIsNone(worker._process)
                    finally:
                        worker.close()
