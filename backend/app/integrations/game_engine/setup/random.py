"""Python compatibility facade for the shared TypeScript random stream."""
from backend.app.integrations.game_engine.setup.exceptions import SetupError
from backend.app.integrations.game_engine.shared.setup import setup_call

RNG_VERSION = "sha256-counter-v1"


def _wire(value):
    return value if -(2 ** 53 - 1) <= value <= 2 ** 53 - 1 else str(value)


class SetupRng:
    def __init__(self, seed: str | int):
        if isinstance(seed, bool) or not isinstance(seed, (str, int)) or str(seed) == "":
            raise SetupError("rng_seed must be a nonempty string or integer")
        self.seed = str(seed)
        self.counter = 0

    def randbelow(self, size: int) -> int:
        result = setup_call("random_below", {"seed": self.seed, "counter": _wire(self.counter), "size": _wire(size)})
        self.counter = int(result["counter"])
        return int(result["value"])

    def shuffle(self, values: list[str]) -> None:
        result = setup_call("random_shuffle", {"seed": self.seed, "counter": _wire(self.counter), "values": values})
        self.counter = int(result["counter"])
        values[:] = result["values"]
