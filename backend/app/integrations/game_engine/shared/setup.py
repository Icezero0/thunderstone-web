"""Server adapter metadata and domain error translation for shared setup."""
from copy import deepcopy
import hashlib
import json

from backend.app.integrations.game_engine.shared.client import client, SharedRuleError


def setup_input(request, cards, index, panel, effects_version=""):
    frozen = deepcopy(request)
    if isinstance(frozen, dict):
        seed = frozen.get("rng_seed")
        if isinstance(seed, int) and not isinstance(seed, bool):
            frozen["rng_seed"] = str(seed)
    config = request.get("config") if isinstance(request, dict) else None
    canonical = json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {"request": frozen, "cards": cards, "index": index, "panel": panel,
            "frozen_config_id": hashlib.sha256(canonical).hexdigest(), "effects_version": effects_version}


def setup_call(operation, payload):
    from backend.app.integrations.game_engine.setup.exceptions import SetupChoiceRequired, SetupError
    try:
        return client.call(operation, payload)
    except SharedRuleError as error:
        if error.name == "SetupChoiceRequired":
            raise SetupChoiceRequired(error.choice) from error
        raise SetupError(str(error), error.issues) from error
