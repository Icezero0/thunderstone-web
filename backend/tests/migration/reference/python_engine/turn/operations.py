"""Shared deterministic state operations for one turn command."""

from __future__ import annotations

from copy import deepcopy
from typing import TYPE_CHECKING

from backend.app.integrations.game_engine.setup.random import RNG_VERSION, SetupRng

if TYPE_CHECKING:
    from backend.app.integrations.game_engine.effects.compiler import EffectsRuleset


from backend.app.integrations.game_engine.turn import TurnError


def number(card: dict[str, str], field: str, *, default: int = 0) -> int:
    raw = card[field]
    if raw == "":
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise TurnError(f"invalid numeric card field {field}: {raw}") from error


class Transition:
    def __init__(self, state: dict, cards: dict[str, dict[str, str]],
                 ruleset: EffectsRuleset | None = None, *,
                 trace_effects: bool = False, setup_index: dict | None = None):
        self.state = deepcopy(state)
        self.cards = cards
        self.ruleset = ruleset
        self.setup_index = setup_index
        self.events: list[dict] = []
        self.effect_trace: list[dict] | None = [] if trace_effects else None
        random_state = self.state["rng_state"]
        if random_state.get("algorithm") != RNG_VERSION:
            raise TurnError("unsupported random state")
        self.rng = SetupRng(random_state["seed"])
        self.rng.counter = random_state["counter"]

    @property
    def player_id(self) -> str:
        return self.state["active_player_id"]

    @property
    def player(self) -> dict:
        return self.state["players"][self.player_id]

    def zone(self, part: str, player_id: str | None = None) -> list[str]:
        return self.state["zones"][f"player:{player_id or self.player_id}:{part}"]

    def card(self, instance_id: str) -> dict[str, str]:
        copy = self.state.get("copied_heroes", {}).get(instance_id)
        if copy and copy.get("full_card"):
            return self.cards[copy["card_ids"][0]]
        return self.printed_card(instance_id)

    def printed_card(self, instance_id: str) -> dict[str, str]:
        return self.cards[self.state["instances"][instance_id]["card_id"]]

    def event(self, kind: str, **details: object) -> None:
        sequence = self.state["next_event_sequence"]
        self.state["next_event_sequence"] = sequence + 1
        self.events.append({"sequence": sequence, "kind": kind, **details})

    def trace_effect(self, ability_id: str, source_id: str, node: dict,
                     bindings: dict, **details: object) -> None:
        """Record interpreter decisions outside the authoritative game event log."""
        if self.effect_trace is not None:
            self.effect_trace.append({
                "index": len(self.effect_trace) + 1,
                "ability_id": ability_id, "source_instance_id": source_id,
                "op": node["op"], "node": deepcopy(node),
                "bindings": deepcopy(bindings), **details,
            })

    def move(self, instance_id: str, source: str, destination: str) -> None:
        pile = self.state["zones"][source]
        if instance_id not in pile:
            raise TurnError(f"{instance_id} is not in {source}")
        pile.remove(instance_id)
        self.state["zones"].setdefault(destination, []).append(instance_id)
        self.event("card_moved", instance_id=instance_id, source=source,
                   destination=destination)

    def create_owned(self, card_id: str, destination: str, origin: str, *,
                     owner_player_id: str | None = None, emit_event: bool = True) -> str:
        sequence = self.state["next_instance_sequence"]
        instance_id = f"CI-{sequence:06d}"
        if instance_id in self.state["instances"]:
            raise TurnError(f"duplicate instance ID: {instance_id}")
        self.state["next_instance_sequence"] = sequence + 1
        owner = owner_player_id or self.player_id
        self.state["instances"][instance_id] = {
            "card_id": card_id, "owner_player_id": owner,
            "origin": origin, "flags": {},
        }
        self.state["zones"][destination].append(instance_id)
        if emit_event:
            self.event("card_created", instance_id=instance_id, card_id=card_id,
                       owner_player_id=owner, destination=destination,
                       origin=origin)
        return instance_id

    def take_disease(self, *, destination: str = "discard", player_id: str | None = None) -> str:
        """Draw once from the current infinite, weighted disease supply."""
        from backend.app.integrations.game_engine.disease.service import sample_disease

        if destination not in ("hand", "discard"):
            raise TurnError("invalid disease destination")
        supply = self.state["supply_rules"]
        card_id, roll, total_weight, candidates = sample_disease(supply, self.rng)
        recipient = player_id or self.player_id
        if recipient not in self.state["players"]:
            raise TurnError("unknown disease recipient")
        if self.state["players"][recipient].get("eliminated"):
            raise TurnError("eliminated player cannot receive a disease")
        zone = f"player:{recipient}:{destination}"
        instance_id = self.create_owned(card_id, zone, "disease_supply", owner_player_id=recipient, emit_event=False)
        self.event("disease_taken_from_supply", player_id=recipient,
                   zone=zone, instance_id=instance_id, card_id=card_id,
                   disease_mode=supply["disease_mode"], roll=roll,
                   total_weight=total_weight,
                   candidates=candidates)
        from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps
        queue_steps(self, [{"op": "resolve_disease_gain", "gain": {
            "instance_id": instance_id, "player_id": recipient,
            "destination": destination, "used_sources": []}}], front=True)
        return instance_id

    def destroy_card(self, instance_id: str, *, reason: str = "effect") -> dict:
        source = next((zone for zone, pile in self.state["zones"].items()
                       if instance_id in pile), None)
        if source is None:
            raise TurnError("destroyed card has no zone")
        card = self.printed_card(instance_id)
        from backend.tests.migration.reference.python_engine.effects.status import destruction_replacement
        replacement = destruction_replacement(self, instance_id)
        flags = self.state["instances"][instance_id]["flags"]
        flags.pop("pending_after_battle_destruction", None)
        flags.pop("pending_turn_end_destruction", None)
        if replacement is not None:
            owner = self.state["instances"][instance_id]["owner_player_id"]
            destination = f"player:{owner}:discard"
            if source != destination:
                self.move(instance_id, source, destination)
            details = {"instance_id": instance_id, "card_id": card["card_id"],
                       "source": source, "destination": destination}
            self.event("card_destruction_replaced", **details, reason=reason,
                       replacement=replacement)
            return details
        from backend.tests.migration.reference.python_engine.effects.inventory import return_destroyed_to_supply
        returned = return_destroyed_to_supply(self, instance_id, source, reason=reason)
        if returned is not None:
            return returned
        from backend.tests.migration.reference.python_engine.effects.combat import is_disease
        if is_disease(card):
            self.state["zones"][source].remove(instance_id)
            del self.state["instances"][instance_id]
            destination = "disease_supply"
        else:
            self.state["instances"][instance_id]["owner_player_id"] = None
            self.move(instance_id, source, "destroyed")
            destination = "destroyed"
        details = {"instance_id": instance_id, "card_id": card["card_id"],
                   "source": source, "destination": destination}
        self.event("card_destroyed", **details, reason=reason)
        return details

    def draw(self, count: int, *, player_id: str | None = None) -> list[str]:
        from backend.tests.migration.reference.python_engine.shared.turn import draw_cards

        recipient = player_id or self.player_id
        draw = self.zone("draw", recipient)
        discard = self.zone("discard", recipient)
        hand = self.zone("hand", recipient)
        result = draw_cards(draw=draw, discard=discard, hand=hand, count=count,
                            rng={"algorithm": RNG_VERSION, "seed": self.rng.seed,
                                 "counter": self.rng.counter})
        draw[:] = result["draw"]
        discard[:] = result["discard"]
        hand[:] = result["hand"]
        self.rng.counter = int(result["counter"])
        taken = result["taken"]
        for order in result["shuffle_orders"]:
            self.event("player_deck_shuffled", player_id=recipient, order=order)
        self.event("cards_drawn", player_id=recipient,
                   instance_ids=taken, requested=count)
        context = self.state.get("battle_context")
        if recipient == self.player_id and context is not None and self.ruleset is not None:
            from backend.tests.migration.reference.python_engine.effects.combat import combat_values, hand_rules
            equipped = {weapon for _, weapon in combat_values(self, 1)["equipped_pairs"]}
            for source, _ in hand_rules(self, "draw_attack"):
                if source in equipped:
                    counts = context.setdefault("equipment_draw_counts", {})
                    counts[source] = counts.get(source, 0) + len(taken)
        return taken

    def finish_turn(self) -> None:
        current = self.player_id
        if self.player.get("eliminated"):
            # Eliminated players retain their assets for the final record, but
            # neither draw a new hand nor trigger further personal turn effects.
            for item in list(self.zone("hand")):
                self.move(item, f"player:{current}:hand", f"player:{current}:discard")
            from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps
            queue_steps(self, [{"op": "pass_turn"}, {"op": "event", "event": "TURN_START"}])
            return
        self.event("ACTION_WILL_EXIT", player_id=current,
                   action=self.state["chosen_action"])
        self.event("ACTION_EXITED", player_id=current,
                   action=self.state["chosen_action"])
        self.state["subphase"] = "ACTION_EXIT_EFFECTS"
        self.state["timing_window"] = "ACTION_EXITED"
        from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps
        queue_steps(self, [{"op": "event", "event": "ACTION_EXITED"},
                          {"op": "turn_will_end"}, {"op": "cleanup_turn"}])

    def resume_after_effects(self) -> None:
        stage = self.state.pop("effect_resume", None)
        if stage == "workflow":
            from backend.tests.migration.reference.python_engine.turn.workflow import run_steps
            run_steps(self)
        else:
            raise TurnError("no effect stage to resume")

    def _cleanup_turn(self) -> None:
        current = self.player_id
        from backend.tests.migration.reference.python_engine.effects.borrowing import return_borrowed
        for instance_id, instance in list(self.state["instances"].items()):
            if instance["flags"].get("pending_turn_end_destruction"):
                destination = self.destroy_card(instance_id, reason="zero_strength_or_deferred_turn_end")["destination"]
                self.event("zero_strength_hero_destroyed" if destination == "destroyed"
                           else "zero_strength_hero_discarded", instance_id=instance_id)
        return_borrowed(self, "turn_end")
        hand = self.zone("hand")
        discard = self.zone("discard")
        discarded = list(hand)
        discard.extend(hand)
        hand.clear()
        self.event("turn_hand_discarded", player_id=current,
                   instance_ids=discarded)
        self.draw(max(0, 6 + self.player.pop("next_hand_bonus", 0)))
        additions = f"player:{current}:refill_add"
        for instance in list(self.state["zones"].get(additions, [])):
            self.move(instance, additions, f"player:{current}:hand")
        from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps
        queue_steps(self, [{"op": "event", "event": "HAND_REFILL_COMPLETE"},
                          {"op": "pass_turn"}, {"op": "event", "event": "TURN_START"}])

    def pass_turn(self) -> None:
        from backend.tests.migration.reference.python_engine.shared.turn import advance_turn

        current = self.player_id
        from backend.tests.migration.reference.python_engine.effects.status import expire_turn_buffs
        expire_turn_buffs(self)
        from backend.tests.migration.reference.python_engine.effects.durations import expire_rules
        expire_rules(self, "owner_next_turn_end")
        self.state["registered_triggers"] = [item for item in self.state["registered_triggers"] if item["turn_number"] != self.state["turn_number"]]
        self.state.pop("effect_collections", None)
        self.state.pop("copied_heroes", None)
        self.player["temporary_gold"] = 0
        self.player["purchases_remaining"] = 1
        self.player.pop("extra_basic_purchases", None)
        self.state.get("turn_purchases", {}).pop(current, None)
        self.state["ability_uses"] = {}
        self.state["used_cards"] = []
        self.state["battle_context"] = None
        self.state["chosen_action"] = None
        self.state.pop("turn_defeated_monsters", None)
        self.player.pop("turn_gold_adjustment", None)
        self.event("TURN_ENDED", player_id=current)
        next_turn = advance_turn({
            "player_order": self.state["player_order"],
            "first_player_id": self.state["first_player_id"],
            "current_player_id": current, "players": self.state["players"],
            "turn_number": self.state["turn_number"],
            "round_number": self.state["round_number"],
        })
        if next_turn["extra_turn"]:
            self.player["extra_turns"] = next_turn["remaining_extra_turns"]
        self.state["active_player_id"] = next_turn["next_player_id"]
        self.state["turn_number"] = next_turn["turn_number"]
        self.state["round_number"] = next_turn["round_number"]
        self.state["subphase"] = "TURN_START"
        self.state["timing_window"] = "TURN_START_BEFORE"
        self.event("turn_passed", from_player_id=current,
                   to_player_id=next_turn["next_player_id"],
                   turn_number=self.state["turn_number"])

    def finish(self) -> dict:
        if self.state["phase"] == "PLAYING" and self.state["pending_choice"] is None:
            from backend.tests.migration.reference.python_engine.effects.inventory import replenish_empty_supplies
            replenish_empty_supplies(self)
        self.state["rng_state"]["counter"] = self.rng.counter
        self.state["game_version"] += 1
        result = {"state": self.state, "events": self.events}
        if self.effect_trace is not None:
            result["effect_trace"] = self.effect_trace
        return result
