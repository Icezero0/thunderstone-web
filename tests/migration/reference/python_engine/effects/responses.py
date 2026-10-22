"""Per-recipient response windows preserve the interrupted compiled stack."""

from copy import deepcopy

from tests.migration.reference.python_engine.effects.combat import is_hero
from tests.migration.reference.python_engine.rules.players import active_players
from tests.migration.reference.python_engine.turn.operations import TurnError


def has_global_work(node):
    if isinstance(node, list):
        return any(has_global_work(item) for item in node)
    return isinstance(node, dict) and (node.get("op") in (
        "for_players", "reveal_cycle", "clear_collection", "collect") or node.get("zone") == "collection"
        or any(has_global_work(value) for value in node.values() if isinstance(value, (list, dict))))


def effect_recipients(tx, body):
    if has_global_work(body):
        return active_players(tx.state)
    return [tx.player_id]


def sources(tx, plan, recipient):
    from tests.migration.reference.python_engine.effects.abilities import source_matches
    options = []
    for rule in tx.ruleset.mechanics:
        if rule.op != "response":
            continue
        action = rule.params["action"]
        if plan["mode"] == "destroy":
            valid = action == "prevent_destroy" and recipient == tx.player_id
        elif plan["trap"]:
            valid = action == "ignore_trap" or action == "redirect_trap" and recipient == tx.player_id
        elif plan["battle"]:
            valid = action == "ignore_battle" and recipient == tx.player_id
        else:
            valid = action == "redirect_opponent" and recipient != tx.player_id and plan["opponent_effect"]
        if not valid:
            continue
        zone = "control" if action == "ignore_battle" else "hand"
        for source in tx.zone(zone, recipient):
            if (not source_matches(tx, source, rule.source_card_id) or source in plan["used_sources"]
                    or rule.params.get("once_per_turn") and tx.state.get("ability_uses", {}).get(f"{source}:{rule.id}") == tx.state["turn_number"]):
                continue
            if action == "redirect_trap" and len(active_players(tx.state)) < 2:
                continue
            options.append({"source_instance_id": source, "ability_id": rule.id, "action": action})
    return options


def pause(tx, plan, stage, options):
    tx.state["pending_choice"] = {"kind": "effect_response", "player_id": plan["recipient"],
        "ability_id": plan.get("ability_id"), "stage": stage, "options": deepcopy(options)}
    tx.state["resolution_frames"] = [{"kind": "response", "plan": deepcopy(plan)}]
    tx.event("response_requested", player_id=plan["recipient"], stage=stage, options=options,
             ability_id=plan.get("ability_id"), response_mode=plan["mode"])


def offer_effect(tx, body, bindings, stack, ability_id, source_id, *, subject_window=False):
    ability = tx.ruleset.by_id(ability_id)
    trap = ability.event == "TRAP_REVEALED"
    battle = ability.source_zone == "battle_target" and ability.event == "BATTLE_BEFORE_OUTCOME"
    owner = tx.state["instances"][source_id]["owner_player_id"] if source_id in tx.state["instances"] else None
    # Immunity/redirect is to this physical trap, including its other printed
    # lines. A once-per-turn source must not protect just the first line.
    saved = tx.state.get("trap_responses", {}).get(source_id, {}) if trap else {}
    plan = {"mode": "effect", "trap": trap, "battle": battle,
        "opponent_effect": owner == tx.player_id and ability.source_zone in ("active_hand", "active_control"),
        "queue": ([bindings.get("_subject", tx.player_id)] if subject_window else effect_recipients(tx, body) if trap or battle else []),
        "visited": [], "used_sources": list(saved.get("used_sources", [])),
        "immune": list(saved.get("immune", [])), "redirects": dict(saved.get("redirects", {})),
        "body": body, "bindings": bindings, "stack": deepcopy(stack), "ability_id": ability_id, "source_id": source_id}
    return advance(tx, plan)


def offer_destroy(tx, item, reason, *, stack=None, bindings=None, ability_id=None, source_id=None):
    from tests.migration.reference.python_engine.effects.status import destruction_replacement
    if (item not in tx.state["instances"] or not is_hero(tx.card(item))
            or tx.state["instances"][item]["owner_player_id"] != tx.player_id
            or tx.state["subphase"] not in ("BATTLE_EFFECTS", "BATTLE_AFTER_EFFECTS")
            or destruction_replacement(tx, item) is not None):
        return False
    plan = {"mode": "destroy", "trap": False, "battle": True, "opponent_effect": False,
        "queue": [tx.player_id], "visited": [], "used_sources": [], "immune": [], "redirects": {},
        "item": item, "reason": reason, "prevented": False, "stack": deepcopy(stack), "bindings": bindings,
        "ability_id": ability_id, "source_id": source_id}
    if not sources(tx, plan, tx.player_id):
        return False
    advance(tx, plan)
    return True


def complete(tx, plan):
    from tests.migration.reference.python_engine.effects.runtime import _run
    if plan["mode"] == "effect":
        if plan["trap"]:
            tx.state.setdefault("trap_responses", {})[plan["source_id"]] = {
                key: deepcopy(plan[key]) for key in ("used_sources", "immune", "redirects")}
        bindings = {**plan["bindings"], "_responses": {"immune": plan["immune"], "redirects": plan["redirects"]}}
        subject = bindings.get("_subject", tx.player_id)
        bindings["_subject"] = plan["redirects"].get(subject, subject)
        stack = deepcopy(plan["stack"])
        stack.append({"node": plan["body"], "bindings": bindings})
        return _run(tx, plan["ability_id"], plan["source_id"], stack)
    item = plan["item"]
    if plan["prevented"]:
        flags = tx.state["instances"][item]["flags"]
        flags.pop("pending_after_battle_destruction", None)
        flags.pop("pending_turn_end_destruction", None)
        tx.event("hero_destruction_prevented", instance_id=item)
    else:
        result = tx.destroy_card(item, reason=plan["reason"])
        if plan["stack"] is not None:
            tx.event("effect_card_removed", ability_id=plan["ability_id"], op="destroy", **result)
    if plan["stack"] is not None:
        return _run(tx, plan["ability_id"], plan["source_id"], plan["stack"])
    return True


def advance(tx, plan):
    while plan["queue"]:
        recipient = plan["queue"].pop(0)
        if recipient in plan["visited"]:
            continue
        plan["recipient"] = recipient
        plan["visited"].append(recipient)
        if recipient in plan["immune"] or recipient in plan["redirects"]:
            continue
        options = sources(tx, plan, recipient)
        if options:
            pause(tx, plan, "source", options)
            return False
    return complete(tx, plan)


def resolve_response(tx, *, source_instance_id=None, recipient_id=None):
    choice = tx.state["pending_choice"]
    if choice is None or choice["kind"] != "effect_response":
        raise TurnError("no response is pending")
    frames = tx.state["resolution_frames"]
    if len(frames) != 1 or frames[0].get("kind") != "response":
        raise TurnError("invalid response continuation")
    plan = deepcopy(frames[0]["plan"])
    if plan.get("recipient") != choice["player_id"] or plan.get("ability_id") != choice.get("ability_id"):
        raise TurnError("invalid response continuation recipient")
    if plan.get("ability_id") is not None:
        from tests.migration.reference.python_engine.effects.abilities import source_matches
        ability = tx.ruleset.by_id(plan["ability_id"])
        if ability is None or not source_matches(tx, plan.get("source_id"), ability.source_card_id):
            raise TurnError("invalid response continuation source")
    if choice["stage"] == "recipient":
        if source_instance_id is not None or recipient_id not in choice["options"] or recipient_id not in active_players(tx.state):
            raise TurnError("invalid redirected recipient")
        plan["redirects"][plan["recipient"]] = recipient_id
        plan["queue"].append(recipient_id)
    elif source_instance_id is not None:
        option = next((item for item in sources(tx, plan, plan["recipient"]) if item["source_instance_id"] == source_instance_id), None)
        if option is None or recipient_id is not None:
            raise TurnError("response source is no longer available")
        plan["used_sources"].append(source_instance_id)
        tx.state.setdefault("ability_uses", {})[f"{source_instance_id}:{option['ability_id']}"] = tx.state["turn_number"]
        action = option["action"]
        tx.event("response_used", player_id=plan["recipient"], **option)
        if action in ("ignore_trap", "redirect_opponent", "redirect_trap"):
            tx.event("cards_shown", player_id=plan["recipient"], instance_ids=[source_instance_id], ability_id=option["ability_id"])
        if action in ("ignore_battle", "prevent_destroy"):
            tx.destroy_card(source_instance_id, reason=option["ability_id"])
        if action.startswith("ignore_"):
            plan["immune"].append(plan["recipient"])
        elif action == "redirect_opponent":
            plan["redirects"][plan["recipient"]] = tx.player_id
        elif action == "prevent_destroy":
            plan["prevented"] = True
        else:
            targets = [player for player in active_players(tx.state) if player != plan["recipient"]]
            tx.state.update(pending_choice=None, resolution_frames=[])
            pause(tx, plan, "recipient", targets)
            return False
    elif recipient_id is not None:
        raise TurnError("choose a source before redirecting")
    tx.state.update(pending_choice=None, resolution_frames=[])
    tx.event("response_resolved", player_id=choice["player_id"], declined=source_instance_id is None and choice["stage"] == "source")
    return advance(tx, plan)
