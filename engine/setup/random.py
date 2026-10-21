"""Portable deterministic random stream shared by game transitions."""

import hashlib

from engine.setup.exceptions import SetupError

RNG_VERSION = "sha256-counter-v1"


class SetupRng:
    """Counter-based random stream; state needs only seed and counter."""

    def __init__(self, seed: str | int):
        if isinstance(seed, bool) or not isinstance(seed, (str, int)) or str(seed) == "":
            raise SetupError("rng_seed must be a nonempty string or integer")
        self.seed = str(seed)
        self._key = hashlib.sha256(self.seed.encode("utf-8")).digest()
        self.counter = 0

    def randbelow(self, size: int) -> int:
        if size < 1:
            raise SetupError("random candidate pool is empty")
        limit = (1 << 256) - ((1 << 256) % size)
        while True:
            value = int.from_bytes(hashlib.sha256(
                self._key + self.counter.to_bytes(16, "big")).digest(), "big")
            self.counter += 1
            if value < limit:
                return value % size

    def shuffle(self, values: list[str]) -> None:
        for index in range(len(values) - 1, 0, -1):
            other = self.randbelow(index + 1)
            values[index], values[other] = values[other], values[index]
