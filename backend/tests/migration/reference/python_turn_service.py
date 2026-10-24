"""Apply one authorized player's basic turn command to an immutable input state."""

from __future__ import annotations

from pathlib import Path

from backend.app.integrations.game_engine.catalog.repository import CatalogSnapshot, load_catalog
from backend.app.integrations.game_engine.effects.compiler import EffectsRuleset, load_ruleset
from backend.tests.migration.reference.python_engine.effects.combat import reconcile_equipment, combat_values
from backend.tests.migration.reference.python_engine.effects.runtime import (activate, available_activations,
                                    resolve_choice, resolve_effect_order, resolve_purchase)
from backend.tests.migration.reference.python_engine.effects.choices import resolve_value, resolve_reorder
from backend.tests.migration.reference.python_engine.effects.upgrade import resolve_upgrade
from backend.tests.migration.reference.python_engine.effects.disease import resolve_replacement
from backend.app.core.paths import PROJECT_ROOT
from backend.app.integrations.game_engine.setup.constants import RULESET_VERSION
from backend.tests.migration.reference.python_engine.turn.dungeon import (attack_targets, declare_battle_target,
                                 enter_dungeon, equip_weapon, equipment_options)
from backend.tests.migration.reference.python_engine.turn.operations import Transition, TurnError
from backend.tests.migration.reference.python_engine.turn.state import validate_turn_state
from backend.tests.migration.reference.python_engine.turn.village import (buy_card, enter_village, finish_buying,
                                 finish_abilities, purchasable_cards,
                                 rest_destroy, upgrade_hero, upgrade_options)


def _catalog(state: dict, root: Path,
             snapshot: CatalogSnapshot | None) -> CatalogSnapshot:
    source = snapshot or load_catalog(root)
    if state.get("catalog_version") != source.setup_index["cards_csv_sha256"]:
        raise TurnError("game state uses a different card catalog revision")
    if state.get("ruleset_version") != RULESET_VERSION:
        raise TurnError("unsupported ruleset version")
    return source


def _legal(tx: Transition) -> list[dict]:
    state = tx.state
    if state["pending_choice"] is not None:
        if state["pending_choice"]["kind"] == "effect_response":
            return [{"type": "ResolveResponse", "player_id": state["pending_choice"]["player_id"], "stage": state["pending_choice"]["stage"], "options": state["pending_choice"]["options"], "may_decline": True}]
        if state["pending_choice"]["kind"] == "effect_reuse":
            return [{"type": "ResolveReusedAbility", "player_id": state["pending_choice"]["player_id"], "ability_ids": state["pending_choice"]["options"]}]
        if state["pending_choice"]["kind"] == "disease_replacement":
            return [{"type": "ResolveDiseaseReplacement", "player_id": state["pending_choice"]["player_id"],
                     "stage": state["pending_choice"]["stage"], "options": state["pending_choice"]["options"]}]
        if state["pending_choice"]["kind"] == "effect_upgrade":
            return [{"type": "ResolveEffectUpgrade", "player_id": state["pending_choice"]["player_id"],
                     "options": state["pending_choice"]["options"], "may_skip": True}]
        if state["pending_choice"]["kind"] == "effect_value":
            return [{"type": "ResolveValueChoice", "player_id": state["pending_choice"]["player_id"],
                     "options": state["pending_choice"]["options"]}]
        if state["pending_choice"]["kind"] == "effect_reorder":
            return [{"type": "ResolveCardOrder", "player_id": state["pending_choice"]["player_id"],
                     "instance_ids": state["pending_choice"]["candidate_instance_ids"]}]
        if state["pending_choice"]["kind"] == "effect_purchase":
            return [{"type": "ResolveEffectPurchase", "player_id": state["pending_choice"]["player_id"],
                     "options": state["pending_choice"]["options"], "may_skip": True}]
        if state["pending_choice"]["kind"] == "effect_order":
            return [{"type": "ResolveEffectOrder", "player_id": state["pending_choice"]["player_id"],
                     "effects": [{key: item[key] for key in ("effect_id", "ability_id", "source_instance_id")}
                                 for item in state["pending_choice"]["effects"]]}]
        return [{"type": "ResolveChoice", "instance_ids": list(
            state["pending_choice"]["candidate_instance_ids"]),
            "ability_id": state["pending_choice"]["ability_id"],
            "player_id": state["pending_choice"]["player_id"],
            "min_count": state["pending_choice"].get("min_count", 1),
            "max_count": state["pending_choice"].get("max_count", 1),
            "highest_by": state["pending_choice"].get("highest_by"),
            "constraints": state["pending_choice"].get("constraints", [])}]
    if state["phase"] != "PLAYING":
        return []
    phase = state["subphase"]
    if phase == "TURN_START":
        actions = ["village", "rest"]
        if attack_targets(tx):
            actions.insert(1, "dungeon")
        from backend.tests.migration.reference.python_engine.effects.durations import must_enter_dungeon
        if must_enter_dungeon(tx):
            actions = ["dungeon"]
        return [{"type": "ChooseAction", "actions": actions}]
    if phase == "VILLAGE_ABILITIES":
        options = available_activations(tx, tx.ruleset) if tx.ruleset else []
        return ([{"type": "ActivateAbility", "options": options}]
                if options else []) + [{"type": "FinishAbilities"}]
    if phase == "VILLAGE_BUY":
        available = purchasable_cards(tx)
        return ([{"type": "BuyCard", "card_ids": available}] if available else []) + [
            {"type": "FinishBuying"}]
    if phase == "VILLAGE_UPGRADE":
        options = upgrade_options(tx)
        return ([{"type": "UpgradeHero", "options": options}] if options else []) + [
            {"type": "FinishUpgrading"}]
    if phase == "REST":
        return ([{"type": "RestDestroy", "instance_ids": list(tx.zone("hand"))}]
                if tx.zone("hand") else []) + [{"type": "FinishRest"}]
    if phase == "DUNGEON_PREPARE":
        equipment = equipment_options(tx)
        abilities = available_activations(tx, tx.ruleset) if tx.ruleset else []
        diseases = combat_values(tx, 1)["disease_penalties"]
        penalties = combat_values(tx, 1)["strength_penalties"]
        return ([{"type": "AssignStrengthPenalty", "penalties": penalties,
                  "hero_instance_ids": list(combat_values(tx, 1)["hero_strength"])}] if penalties else []) + ([{"type": "AssignDiseasePenalty", "instance_ids": [item["instance_id"] for item in diseases],
                  "attack_types": ["attack", "magic_attack"]}] if diseases else []) + ([{"type": "ActivateAbility", "options": abilities}]
                if abilities else []) + ([{"type": "EquipWeapon", "options": equipment}]
                if equipment else []) + [
                    {"type": "DeclareBattleTarget", "instance_ids": attack_targets(tx)}]
    raise TurnError(f"unknown turn subphase: {phase}")


def legal_commands(state: dict, root: Path = PROJECT_ROOT, *,
                   snapshot: CatalogSnapshot | None = None,
                   effects: EffectsRuleset | None = None) -> list[dict]:
    """Describe the next accepted command types and currently known candidates."""
    source = _catalog(state, root, snapshot)
    validate_turn_state(state, source.cards)
    ruleset = effects or load_ruleset(source.cards, root)
    if state.get("effects_version") != ruleset.version:
        raise TurnError("game state uses a different executable effect revision")
    return _legal(Transition(state, source.cards, ruleset))


def apply_command(state: dict, command: dict, root: Path = PROJECT_ROOT, *,
                  snapshot: CatalogSnapshot | None = None,
                  effects: EffectsRuleset | None = None,
                  trace_effects: bool = False) -> dict:
    """Return a new state, private events and legal next commands.

    The input state is never mutated. One accepted command increments game_version
    once; all emitted events consume consecutive next_event_sequence values.
    """
    source = _catalog(state, root, snapshot)
    validate_turn_state(state, source.cards)
    if state["phase"] != "PLAYING":
        raise TurnError("game is already settling")
    if not isinstance(command, dict) or not isinstance(command.get("type"), str):
        raise TurnError("command requires a type")
    actor = (state["pending_choice"]["player_id"] if state["pending_choice"]
             else state["active_player_id"])
    if command.get("player_id") != actor:
        raise TurnError("only the active or chosen player may submit this command")
    if ("expected_version" in command
            and command["expected_version"] != state["game_version"]):
        raise TurnError("stale game version")
    ruleset = effects or load_ruleset(source.cards, root)
    if state.get("effects_version") != ruleset.version:
        raise TurnError("game state uses a different executable effect revision")
    tx = Transition(state, source.cards, ruleset, trace_effects=trace_effects, setup_index=source.setup_index)
    kind = command["type"]
    phase = state["subphase"]
    if state["pending_choice"] is not None:
        if state["pending_choice"]["kind"] == "effect_response":
            if kind != "ResolveResponse":
                raise TurnError("an effect response must be resolved first")
            from backend.tests.migration.reference.python_engine.effects.responses import resolve_response
            completed = resolve_response(tx, source_instance_id=command.get("source_instance_id"), recipient_id=command.get("recipient_id"))
        elif state["pending_choice"]["kind"] == "effect_reuse":
            if kind != "ResolveReusedAbility":
                raise TurnError("a reused ability must be chosen first")
            from backend.tests.migration.reference.python_engine.effects.abilities import resolve_reuse
            completed = resolve_reuse(tx, command.get("ability_id"))
        elif state["pending_choice"]["kind"] == "disease_replacement":
            if kind != "ResolveDiseaseReplacement":
                raise TurnError("a disease replacement must be resolved first")
            completed = resolve_replacement(tx, source_instance_id=command.get("source_instance_id"),
                                            recipient_id=command.get("recipient_id"))
        elif state["pending_choice"]["kind"] == "effect_upgrade":
            if kind != "ResolveEffectUpgrade":
                raise TurnError("an effect upgrade must be resolved first")
            completed = resolve_upgrade(tx, command.get("source_instance_id"), command.get("target_card_id"))
        elif state["pending_choice"]["kind"] == "effect_value":
            if kind != "ResolveValueChoice":
                raise TurnError("an effect value choice must be resolved first")
            completed = resolve_value(tx, command.get("value"))
        elif state["pending_choice"]["kind"] == "effect_reorder":
            if kind != "ResolveCardOrder":
                raise TurnError("an effect card ordering must be resolved first")
            completed = resolve_reorder(tx, command.get("instance_ids"))
        elif state["pending_choice"]["kind"] == "effect_purchase":
            if kind != "ResolveEffectPurchase":
                raise TurnError("an effect purchase must be resolved first")
            completed = resolve_purchase(tx, command.get("card_id"))
        elif state["pending_choice"]["kind"] == "effect_order":
            if kind != "ResolveEffectOrder":
                raise TurnError("an effect order must be chosen first")
            completed = resolve_effect_order(tx, command.get("effect_ids"))
        elif kind != "ResolveChoice":
            raise TurnError("an effect choice must be resolved first")
        else:
            completed = resolve_choice(tx, command.get("instance_ids", command.get("instance_id")))
        if completed and tx.state.get(
                "effect_resume") is not None:
            tx.resume_after_effects()
    elif phase == "TURN_START" and kind == "ChooseAction":
        action = command.get("action")
        if action not in _legal(tx)[0]["actions"]:
            raise TurnError("action is not available in the current game state")
        from backend.tests.migration.reference.python_engine.turn.workflow import queue_steps
        steps = [] if tx.state.get("started_turn") == tx.state["turn_number"] else [
            {"op": "event", "event": "TURN_START"}]
        queue_steps(tx, [*steps, {"op": "enter_action", "action": action}])
    elif phase == "VILLAGE_BUY" and kind == "BuyCard":
        buy_card(tx, command.get("card_id"))
    elif phase == "VILLAGE_ABILITIES" and kind == "FinishAbilities":
        finish_abilities(tx)
    elif phase in ("VILLAGE_ABILITIES", "DUNGEON_PREPARE") and kind == "ActivateAbility":
        activate(tx, tx.ruleset, command.get("ability_id"),
                 command.get("source_instance_id"))
    elif phase == "VILLAGE_BUY" and kind == "FinishBuying":
        finish_buying(tx)
    elif phase == "VILLAGE_UPGRADE" and kind == "UpgradeHero":
        upgrade_hero(tx, command.get("source_instance_id"),
                     command.get("target_card_id"))
    elif phase == "VILLAGE_UPGRADE" and kind == "FinishUpgrading":
        tx.finish_turn()
    elif phase == "REST" and kind == "RestDestroy":
        rest_destroy(tx, command.get("instance_id"))
    elif phase == "REST" and kind == "FinishRest":
        tx.finish_turn()
    elif phase == "DUNGEON_PREPARE" and kind == "EquipWeapon":
        equip_weapon(tx, command.get("hero_instance_id"),
                     command.get("weapon_instance_id"))
    elif phase == "DUNGEON_PREPARE" and kind == "DeclareBattleTarget":
        declare_battle_target(tx, command.get("target_instance_id"))
    elif phase == "DUNGEON_PREPARE" and kind == "AssignDiseasePenalty":
        disease_ids = [item["instance_id"] for item in combat_values(tx, 1)["disease_penalties"]]
        selected = command.get("instance_id")
        attack_type = command.get("attack_type")
        if selected not in disease_ids or attack_type not in ("attack", "magic_attack"):
            raise TurnError("invalid disease penalty assignment")
        context = tx.state["battle_context"]
        context.setdefault("disease_penalty_assignments", {})[selected] = attack_type
        if "order" in command:
            order = command["order"]
            if (not isinstance(order, list) or len(order) != len(disease_ids)
                    or set(order) != set(disease_ids)):
                raise TurnError("disease order must contain every disease once")
            context["disease_order"] = order
        combat_values(tx, 1)
        tx.event("disease_penalty_assigned", instance_id=selected, attack_type=attack_type)
    elif phase == "DUNGEON_PREPARE" and kind == "AssignStrengthPenalty":
        trace = combat_values(tx, 1)
        disease, hero = command.get("instance_id"), command.get("hero_instance_id")
        if disease not in [row["instance_id"] for row in trace["strength_penalties"]] or hero not in trace["hero_strength"]:
            raise TurnError("invalid single-hero strength penalty assignment")
        tx.state["battle_context"].setdefault("strength_penalty_assignments", {})[disease] = hero
        tx.event("strength_penalty_assigned", instance_id=disease, hero_instance_id=hero)
    else:
        raise TurnError(f"{kind} is not allowed during {phase}")
    if tx.state.get("battle_context") is not None:
        reconcile_equipment(tx)
    result = tx.finish()
    validate_turn_state(result["state"], source.cards)
    result["legal_commands"] = _legal(tx)
    return result
