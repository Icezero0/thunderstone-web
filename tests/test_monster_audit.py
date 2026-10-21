"""Audit projections explain actual runtime bindings and keep source lines intact."""

from dataclasses import asdict
import json
import unittest

from fastapi.testclient import TestClient

from backend.app.main import app
from devtools.effect_explanation import Explainer
from devtools.monster_audit import monster_audit_data
from engine.catalog.repository import load_catalog
from engine.effects.combat import is_hero, matches
from engine.effects.compiler import load_ruleset


class MonsterAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = load_catalog()
        cls.rules = load_ruleset(cls.snapshot.cards)
        cls.data = monster_audit_data()
        cls.cards = {card["card_id"]: card for card in cls.data["cards"]}
        cls.abilities = {a["ability_id"]: a for card in cls.data["cards"] for a in card["abilities"]}

    def text(self, ability_id):
        return json.dumps(self.abilities[ability_id]["steps"], ensure_ascii=False)

    def test_every_monster_and_original_effect_line_is_present(self):
        expected = {i for i, c in self.snapshot.cards.items() if c["slot_kind"] == "front" and c["subcategory"] == "怪物"}
        self.assertEqual(set(self.cards), expected)
        self.assertEqual(len(self.cards), 214)
        self.assertEqual(len(self.abilities), 345)
        for card in self.cards.values():
            with self.subTest(card=card["card_id"]):
                self.assertEqual(card["unmapped_lines"], [])
                self.assertEqual(card["effect_text"], self.snapshot.cards[card["card_id"]]["effect_text"])
                self.assertTrue(all(a["source_line"] in card["effect_text"].splitlines() for a in card["abilities"]))
                for ability in card["abilities"]:
                    self.assertIsNotNone(ability["binding"])
                    self.assertTrue(ability["steps"])
                    self.assertEqual(ability["untranslated"], [])
                    self.assertNotIn("unknown", ability["scope_ids"])
        self.assertFalse(self.cards["TS-0510"]["abilities"])

    def test_executable_definitions_are_the_actual_loaded_rules_not_the_draft_ast(self):
        for rule in (*self.rules.abilities, *self.rules.mechanics):
            if rule.source_card_id not in self.cards:
                continue
            with self.subTest(ability=rule.id):
                # JSON roundtrip accounts for tuple actions/conditions from the
                # immutable compiler dataclass, without constructing new rules.
                self.assertEqual(json.loads(json.dumps(self.abilities[rule.id]["binding"])),
                                 json.loads(json.dumps(asdict(rule))))

    def test_trophy_battle_and_target_abilities_are_distinguished(self):
        self.assertEqual(self.abilities["TS-0582-A01"]["scope_ids"], ["battle"])
        self.assertEqual(self.abilities["TS-0582-A02"]["scope_ids"], ["hand_passive"])
        self.assertIn("魔法攻击", self.text("TS-0582-A02"))
        self.assertIn("+1", self.text("TS-0582-A02"))
        self.assertEqual(self.abilities["TS-0494-A01"]["scope_ids"], ["battle"])
        self.assertEqual(self.abilities["TS-0494-A02"]["scope_ids"], ["breach"])
        self.assertEqual(self.abilities["TS-0494-A03"]["scope_ids"], ["hand_active"])
        self.assertTrue(self.abilities["TS-0582-A02"]["needs_symbol_check"])
        self.assertFalse(self.abilities["TS-0582-A01"]["needs_symbol_check"])

    def test_unprefixed_negative_hand_aura_is_not_presented_as_target_effect(self):
        ability = self.abilities["TS-0660-A01"]
        self.assertEqual(ability["scope_ids"], ["hand_passive"])
        self.assertIn("力量 -1", self.text("TS-0660-A01"))
        self.assertTrue(ability["needs_symbol_check"])

    def test_hero_queries_use_explicit_tags_for_hero_village_and_basic_cards(self):
        hero = self.snapshot.cards["TS-0302"]
        self.assertIn("英雄", hero["tags"].split("|"))
        for card_id in ("TS-0302", "TS-0001", "TS-0300"):
            with self.subTest(card=card_id):
                self.assertTrue(is_hero(self.snapshot.cards[card_id]))
                self.assertTrue(matches(self.snapshot.cards[card_id], {"tag": "英雄"}))
        self.assertFalse(matches(self.snapshot.cards["TS-0003"], {"tag": "英雄"}))
        # A category alone must not secretly inject a semantic tag into queries.
        untagged = dict(hero, tags="弓箭手")
        self.assertFalse(is_hero(untagged))
        self.assertFalse(matches(untagged, {"tag": "英雄"}))
        self.assertFalse(matches(untagged, {"tags_any": ["英雄"]}))
        self.assertTrue(matches(untagged, {"tags_none": ["英雄"]}))
        self.assertFalse(matches(hero, {"tags_none": ["英雄"]}))
        wording = Explainer(self.snapshot.cards).filters({"tag": "英雄"})
        self.assertEqual(wording, ["具有标签「英雄」"])

    def test_conditional_trophy_and_current_double_scope_economy_are_not_hidden(self):
        self.assertEqual(self.abilities["TS-0511-A01"]["scope_ids"], ["hand_passive"])
        self.assertIn("类人生物", self.text("TS-0511-A01"))
        economy = self.abilities["TS-0528-A01"]
        self.assertEqual(set(economy["scope_ids"]), {"hall", "hand_passive"})
        self.assertTrue(any("同时读取大厅和手牌" in warning for warning in economy["warnings"]))

    def test_destruction_timing_and_schedules_survive_translation(self):
        self.assertIn("立即摧毁", self.text("TS-0471-A01"))
        self.assertIn("拒绝支付", self.text("TS-0471-A01"))
        self.assertIn("本场战斗结算后再摧毁", self.text("TS-0640-A02"))
        self.assertIn("本场战斗结果确定后", self.text("TS-0509-A02"))
        self.assertIn("回合末补充手牌后", self.text("TS-0528-A02"))

    def test_unknown_nodes_remain_explicit_and_numeric_penalties_keep_their_sign(self):
        explain = Explainer(self.snapshot.cards)
        penalty = explain.node({"op": "mod_card", "target": {"var": "chosen"}, "stat": "attack", "amount": -1})
        self.assertIn("普通攻击修正 -1", penalty["text"])
        unsupported = explain.node({"op": "not_implemented"})
        self.assertIn("尚未翻译", unsupported["text"])
        self.assertIn("效果节点:not_implemented", explain.unsupported)

    def test_projection_is_repeatable_and_reviews_are_not_claimed_as_verified(self):
        self.assertEqual(self.data, monster_audit_data())
        self.assertEqual(len(self.data["effects_version"]), 64)
        for ability in self.abilities.values():
            self.assertEqual(len(ability["fingerprint"]), 64)
            self.assertNotIn("human_reviewed", ability)

    def test_read_only_page_data_images_and_existing_lab_routes(self):
        client = TestClient(app)
        page = client.get("/monster-audit")
        self.assertEqual(page.status_code, 200)
        self.assertIn("怪物能力审核", page.text)
        self.assertIn("导出审核记录", page.text)
        self.assertEqual(client.get("/monster-audit.css").status_code, 200)
        self.assertEqual(client.get("/monster-audit.js").status_code, 200)
        payload = client.get("/monster-audit/data")
        self.assertEqual(payload.status_code, 200)
        self.assertEqual(payload.json(), json.loads(json.dumps(self.data)))
        self.assertEqual(client.post("/monster-audit/data", json={}).status_code, 405)
        self.assertEqual(client.get("/cards/TS-0582.png").status_code, 200)
        self.assertEqual(client.get("/effect-lab").status_code, 200)


if __name__ == "__main__":
    unittest.main()
