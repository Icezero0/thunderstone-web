"""Recipient-controlled disease replacements; each source applies once per gain."""

from copy import deepcopy

from engine.rules.players import active_players
from engine.turn.operations import TurnError


def sources(tx, gain):
    from engine.effects.abilities import source_matches
    recipient = gain["player_id"]
    others = [player for player in active_players(tx.state) if player != recipient]
    rules = [rule for rule in tx.ruleset.mechanics if rule.op == "replace_disease"] if tx.ruleset else []
    return [{"source_instance_id": source, "ability_id": rule.id, "action": rule.params["action"]}
            for source in tx.zone("hand", recipient) if source not in gain["used_sources"]
            for rule in rules if source_matches(tx, source, rule.source_card_id)
            and (rule.params["action"] != "redirect" or others)]


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


def apply_source(tx, gain, option):
    gain["used_sources"].append(option["source_instance_id"])
    gain["ability_id"] = option["ability_id"]
    tx.event("disease_replacement_applied", player_id=gain["player_id"], instance_id=gain["instance_id"], **option)
    if option["action"] == "destroy":
        tx.destroy_card(gain["instance_id"], reason=option["ability_id"])
        return True
    gain["destination"] = "discard"
    return False


def advance_gain(tx, gain):
    """Complete automatically when mandatory choices have a single candidate."""
    for _ in range(len(tx.state["instances"]) + 1):
        options = sources(tx, gain)
        if not options:
            instance = gain["instance_id"]
            destination = f"player:{gain['player_id']}:{gain['destination']}"
            current = location(tx, instance)
            tx.state["instances"][instance]["owner_player_id"] = gain["player_id"]
            if current != destination:
                tx.move(instance, current, destination)
            tx.event("disease_gain_completed", player_id=gain["player_id"], instance_id=instance,
                     replaced_by=list(gain["used_sources"]), destination=destination)
            return True
        if len(options) > 1:
            pause_gain(tx, gain, "source", options)
            return False
        if apply_source(tx, gain, options[0]):
            return True
        recipients = [player for player in active_players(tx.state) if player != gain["player_id"]]
        if len(recipients) > 1:
            pause_gain(tx, gain, "recipient", recipients)
            return False
        previous = gain["player_id"]
        gain["player_id"] = recipients[0]
        tx.event("disease_redirected", instance_id=gain["instance_id"], from_player_id=previous,
                 to_player_id=gain["player_id"], ability_id=gain["ability_id"])
    raise TurnError("disease replacement failed to consume a source")


def resolve_replacement(tx, *, source_instance_id=None, recipient_id=None):
    choice = tx.state["pending_choice"]
    if choice is None or choice["kind"] != "disease_replacement":
        raise TurnError("no disease replacement is pending")
    frames = tx.state["resolution_frames"]
    if len(frames) != 1 or frames[0].get("kind") != "disease_gain":
        raise TurnError("invalid disease replacement continuation")
    gain = deepcopy(frames[0]["gain"])
    if gain["instance_id"] not in tx.state["instances"] or gain["player_id"] != choice["player_id"]:
        raise TurnError("invalid disease replacement recipient or instance")
    if choice["stage"] == "source":
        option = next((option for option in sources(tx, gain) if option in choice["options"]
                       and option["source_instance_id"] == source_instance_id), None)
        if option is None or recipient_id is not None:
            raise TurnError("invalid disease replacement source")
        tx.state.update(pending_choice=None, resolution_frames=[])
        if apply_source(tx, gain, option):
            return True
        recipients = [player for player in active_players(tx.state) if player != gain["player_id"]]
        if len(recipients) > 1:
            pause_gain(tx, gain, "recipient", recipients)
            return False
        recipient_id = recipients[0]
    else:
        if source_instance_id is not None or recipient_id not in choice["options"] or recipient_id not in active_players(tx.state):
            raise TurnError("invalid disease redirection recipient")
        tx.state.update(pending_choice=None, resolution_frames=[])
    previous = gain["player_id"]
    gain["player_id"] = recipient_id
    tx.event("disease_redirected", instance_id=gain["instance_id"], from_player_id=previous,
             to_player_id=recipient_id, ability_id=gain["ability_id"])
    return advance_gain(tx, gain)
