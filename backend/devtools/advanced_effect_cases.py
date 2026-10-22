"""Reviewed advanced-card traces, composed from public engine commands."""

from backend.app.integrations.game_engine.shared.client import client
from backend.app.integrations.game_engine.shared.projection import calculation_input

ADVANCED_IDS = {"hero-copy", "borrowed-weapon", "trap-immunity", "spell-reuse", "attached-disease", "extra-turn"}


def run_advanced(case_id, run_class, choose, choice_index):
    run = run_class(case_id, "lab-advanced-" + case_id)
    actor = run.player
    other = next(p for p in run.state["player_order"] if p != actor)
    ids = {}

    def arrange(state):
        state["active_settings"] = []
        for zone in list(state["zones"]):
            if zone.startswith(("player:", "hall:", "dungeon:")):
                run.clear_zone(zone)
        for _ in range(12):
            run.add_to_zone("TS-0003", f"player:{actor}:draw")
        ids["target"] = run.add_to_zone("TS-0459" if case_id == "borrowed-weapon" else "TS-0486", "hall:main")
        if case_id == "hero-copy":
            ids["militia"] = run.add_hand("TS-0001")
            ids["template"] = run.add_hand("TS-0428")
            ids["source"] = run.add_hand("TS-0415")
            ids["diseases"] = [run.add_hand("TS-0714") for _ in range(2)]
        elif case_id == "borrowed-weapon":
            ids["source"] = run.add_hand("TS-0327")
            ids["weapon"] = run.add_to_zone("TS-0234", f"player:{other}:hand")
        elif case_id == "trap-immunity":
            ids["source"] = run.add_hand("TS-0268")
            ids["hero"] = run.add_hand("TS-0302")
            ids["response"] = run.add_to_zone("TS-0536", f"player:{other}:hand")
            ids["other_draw"] = [run.add_to_zone("TS-0302", f"player:{other}:draw") for _ in range(3)]
            for _ in range(2):
                run.add_to_zone("TS-0476", "hall:main")
            run.add_to_zone("TS-0691", "dungeon:main")
            for _ in range(4):
                run.add_to_zone("TS-0476", "dungeon:main")
        elif case_id == "spell-reuse":
            ids["hero"] = run.add_hand("TS-0415")
            ids["spell"] = run.add_hand("TS-0267")
            ids["staff"] = run.add_hand("TS-0244")
        elif case_id == "attached-disease":
            ids["source"] = run.add_hand("TS-0422")
            ids["disease"] = run.add_hand("TS-0714")
        else:
            ids["treasure"] = run.add_to_zone("TS-0696", f"player:{actor}:control")

    run.fixture("清空随机场景，只放置本例涉及的卡牌及后续手牌；所有修改仅在内存中", arrange)
    run.do("ChooseAction", action="dungeon")
    if case_id == "hero-copy":
        run.do("ActivateAbility", ability_id="TS-0415-A02", source_instance_id=ids["source"])
        trace = client.call("combat_values", {"input": calculation_input(run.state, run.cards, run.effects), "rank": 1})
        component = next(row for row in trace["components"] if row["instance_id"] == ids["militia"])
        run.check("民兵保留名称、等级、力量和标签",
                  run.state["instances"][ids["militia"]]["card_id"] == "TS-0001"
                  and not run.state.get("copied_heroes", {}).get(ids["militia"], {}).get("full_card"))
        run.check("复制的攻击 +3 替换原攻击 +1", component["attack"] == 3)
        run.do("ActivateAbility", ability_id="TS-0428-A02", source_instance_id=ids["militia"])
        chosen = choose(run, choice_index)
        run.check("复制的主动效果正常摧毁疾病并抽两张", chosen not in run.state["instances"]
                  and len(run.steps[-1]["events"]) > 0)
        run.do("ActivateAbility", ability_id="TS-0428-A02", source_instance_id=ids["template"])
        run.check("原英雄仍可独立发动相同能力", all(d not in run.state["instances"] for d in ids["diseases"]))
    elif case_id == "borrowed-weapon":
        run.do("ActivateAbility", ability_id="TS-0327-A03", source_instance_id=ids["source"])
        run.do("ResolveChoice", instance_ids=[ids["weapon"]])
        run.check("借来武器立即装备，并记录原持有者", ids["weapon"] in run.state["borrowed_cards"]
                  and run.state["battle_context"]["equipped_weapon_by_hero"][ids["source"]] == ids["weapon"])
        result = run.do("DeclareBattleTarget", target_instance_id=ids["target"])
        run.check("战斗后武器正常被摧毁", ids["weapon"] in run.state["zones"]["destroyed"])
        run.check("被摧毁的武器不会归还", not any(e["kind"] == "borrowed_card_returned" for e in result["events"]))
    elif case_id == "trap-immunity":
        run.do("ActivateAbility", ability_id="TS-0268-A01", source_instance_id=ids["source"])
        run.do("ResolveChoice", instance_id=ids["target"])
        choice = run.state["pending_choice"]
        run.do("ResolveEffectOrder", effect_ids=[r["effect_id"] for r in choice["effects"]])
        run.check("陷阱让实际受影响的对手选择反应", run.state["pending_choice"]["player_id"] == other)
        run.do("ResolveResponse", source_instance_id=ids["response"])
        # Drive the original banishment cost to completion, without consuming a
        # card carrying another response/trigger.
        if run.state["pending_choice"]:
            run.do("ResolveChoice", instance_id=ids["source"])
        run.check("当前玩家仍摧毁自己的英雄", ids["hero"] in run.state["zones"]["destroyed"])
        run.check("只保护拦路匪持有者的牌堆", run.state["zones"][f"player:{other}:draw"] == ids["other_draw"])
        run.check("陷阱后恢复原能力", run.state["pending_choice"] is None and run.state["subphase"] == "DUNGEON_PREPARE")
    elif case_id == "spell-reuse":
        run.do("ActivateAbility", ability_id="TS-0267-A01", source_instance_id=ids["spell"])
        run.do("EquipWeapon", hero_instance_id=ids["hero"], weapon_instance_id=ids["staff"])
        run.do("ActivateAbility", ability_id="TS-0244-A02", source_instance_id=ids["staff"])
        run.check("等待选择要重用的已发动法术能力", run.state["pending_choice"]["kind"] == "effect_reuse")
        run.do("ResolveReusedAbility", ability_id="TS-0267-A01")
        trace = client.call("combat_values", {"input": calculation_input(run.state, run.cards, run.effects), "rank": 1})
        component = next(row for row in trace["components"] if row["instance_id"] == ids["hero"])
        run.check("两次战斗狂暴累计攻击 +2", component["attack"] == 2)
        run.do("DeclareBattleTarget", target_instance_id=ids["target"])
        run.check("回合末摧毁重用的法术", ids["spell"] in run.state["zones"]["destroyed"])
    elif case_id == "attached-disease":
        run.do("ActivateAbility", ability_id="TS-0422-A02", source_instance_id=ids["source"])
        run.check("疾病附着在怪物下并失去原持有者", run.state["zones"]["attached:" + ids["target"]] == [ids["disease"]]
                  and run.state["instances"][ids["disease"]]["owner_player_id"] is None)
        run.fixture("加入疫病破除者，验证疾病重新获得时的替代", lambda state: run.add_hand("TS-0239"))
        result = run.do("DeclareBattleTarget", target_instance_id=ids["target"])
        run.check("开战前获得的同一张疾病被替代摧毁", ids["disease"] not in run.state["instances"]
                  and any(e["kind"] == "disease_replacement_applied" for e in result["events"]))
        run.check("已清除附着记录", not run.state.get("attachments"))
    else:
        run.fixture("提供足够攻击，单独观察额外回合顺序", lambda state: state["battle_context"].update(modifiers={"attack": 100}))
        run.do("DeclareBattleTarget", target_instance_id=ids["target"])
        run.do("ResolveChoice", instance_ids=[ids["treasure"]])
        run.check("额外回合仍由原玩家开始", run.player == actor and run.state["turn_number"] == 2)
        run.do("ChooseAction", action="rest")
        run.do("FinishRest")
        run.check("额外回合后恢复正常顺序", run.player == other and run.state["turn_number"] == 3)
    return run
