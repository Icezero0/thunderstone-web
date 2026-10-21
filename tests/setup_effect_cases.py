"""Behavior contracts for setup-only card lines and initial Treefolk ranks."""

from copy import deepcopy

from engine.catalog.service import build_panel_catalog
from engine.setup import SetupChoiceRequired, SetupRng, start_game
from engine.setup.builder import _Builder
from tests.test_setup_engine import config, request


def builder(snapshot):
    return _Builder(request(config(), seed="setup-effect-contract"), snapshot.cards,
                    snapshot.setup_index, build_panel_catalog(snapshot.cards, snapshot.setup_index))


def verify_setup_effect(test, snapshot, kind):
    if kind == "two_dungeon_setup":
        settings = config()
        selection = settings["selection"]
        selection["dungeon_features"]["mode"] = "manual"
        selection["environment"]["fixed_card_ids"] = ["TS-0198"]
        selection["guardian"]["fixed_card_ids"] = ["TS-0673"]
        panel = build_panel_catalog(snapshot.cards, snapshot.setup_index)
        selection["trap"]["fixed_group_ids"] = [panel["dungeon_groups"]["trap"][0]["id"]]
        selection["treasure"]["fixed_group_ids"] = [panel["dungeon_groups"]["treasure"][0]["id"]]
        frozen = request(settings, seed="two-dungeon-card-contract")
        with test.assertRaises(SetupChoiceRequired) as error:
            start_game(frozen, snapshot=snapshot)
        choice = error.exception.choice
        test.assertEqual(len(choice["group_ids"]), 4)
        test.assertEqual(len(choice["feature_ids"]), 3)
        frozen["scenario_choices"] = {"two_dungeons": {
            "group_a_ids": choice["group_ids"][:2], "group_a_feature_ids": choice["feature_ids"]}}
        state = start_game(frozen, snapshot=snapshot)["state"]
        test.assertEqual(len(state["selected_thunderstones"]), 2)
        for suffix in ("a", "b"):
            test.assertGreaterEqual(len(state["zones"][f"hall:{suffix}"]), 3)
            bottom = state["zones"][f"dungeon:{suffix}"][-6:]
            test.assertEqual(sum(state["instances"][item]["card_id"] in state["selected_thunderstones"] for item in bottom), 1)
        for suffix, expected in (("a", True), ("b", False)):
            card_ids = [state["instances"][item]["card_id"] for zone, pile in state["zones"].items()
                        if zone in (f"dungeon:{suffix}", f"hall:{suffix}") for item in pile]
            test.assertEqual("TS-0673" in card_ids, expected)
            test.assertEqual(any(snapshot.cards[card]["subcategory"] in ("陷阱", "宝藏") for card in card_ids), expected)
        return
    if kind == "stormhold_setup":
        def setup(environment):
            settings = config()
            settings["selection"]["dungeon_features"]["mode"] = "manual"
            settings["selection"]["environment"]["fixed_card_ids"] = [environment] if environment else []
            return start_game(request(settings, seed="stormhold-contract"), snapshot=snapshot)["state"]
        before, after = setup(None), setup("TS-0197")
        test.assertEqual(before["selected_groups"], after["selected_groups"])
        for zone, pile in before["zones"].items():
            if zone.startswith(("village_supply:", "hero_supply:")):
                test.assertEqual(len(after["zones"][zone]), len(pile) - (2 if zone.startswith("village_supply:") else 0))
        return
    b = builder(snapshot)
    concrete = [feature for feature in b.feature_by_id.values() if feature["kind"] in ("trap_group", "treasure_group")]
    if kind == "setup_feature_entry":
        entry = b.index["dungeon_feature_entry"]["randomizer_id"]
        monsters = [card for card in b.index["randomizer_pools"]["monster_or_feature"] if card != entry][:3]
        b.index = deepcopy(b.index)
        b.index["randomizer_pools"]["monster_or_feature"] = monsters + [entry]
        b.cards = deepcopy(b.cards)
        b.cards[entry]["initial_copy_count"] = "1"
        b.feature_by_id = {concrete[0]["feature_id"]: concrete[0]}
        seed = next(str(number) for number in range(100) if SetupRng(str(number)).randbelow(4) == 3)
        b.rng = SetupRng(seed)
        b.choose_monsters()
        test.assertCountEqual(b.selected["monster"], monsters)
        test.assertEqual(sum(event["kind"] == "feature" for event in b.events), 1)
        test.assertEqual(sum(event["kind"] == "random_pick" and event["purpose"] == "monster_or_feature" for event in b.events), 4)
    elif kind == "setup_draw_features":
        b.pending_feature_draws = 0
        b.choose_feature("TS-0201")
        test.assertEqual(b.pending_feature_draws, 2)
        b.feature_pool = [item["feature_id"] for item in concrete[:2]]
        b.draw_features(b.pending_feature_draws)
        test.assertEqual(sum(len(b.features[key]) for key in ("trap", "treasure")), 2)
    elif kind == "setup_guardian":
        b.choose_feature("TS-0202")
        test.assertEqual(len(b.features["guardian"]), 1)
        test.assertIn(b.features["guardian"][0], b.index["other_pools"]["guardian"])
    elif kind == "setup_environment":
        b.pending_feature_draws = 0
        b.choose_feature("TS-0205")
        selected = list(b.features["environment"])
        test.assertEqual(len(selected), 1)
        b.choose_feature("TS-0205")
        test.assertEqual(b.features["environment"], selected)
        test.assertEqual(b.pending_feature_draws, 1)
        b.feature_pool = [concrete[0]["feature_id"]]
        b.draw_features(b.pending_feature_draws)
        test.assertEqual(len(b.features["environment"]), 1)
        test.assertEqual(sum(len(b.features[key]) for key in ("trap", "treasure")), 1)
    else:
        test.fail(f"unknown setup effect contract {kind}")


def verify_initial_treefolk(test, snapshot, card_id):
    for copies in (1, 2):
        with test.subTest(initial_treefolk=copies):
            b = builder(snapshot)
            for _ in range(copies):
                b.create(card_id, "dungeon:main", origin="setup_contract", count=1)
            b.create("TS-0476", "dungeon:main", origin="setup_contract", count=6)
            b.fill_hall("dungeon:main")
            test.assertEqual(len(b.zones["hall:main"]), 3 + copies)
            test.assertEqual(sum(b.instances[item]["card_id"] == card_id for item in b.zones["hall:main"]), copies)
