"""Small private match snapshot for viewer projection tests."""

from datetime import datetime, timezone
from types import SimpleNamespace


def sample_match():
    definitions = {f"TS-{n:04d}": {
        "card_id": f"TS-{n:04d}", "name": f"Card {n}", "effect_text": "攻击 +1。",
        "tags": "英雄|战士", "wiki_英雄等级": str(n), "review_note": "internal-note",
    } for n in range(1, 13)}
    places = {
        "player:alice:hand": [("alice-hand", 1)],
        "player:alice:draw": [("secret-alice-draw", 2)],
        "player:alice:discard": [("alice-discard", 3)],
        "player:bob:hand": [("secret-bob-hand", 4)],
        "player:bob:draw": [("secret-bob-draw", 5)],
        "player:bob:discard": [("secret-bob-discard", 6)],
        "player:bob:control": [("public-control", 7)],
        "dungeon:main": [("secret-dungeon", 8)],
        "hall:main": [("hall-monster", 9)],
        "hall:main:rank0": [("hall-guardian", 10)],
        "hero_supply:TS-0001": [("supply-a", 11), ("supply-b", 12), ("supply-c", 12)],
    }
    state = {
        "zones": {z: [i for i, _ in cards] for z, cards in places.items()},
        "instances": {i: {"card_id": f"TS-{n:04d}", "flags": {"private": "secret-flag"}}
                      for cards in places.values() for i, n in cards},
        "players": {"alice": {"xp": 3}, "bob": {"xp": 2}},
        "turn_number": 1, "round_number": 1, "active_player_id": "alice", "first_player_id": "alice",
        "phase": "PLAYING", "subphase": "TURN_START", "rng_state": {"seed": "secret-seed"},
        "resolution_frames": [{"value": "secret-continuation"}],
    }
    return SimpleNamespace(
        id="match-1", room_id="room-1", status="active", version=1, host_user_id=1,
        created_at=datetime(2026, 10, 24, tzinfo=timezone.utc),
        frozen_players=[{"user_id": 1, "player_id": "alice", "display_name": "Alice"},
                        {"user_id": 2, "player_id": "bob", "display_name": "Bob"}],
        setup_request={"rng_seed": "secret-seed"}, setup_choice=None, state=state,
        events=[{"kind": "shuffle", "order": "secret-deck-order"}],
        catalog_snapshot={"cards": definitions, "setup_index": {}},
    )

