"""Reusable classic configuration and setup request fixtures."""

def config() -> dict:
    return {
        "mode": "classic",
        "counts": {"village_groups": 8, "hero_groups": 4, "monster_groups": 3},
        "selection": {
            "village": {"fixed_randomizer_ids": []},
            "hero": {"fixed_randomizer_ids": []},
            "monster": {"fixed_randomizer_ids": []},
            "dungeon_features": {"mode": "classic_random"},
            "guardian": {"random_count": 0, "fixed_card_ids": []},
            "environment": {"random_count": 0, "fixed_card_ids": []},
            "trap": {"random_count": 0, "fixed_group_ids": []},
            "treasure": {"random_count": 0, "fixed_group_ids": []},
            "thunderstone": {"fixed_card_ids": []},
        },
        "instance_multipliers": {"village": 1, "hero": 1, "monster": 1},
    }


def request(rules: dict | None = None, seed: str = "setup-test") -> dict:
    return {"match_id": "match-1", "player_ids": ["alice", "bob"],
            "rng_seed": seed, "config": rules if rules is not None else config()}
