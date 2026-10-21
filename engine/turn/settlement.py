"""One terminal transition shared by dungeon and scenario end conditions."""


def settle_game(tx, reason: str, **details) -> None:
    if tx.state["phase"] == "SETTLING":
        return
    tx.state.update(phase="SETTLING", subphase="GAME_END", timing_window="GAME_END",
                    pending_choice=None, resolution_frames=[], workflow_steps=[])
    tx.state.pop("effect_resume", None)
    tx.state["end_condition"] = {"reason": reason, **details,
                                  "turn_number": tx.state["turn_number"]}
    tx.event("game_end_triggered", **tx.state["end_condition"])
    from engine.effects.borrowing import return_borrowed
    return_borrowed(tx, "after_battle")
    return_borrowed(tx, "turn_end")
    from engine.effects.attachments import restore_at_game_end
    restore_at_game_end(tx)
    from engine.scoring import score_game
    tx.state["result"] = score_game(tx.state, tx.cards, tx.ruleset)
    tx.event("game_scored", result=tx.state["result"])
