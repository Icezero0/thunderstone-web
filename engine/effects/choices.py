"""Typed value and card-order choices with JSON-serializable continuations."""

from copy import deepcopy

from engine.rules.players import active_players
from engine.turn.operations import TurnError


def dungeon_zone(tx, bindings):
    selected = bindings.get("_dungeon")
    zones = [zone for zone in sorted(tx.state["zones"]) if zone.startswith("dungeon:")]
    if selected in zones:
        return selected
    if len(zones) == 1:
        return zones[0]
    raise TurnError("choose a dungeon before targeting its deck")


def value_options(tx, node, bindings):
    from engine.effects.runtime import _expr
    kind = node["kind"]
    if kind == "number":
        lower, upper = _expr(tx, node.get("min", 0), bindings), _expr(tx, node.get("max", 0), bindings)
        if not 0 <= lower <= upper <= 100 or upper - lower > 100:
            raise TurnError("invalid bounded number choice")
        return list(range(lower, upper + 1))
    if kind == "player":
        return [player for player in active_players(tx.state)
                if node.get("scope", "all") == "all" or player != tx.player_id]
    if kind == "dungeon":
        return [zone for zone in sorted(tx.state["zones"]) if zone.startswith("dungeon:")]
    return list(node["options"])


def value_bindings(bindings, node, value):
    result = {**bindings, node["bind"]: value}
    if node["kind"] == "player" and node.get("as_subject"):
        result["_subject"] = value
    if node["kind"] == "dungeon":
        result["_dungeon"] = value
    return result


def pause(tx, kind, node, bindings, stack, ability_id, source_id, **details):
    tx.state["pending_choice"] = {
        "kind": kind, "player_id": bindings.get("_subject", tx.player_id),
        "ability_id": ability_id, "source_instance_id": source_id,
        "node": node, "bindings": deepcopy(bindings), **details}
    tx.state["resolution_frames"] = [{"ability_id": ability_id,
        "source_instance_id": source_id, "stack": deepcopy(stack)}]
    tx.event("effect_choice_requested", ability_id=ability_id, choice_kind=kind,
             player_id=bindings.get("_subject", tx.player_id), **details)


def continuation(tx, choice):
    from engine.effects.runtime import EffectError
    from engine.effects.abilities import source_matches
    frames = tx.state["resolution_frames"]
    ability = tx.ruleset.by_id(choice["ability_id"])
    source = choice["source_instance_id"]
    if (len(frames) != 1 or frames[0].get("ability_id") != choice["ability_id"]
            or frames[0].get("source_instance_id") != source or ability is None
            or not source_matches(tx, source, ability.source_card_id)):
        raise EffectError("invalid choice continuation source")
    return deepcopy(frames[0]["stack"])


def resolve_value(tx, value):
    from engine.effects.runtime import EffectError, _run
    choice = tx.state["pending_choice"]
    if choice is None or choice["kind"] != "effect_value":
        raise EffectError("no value choice is pending")
    options = value_options(tx, choice["node"], choice["bindings"])
    if not any(type(value) is type(option) and value == option
               for option in options if option in choice["options"]):
        raise EffectError("chosen value is not an offered option")
    stack = continuation(tx, choice)
    body = choice["node"]["then"]
    if choice["node"]["kind"] == "player" and choice["node"].get("as_subject"):
        body = {"op": "_respond_subject", "body": body}
    stack.append({"node": body, "bindings": value_bindings(
        choice["bindings"], choice["node"], value)})
    tx.state.update(pending_choice=None, resolution_frames=[])
    tx.event("effect_value_chosen", ability_id=choice["ability_id"], player_id=choice["player_id"], value=value)
    return _run(tx, choice["ability_id"], choice["source_instance_id"], stack)


def reorder_cards(tx, node, bindings, ordered):
    from engine.effects.runtime import _location, EffectError
    if node["destination"] == "dungeon_top":
        destination = dungeon_zone(tx, bindings)
        if any(tx.state["instances"][item]["owner_player_id"] is not None for item in ordered):
            raise EffectError("owned cards cannot be reordered into a dungeon")
    else:
        player = bindings.get("_subject", tx.player_id)
        destination = f"player:{player}:draw"
        if any(tx.state["instances"][item]["owner_player_id"] != player for item in ordered):
            raise EffectError("reordered cards belong to another player")
    for item in ordered:
        tx.move(item, _location(tx, item), destination)
    pile = tx.state["zones"][destination]
    pile[:] = ordered + [item for item in pile if item not in ordered]
    tx.event("cards_reordered", player_id=bindings.get("_subject", tx.player_id),
             destination=destination, instance_ids=ordered)


def resolve_reorder(tx, ordered):
    from engine.effects.runtime import EffectError, _query, _run
    choice = tx.state["pending_choice"]
    if choice is None or choice["kind"] != "effect_reorder":
        raise EffectError("no card ordering choice is pending")
    candidates = _query(tx, choice["node"]["query"], choice["bindings"])
    if (not isinstance(ordered, list) or any(not isinstance(item, str) for item in ordered)
            or len(ordered) != len(candidates) or len(set(ordered)) != len(ordered)
            or set(ordered) != set(candidates) or set(ordered) != set(choice["candidate_instance_ids"])):
        raise EffectError("card order must contain every candidate exactly once")
    stack = continuation(tx, choice)
    reorder_cards(tx, choice["node"], choice["bindings"], ordered)
    tx.state.update(pending_choice=None, resolution_frames=[])
    return _run(tx, choice["ability_id"], choice["source_instance_id"], stack)
