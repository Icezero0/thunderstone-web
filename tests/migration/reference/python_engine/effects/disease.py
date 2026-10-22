"""Apply shared TypeScript disease-gain plans to the Python transaction."""

from copy import deepcopy

from tests.migration.reference.python_engine.shared.turn import turn_atom


def _plan_input(tx, mode, *, gain=None, source_instance_id=None, recipient_id=None):
    hands = {player: list(tx.zone("hand", player)) for player in tx.state["player_order"]}
    copies = tx.state.get("copied_heroes", {})
    source_card_ids = {item: list(dict.fromkeys([
        tx.card(item)["card_id"], *copies.get(item, {}).get("card_ids", [])]))
        for hand in hands.values() for item in hand}
    rules = [{"id": rule.id, "source_card_id": rule.source_card_id,
              "action": rule.params["action"]}
             for rule in tx.ruleset.mechanics if rule.op == "replace_disease"] if tx.ruleset else []
    frames = tx.state.get("resolution_frames", [])
    frame_gain = frames[0].get("gain") if frames and isinstance(frames[0], dict) else None
    current_gain = frame_gain if mode == "resolve" else gain
    return {"mode": mode, "gain": gain, "pending_choice": tx.state.get("pending_choice"),
        "resolution_frames": frames, "instance_exists": isinstance(current_gain, dict)
            and current_gain.get("instance_id") in tx.state["instances"],
        "instance_count": len(tx.state["instances"]),
        "player_order": tx.state["player_order"], "players": tx.state["players"],
        "hands": hands, "source_card_ids": source_card_ids, "rules": rules,
        "source_instance_id": source_instance_id, "recipient_id": recipient_id}


def location(tx, instance):
    return next(zone for zone, pile in tx.state["zones"].items() if instance in pile)


def pause_gain(tx, gain, stage, options):
    instance = gain["instance_id"]
    current = location(tx, instance)
    if current.startswith("player:"):
        tx.state["instances"][instance]["owner_player_id"] = None
        tx.move(instance, current, "pending:disease")
    tx.state["pending_choice"] = {"kind": "disease_replacement", "player_id": gain["player_id"],
        "ability_id": gain.get("ability_id"), "stage": stage, "options": options}
    tx.state["resolution_frames"] = [{"kind": "disease_gain", "gain": deepcopy(gain)}]
    tx.state["effect_resume"] = "workflow"
    tx.event("disease_replacement_requested", player_id=gain["player_id"], instance_id=instance,
             stage=stage, options=options)


def _apply_plan(tx, plan):
    if plan["clear_choice"]:
        tx.state.update(pending_choice=None, resolution_frames=[])
    for action in plan["actions"]:
        op = action["op"]
        if op == "apply_source":
            tx.event("disease_replacement_applied", player_id=action["player_id"],
                     instance_id=action["instance_id"], **action["option"])
        elif op == "destroy":
            tx.destroy_card(action["instance_id"], reason=action["reason"])
        elif op == "redirect":
            tx.event("disease_redirected", instance_id=action["instance_id"],
                     from_player_id=action["from_player_id"],
                     to_player_id=action["to_player_id"], ability_id=action["ability_id"])
        elif op == "pause":
            pause_gain(tx, action["gain"], action["stage"], action["options"])
        elif op == "complete":
            gain = action["gain"]
            instance = gain["instance_id"]
            destination = f"player:{gain['player_id']}:{gain['destination']}"
            current = location(tx, instance)
            tx.state["instances"][instance]["owner_player_id"] = gain["player_id"]
            if current != destination:
                tx.move(instance, current, destination)
            tx.event("disease_gain_completed", player_id=gain["player_id"],
                     instance_id=instance, replaced_by=list(gain["used_sources"]),
                     destination=destination)
    return plan["done"]


def advance_gain(tx, gain):
    """Continue until a player choice, destruction or final placement."""
    return _apply_plan(tx, turn_atom("plan_disease_gain",
        _plan_input(tx, "advance", gain=gain)))


def resolve_replacement(tx, *, source_instance_id=None, recipient_id=None):
    return _apply_plan(tx, turn_atom("plan_disease_gain",
        _plan_input(tx, "resolve", source_instance_id=source_instance_id,
                    recipient_id=recipient_id)))
