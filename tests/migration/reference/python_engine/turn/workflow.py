"""Serializable engine steps that pause for card choices and resume in order."""

from tests.migration.reference.python_engine.turn.operations import TurnError


def queue_steps(tx, steps: list[dict], *, front: bool = False) -> None:
    queue = tx.state.setdefault("workflow_steps", [])
    if front:
        queue[:0] = steps
    else:
        queue.extend(steps)
    if not getattr(tx, "_workflow_running", False):
        run_steps(tx)


def run_steps(tx) -> None:
    from tests.migration.reference.python_engine.effects.runtime import dispatch_event

    tx._workflow_running = True
    try:
        count = 0
        while tx.state.get("workflow_steps") and tx.state["pending_choice"] is None:
            count += 1
            if count > 4096:
                raise TurnError("engine workflow step limit reached")
            step = tx.state["workflow_steps"].pop(0)
            op = step["op"]
            if op == "event":
                previous = tx.state.get("event_context")
                tx.state["event_context"] = step.get("context", {})
                tx.state["workflow_steps"].insert(0, {"op": "restore_event_context", "value": previous})
                tx.event("rule_timing", event=step["event"], context=step.get("context", {}))
                if step["event"] == "TURN_START":
                    from tests.migration.reference.python_engine.effects.durations import expire_rules
                    expire_rules(tx, "owner_next_turn_start")
                    tx.state["started_turn"] = tx.state["turn_number"]
                    tx.event("TURN_WILL_START", player_id=tx.player_id)
                if not dispatch_event(tx, tx.ruleset, step["event"]):
                    tx.state["effect_resume"] = "workflow"
            elif op == "restore_event_context":
                if step["value"] is None:
                    tx.state.pop("event_context", None)
                else:
                    tx.state["event_context"] = step["value"]
            elif op == "refill_hall":
                from tests.migration.reference.python_engine.turn.hall import refill_step
                refill_step(tx, step)
            elif op == "dispose_revealed":
                instance = step["instance_id"]
                tx.state.get("trap_responses", {}).pop(instance, None)
                if any(instance in pile for zone, pile in tx.state["zones"].items() if zone.startswith("revealed:")):
                    tx.destroy_card(instance, reason="trap_resolved")
            elif op == "guardian_to_rank0":
                instance = step["instance_id"]
                hall = step["hall_zone"]
                if instance in tx.state["zones"][hall]:
                    tx.move(instance, hall, hall + ":rank0")
                    tx.event("guardian_entered_rank_0", instance_id=instance, hall_zone=hall)
            elif op == "finish_turn":
                if tx.state["phase"] == "PLAYING":
                    tx.finish_turn()
            elif op == "pass_turn":
                tx.pass_turn()
            elif op == "turn_will_end":
                tx.event("TURN_WILL_END", player_id=tx.player_id)
                tx.state["subphase"] = "TURN_END_EFFECTS"
                tx.state["timing_window"] = "TURN_WILL_END"
                queue_steps(tx, [{"op": "event", "event": "TURN_WILL_END"}], front=True)
            elif op == "cleanup_turn":
                tx._cleanup_turn()
            elif op == "resolve_battle_outcome":
                from tests.migration.reference.python_engine.turn.dungeon import resolve_battle_outcome
                resolve_battle_outcome(tx)
            elif op == "release_battle_diseases":
                from tests.migration.reference.python_engine.effects.attachments import disease_gain_steps
                queue_steps(tx, disease_gain_steps(tx, step["target_id"], step["timing"]), front=True)
            elif op == "destroy_battle_marks":
                from tests.migration.reference.python_engine.turn.dungeon import destroy_battle_marks
                destroy_battle_marks(tx)
            elif op == "destroy_one":
                from tests.migration.reference.python_engine.effects.responses import offer_destroy
                if offer_destroy(tx, step["instance_id"], step["reason"]):
                    tx.state["effect_resume"] = "workflow"
                else:
                    tx.destroy_card(step["instance_id"], reason=step["reason"])
            elif op == "battle_departure":
                from tests.migration.reference.python_engine.turn.dungeon import battle_departure
                battle_departure(tx)
            elif op == "return_borrowed":
                from tests.migration.reference.python_engine.effects.borrowing import return_borrowed
                return_borrowed(tx, step["timing"])
            elif op == "heart_of_doom_outcome":
                from tests.migration.reference.python_engine.turn.scenarios import resolve_heart_outcome
                resolve_heart_outcome(tx, step["instance_id"], won=step["won"])
            elif op == "gain_disease":
                tx.take_disease(player_id=step["player_id"], destination=step.get("destination", "discard"))
            elif op == "resolve_disease_gain":
                from tests.migration.reference.python_engine.effects.disease import advance_gain
                advance_gain(tx, step["gain"])
            elif op == "effect_continuation":
                from tests.migration.reference.python_engine.effects.runtime import _run
                if not _run(tx, step["ability_id"], step["source_instance_id"], step["stack"]):
                    tx.state["effect_resume"] = "workflow"
            elif op == "village_entry_done":
                from tests.migration.reference.python_engine.turn.village import village_entry_done
                village_entry_done(tx)
            elif op == "enter_action":
                action = step["action"]
                from tests.migration.reference.python_engine.effects.durations import must_enter_dungeon
                if must_enter_dungeon(tx) and action != "dungeon":
                    raise TurnError("this player must enter the dungeon")
                tx.event("TURN_STARTED", player_id=tx.player_id)
                tx.state["chosen_action"] = action
                tx.event("ACTION_WILL_ENTER", player_id=tx.player_id, action=action)
                if action == "village":
                    from tests.migration.reference.python_engine.turn.village import enter_village
                    enter_village(tx)
                elif action == "dungeon":
                    from tests.migration.reference.python_engine.turn.dungeon import enter_dungeon
                    enter_dungeon(tx)
                else:
                    tx.state["subphase"] = tx.state["timing_window"] = "REST"
                tx.event("ACTION_ENTERED", player_id=tx.player_id, action=action)
            else:
                raise TurnError(f"unknown workflow operation: {op}")
            if tx.state["phase"] == "SETTLING":
                tx.state["workflow_steps"] = []
                break
    finally:
        tx._workflow_running = False
