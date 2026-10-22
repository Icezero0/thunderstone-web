"""Python transaction adapters preserve exact RNG and event contracts."""

from copy import deepcopy
import unittest

from backend.app.integrations.game_engine.disease.service import sample_disease
from backend.app.integrations.game_engine.setup.random import RNG_VERSION, SetupRng
from tests.migration.reference.python_engine.turn.operations import Transition


class SharedTurnAtomTests(unittest.TestCase):
    def test_draw_after_large_rng_counter_preserves_zones_and_events(self):
        counter = (1 << 53) + 7
        state = {"active_player_id": "alice", "rng_state": {
            "algorithm": RNG_VERSION, "seed": "turn-shared", "counter": counter},
            "zones": {"player:alice:draw": ["a"],
                      "player:alice:discard": ["b", "c", "d"],
                      "player:alice:hand": ["old"]},
            "next_event_sequence": 4, "battle_context": None}
        before = deepcopy(state)
        tx = Transition(state, {})
        taken = tx.draw(3)
        self.assertEqual(state, before)
        self.assertEqual(taken[0], "a")
        self.assertEqual(set(taken + tx.zone("draw")), {"a", "b", "c", "d"})
        self.assertEqual(tx.zone("hand"), ["old", *taken])
        self.assertEqual(tx.zone("discard"), [])
        self.assertEqual(tx.rng.counter, counter + 2)
        self.assertEqual([event["kind"] for event in tx.events],
                         ["player_deck_shuffled", "cards_drawn"])
        self.assertEqual([event["sequence"] for event in tx.events], [4, 5])
        self.assertEqual(tx.events[0]["order"], taken[1:] + tx.zone("draw"))

    def test_disease_sample_after_large_rng_counter_keeps_weights(self):
        counter = (1 << 53) + 19
        rng = SetupRng("disease-shared")
        rng.counter = counter
        supply = {"disease_infinite": True, "disease_card_ids": ["d2", "d1"],
                  "disease_weights": {"d2": 2, "d1": 1}}
        before = deepcopy(supply)
        card_id, roll, total, candidates = sample_disease(supply, rng)
        self.assertEqual(supply, before)
        self.assertEqual((total, candidates), (3, [
            {"card_id": "d1", "weight": 1}, {"card_id": "d2", "weight": 2}]))
        self.assertEqual(card_id, "d1" if roll == 0 else "d2")
        self.assertEqual(rng.counter, counter + 1)


if __name__ == "__main__":
    unittest.main()
