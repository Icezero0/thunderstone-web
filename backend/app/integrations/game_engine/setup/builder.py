"""Stateless compatibility facade for focused setup transactions.

The setup service submits one complete request. This facade preserves narrow
builder operations for existing card contracts without keeping Python algorithms.
"""
from copy import deepcopy
from backend.app.integrations.game_engine.setup.random import SetupRng, _wire
from backend.app.integrations.game_engine.shared.setup import setup_input, setup_call


class _Builder:
    def __init__(self, request: dict, cards: dict, index: dict, panel: dict):
        self.request, self.cards, self.index, self.panel = request, cards, index, panel
        self.config = deepcopy(request["config"])
        self.rng = SetupRng(request["rng_seed"])
        self.zones, self.instances, self.events = {}, {}, []
        self.selected = {kind: [] for kind in ("monster", "hero", "village")}
        self.features = {kind: [] for kind in ("guardian", "environment", "trap", "treasure")}
        self.group_by_id = {group["randomizer_id"]: group for group in index["groups"]}
        self.feature_by_id = {item["feature_id"]: item for item in index["dungeon_features"]}
        self.next_instance, self.pending_feature_draws, self.feature_pool = 1, 0, []

    def _step(self, operation, *args, **options):
        fields = ("config", "zones", "instances", "events", "selected", "features", "group_by_id",
                  "feature_by_id", "next_instance", "pending_feature_draws", "feature_pool")
        draft = {key: getattr(self, key) for key in fields}
        draft["rng_state"] = {"algorithm": "sha256-counter-v1", "seed": self.rng.seed, "counter": _wire(self.rng.counter)}
        result = setup_call("setup_step", {"input": setup_input(self.request, self.cards, self.index, self.panel),
            "draft": draft, "operation": operation, "args": args, "options": options})
        for key in fields:
            setattr(self, key, result["draft"][key])
        self.rng.counter = int(result["draft"]["rng_state"]["counter"])
        return result["result"]

    def choose_monsters(self):
        self._step("choose_monsters")

    def choose_feature(self, feature_id):
        self._step("choose_feature", feature_id)

    def draw_features(self, count=1):
        self._step("draw_features", count)

    def create(self, card_id, zone, *, owner=None, origin, count=None):
        options = {"origin": origin, "owner": owner}
        if count is not None:
            options["count"] = count
        self._step("create", card_id, zone, **options)

    def fill_hall(self, deck_zone):
        self._step("fill_hall", deck_zone)

    def build(self):
        return self._step("build")
