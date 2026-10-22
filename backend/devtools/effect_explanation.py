"""Deterministic Chinese explanations of executable effects, never card-text paraphrases."""

STATS = {"attack": "普通攻击", "magic_attack": "魔法攻击", "light": "光照", "strength": "力量",
         "weight": "重量", "level": "英雄等级", "gold": "金币值", "health": "生命值",
         "cost": "购买价格", "purchase_cost": "购买价格", "vp": "胜利点", "xp_reward": "击败经验奖励",
         "pile_size": "供应堆剩余张数"}
STATS["magic"] = "魔法攻击"  # Filter spelling (magic_min/max), not a runtime stat name.
EVENTS = {"BATTLE_BEFORE_OUTCOME": "本场战斗计算结果前", "BATTLE_AFTER_OUTCOME": "本场战斗结果确定后",
          "MONSTER_DEFEATED": "怪物被击败后", "TURN_WILL_END": "本回合结束时（清理手牌前）",
          "TURN_START": "该玩家下个回合开始时", "VILLAGE_ENTER": "进入村庄时",
          "DUNGEON_ENTER": "进入地下城时", "HALL_REVEALED": "此牌进入地下城大厅时",
          "BREACH": "此牌补位进入阶层 1、触发突破时", "CARD_PURCHASED": "当前玩家购买牌后",
          "HERO_UPGRADED": "当前玩家升级英雄后", "HAND_REFILL_COMPLETE": "回合末补充手牌后",
          "BEFORE_HALL_REFILL": "补充地下城大厅之前", "CARD_EQUIPPED": "装备武器后",
          "ACTION_EXITED": "本次行动完成后", "TRAP_REVEALED": "翻出陷阱时"}
ACTIONS = {"village": "村庄", "dungeon": "地下城", "rest": "休整"}
COMPARE = {"eq": "等于", "ne": "不等于", "lt": "小于", "le": "不大于", "gt": "大于", "ge": "不少于"}


class Explainer:
    def __init__(self, cards):
        self.cards = cards
        self.unsupported = set()

    def unknown(self, kind, value):
        self.unsupported.add(f"{kind}:{value}")
        return f"尚未翻译的{kind}（{value}），请展开原始定义核查"

    def card(self, card_id):
        return f"「{self.cards.get(card_id, {}).get('name', card_id)}」"

    def filters(self, spec, names=None):
        names = names or {}
        result = []
        for key, value in spec.items():
            if key in ("zone", "var", "collection"):
                continue
            if key == "card_id":
                result.append(self.card(value))
            elif key in ("tag", "card_type", "subcategory", "name"):
                result.append({"tag": "具有标签", "card_type": "大分类为", "subcategory": "二级分类为", "name": "名称为"}[key] + f"「{value}」")
            elif key in ("tags_any", "tags_none", "equipper_tags_any"):
                prefix = {"tags_any": "至少具有其中一种标签", "tags_none": "不具有以下任一标签", "equipper_tags_any": "装备者具有其中一种标签"}[key]
                result.append(prefix + "「" + "／".join(value) + "」")
            elif key in ("exclude_card_id", "exclude_card_type"):
                result.append("排除" + (self.card(value) if key == "exclude_card_id" else value))
            elif key in ("max_by", "min_by"):
                result.append(STATS.get(value, value) + ("最高（并列均可选）" if key == "max_by" else "最低（并列均可选）"))
            elif key == "exclude_source":
                if value:
                    result.append("排除此能力的来源牌")
            elif key in ("exclude_var", "exclude_pile_var", "name_in_var", "same_name_as_var", "adjacent_to_var"):
                label = names.get(value, "此前选定的牌")
                result.append({"exclude_var": f"排除{label}", "exclude_pile_var": f"排除{label}所属供应堆",
                               "name_in_var": f"名称出现在{label}中", "same_name_as_var": f"与{label}同名",
                               "adjacent_to_var": f"与{label}处于相邻阶层"}[key])
            elif key == "without_weapon_tag":
                result.append(f"没有装备「{value}」武器")
            elif key == "equipper_card_id":
                result.append("装备给" + self.card(value))
            elif key == "semantic_type":
                result.append("按规则视为" + {"hero": "英雄", "village": "村庄牌（按村庄标签，可同时为英雄）", "monster": "怪物"}.get(value, value))
            elif key == "compare_stat":
                result.append(f"{STATS[value['field']]}{COMPARE[value['op']]}{self.expr(value['value'], names)}")
            elif key == "rank":
                result.append(f"位于阶层 {value}")
            elif key in ("gold_present", "cost_present", "vp_present"):
                field = {"gold_present": "金币", "cost_present": "购买价格", "vp_present": "胜利点"}[key]
                result.append(("印有" if value else "未印有") + field + "数值")
            elif key in ("participating", "unmarked", "equipped", "unused", "used", "revealed_only", "movable", "in_hand",
                         "in_discard", "duplicate_names", "in_selected_dungeon", "equipment_space", "same_family_as_event"):
                positive, negative = {
                    "participating": ("参与本场战斗", "不参与本场战斗"),
                    "unmarked": ("尚未被标记战后摧毁", "已被标记战后摧毁"),
                    "equipped": ("已装备武器", "未装备武器"), "unused": ("本回合尚未使用", "本回合已使用"),
                    "used": ("本回合已使用", "本回合尚未使用"), "revealed_only": ("仍处于本次翻牌区", "不在本次翻牌区"),
                    "movable": ("允许从大厅移出", "不允许从大厅移出"), "in_hand": ("仍在手牌", "不在手牌"),
                    "in_discard": ("仍在弃牌堆", "不在弃牌堆"), "duplicate_names": ("手牌中存在同名牌", "手牌中无同名牌"),
                    "in_selected_dungeon": ("位于选定地下城", "不在选定地下城"), "equipment_space": ("仍有装备空位", "无装备空位"),
                    "same_family_as_event": ("与本次被击败怪物属于同组", "与本次被击败怪物不同组")}[key]
                result.append(positive if value else negative)
            elif key.endswith(("_min", "_max")) and key.rsplit("_", 1)[0] in STATS:
                field, bound = key.rsplit("_", 1)
                result.append(f"{STATS[field]}{'不少于' if bound == 'min' else '不大于'} {value}")
            else:
                result.append(self.unknown("筛选条件", key))
        return result

    def query(self, spec, names=None):
        names = names or {}
        zones = {"active_hand": "当前玩家手牌", "subject_hand": "受影响玩家的手牌", "active_discard": "当前玩家弃牌堆",
                 "subject_discard": "受影响玩家的弃牌堆", "village_supply_top": "各非空村庄供应堆的堆顶牌",
                 "hero_supply_top": "各非空英雄供应堆的堆顶牌", "hall": "地下城大厅中的牌",
                 "event_source": "触发本次事件的牌", "event_hero": "本次装备事件的英雄",
                 "active_control": "当前玩家控制的宝藏", "event_supply_top": "本次购买所来自供应堆的现有堆顶牌",
                 "defeated_monster": "刚被击败的怪物", "defeated_this_turn": "本回合已击败的怪物",
                 "other_hand": "其他玩家的手牌", "other_discard": "其他玩家的弃牌堆",
                 "all_hand": "所有玩家的手牌", "all_discard": "所有玩家的弃牌堆",
                 "reveal_zone": "本次翻开后仍留在翻牌区的牌", "subject_control": "受影响玩家控制的宝藏",
                 "other_control": "其他玩家控制的宝藏", "active_hand_or_village_top": "当前玩家手牌或村庄堆顶牌"}
        zone = spec["zone"]
        if zone == "bound":
            base = names.get(spec["var"], "此前选定的牌")
        elif zone == "collection":
            base = "跨玩家汇总的" + ("英雄" if spec["collection"] == "heroes" else "牌")
        else:
            base = zones.get(zone) or self.unknown("区域", zone)
        qualifiers = self.filters(spec, names)
        return base + ("中满足以下条件的牌：" + "；".join(qualifiers) if qualifiers else "")

    def expr(self, value, names=None):
        names = names or {}
        if isinstance(value, (int, str)):
            return str(value)
        op, operand = next(iter(value.items()))
        if op == "count":
            return "（" + self.query(operand, names) + "的张数）"
        if op == "stat":
            return names.get(operand["var"], "此前选定的牌") + "的" + STATS[operand["field"]]
        if op == "value":
            return names.get(operand, "此前选择的数值")
        if op in ("sum", "maximum"):
            return "（" + self.query(operand["query"], names) + "的" + STATS[operand["field"]] + ("总和）" if op == "sum" else "最大值）")
        if op == "resource":
            return {"xp": "受影响玩家当前经验值", "temporary_gold": "当前临时金币"}[operand]
        if op == "players":
            return "仍参与对局的玩家人数" if operand == "all" else "其他仍参与对局的玩家人数"
        if op == "context":
            return {"price": "本次购买价格", "rank": "本次事件阶层"}[operand]
        if op == "combat":
            return "当前队伍的" + STATS[operand]
        if op in ("add", "sub", "mul", "div", "min", "max"):
            left, right = (self.expr(part, names) for part in operand)
            if op in ("min", "max"):
                return f"（{left} 与 {right} 中的{'较小' if op == 'min' else '较大'}值）"
            return f"（{left} { {'add': '+', 'sub': '−', 'mul': '×', 'div': '÷（向下取整）'}[op]} {right}）"
        return self.unknown("表达式", op)

    def condition(self, spec, names=None):
        op, value = next(iter(spec.items()))
        if op in ("all", "any"):
            return (" 且 " if op == "all" else " 或 ").join("（" + self.condition(part, names) + "）" for part in value)
        if op == "not":
            return "不满足：" + self.condition(value, names)
        if op == "exists":
            return self.query(value, names) + "至少有 1 张"
        if op == "compare":
            return self.expr(value["left"], names) + " " + COMPARE[value["op"]] + " " + self.expr(value["right"], names)
        if op == "choice_is":
            return "此前选择了「" + {"pay": "支付代价", "decline": "拒绝支付"}.get(value["option"], value["option"]) + "」"
        if op == "action_in":
            return "本回合行动为" + "／".join(ACTIONS[action] for action in value)
        if op == "setting_active":
            return self.card(value) + "设置生效"
        if op == "subject_is_active":
            return "受影响玩家" + ("是" if value else "不是") + "当前回合玩家"
        return self.unknown("条件", op)

    def node(self, node, names=None):
        names = {"source": "此怪物牌", **(names or {})}
        op = node["op"]
        item = lambda text, children=(): {"text": text, "children": list(children)}
        target = lambda: names.get(node["target"]["var"], "此前选定的牌")
        amount = lambda: self.expr(node.get("amount", node.get("count", 1)), names)
        if op == "sequence":
            return item("按顺序执行：", [self.node(child, names) for child in node["children"]])
        if op == "if":
            branches = [item("条件成立时：", [self.node(node["then"], names)])]
            if "else" in node:
                branches.append(item("否则：", [self.node(node["else"], names)]))
            return item("检查条件：" + self.condition(node["condition"], names), branches)
        if op == "select":
            lower, upper = self.expr(node.get("min", 1), names), self.expr(node.get("max", 1), names)
            count = lower if lower == upper else lower + "～" + upper
            text = f"由受影响玩家从{self.query(node['query'], names)}选择 {count} 张"
            if node.get("allow_shortfall"):
                text += "；不足时选择现有合法目标"
            if node.get("highest_by"):
                text += "；必须保留" + STATS[node["highest_by"]] + "最高者，临界并列由选择者决定"
            for constraint in node.get("constraints", []):
                text += f"；其中满足「{'；'.join(self.filters(constraint['filter'], names))}」的牌最多 {constraint['maximum']} 张"
            return item(text, [self.node(node["then"], {**names, node["bind"]: "刚才选择的牌"})])
        if op == "for_each":
            return item("逐张处理：" + self.query(node["query"], names),
                        [self.node(node["body"], {**names, node["bind"]: "本次处理的牌"})])
        if op == "for_players":
            scope = {"all": "每位仍参与对局的玩家", "others": "其他每位仍参与对局的玩家", "active": "当前玩家"}[node["scope"]]
            return item("对" + scope + "分别执行以下部分（下文的受影响玩家指该玩家）：", [self.node(node["body"], names)])
        if op == "cost_gate":
            return item("支付以下代价后才获得收益（摧毁被弃牌替代仍算支付）：", [
                item("代价", [self.node(node["cost"], names)]), item("成功支付后", [self.node(node["then"], names)])])
        if op in ("schedule", "listen"):
            text = ("延后到" if op == "schedule" else "本回合监听：") + EVENTS.get(node["event"], node["event"])
            if node.get("once"):
                text += "，条件满足后仅执行一次"
            children = [item("触发条件：" + self.condition(c, names)) for c in node.get("conditions", [])]
            return item(text, [*children, self.node(node["body"], names)])
        if op == "repeat":
            return item(f"重复 {self.expr(node['times'], names)} 次（最多 {node['limit']} 次）：", [self.node(node["body"], names)])
        if op == "choose_value":
            if node["kind"] == "enum":
                options = "／".join({"pay": "支付代价", "decline": "拒绝支付"}.get(v, str(v)) for v in node["options"])
            elif node["kind"] == "number":
                options = self.expr(node.get("min", 0), names) + "～" + self.expr(node["max"], names)
            else:
                options = "其他玩家" if node["kind"] == "player" else "一座地下城"
            return item("由受影响玩家选择：" + options,
                        [self.node(node["then"], {**names, node["bind"]: "所选数值"})])
        if op in ("let", "remember"):
            value = self.expr(node["value"], names) if op == "let" else self.query(node["query"], names)
            return item("记住此刻的" + value, [self.node(node["then"], {**names, node["bind"]: "此前记录的数值或牌"})])
        if op == "discard_until":
            return item("从受影响玩家当前抽牌堆逐张翻牌，不符合「" + "；".join(self.filters(node["filter"], names))
                        + "」的牌立即放入该玩家弃牌堆；抽牌堆空时洗混弃牌堆继续。翻到第一张符合的牌时停止并处理下文；所有可取实例均已检定且无进展时结束。重复翻到同一实例仍正常处理。",
                        [self.node(node["then"], {**names, node["bind"]: "本次找到的牌"})])
        if op == "reveal_cycle":
            return item("按逆时针顺序，受影响玩家轮流翻开个人抽牌堆顶 1 张牌；符合「"
                        + "；".join(self.filters(node["filter"], names)) + "」的牌执行摧毁并累计数量，其余牌立即弃掉。"
                        + f"抽牌堆空时洗混弃牌堆继续，达到 {node['goal']} 张时结束；若所有参与者的可取实例均已检定且无法推进目标，也结束。"
                        + "无进展记录按玩家与实例保留，成功处理和洗牌不会清空记录，已记录的牌仍按顺序正常检定。")
        if op == "reveal":
            origin = "地下城牌堆" if node.get("zone") == "dungeon" else "受影响玩家的抽牌堆"
            if "until" in node:
                text = f"从{origin}逐张翻牌，直到翻到「{'；'.join(self.filters(node['until'], names))}」或无牌可翻（最多 {self.expr(node['count'], names)} 张）"
            else:
                text = f"从{origin}顶部翻开 {self.expr(node['count'], names)} 张牌"
            ending = "；以下处理完成后，未移走的牌放回原地下城牌堆顶部" if node.get("zone") == "dungeon" else "；抽牌堆空时洗混弃牌堆继续；以下处理完成后，未移走的牌放入该玩家弃牌堆"
            return item(text + ending,
                        [self.node(node["then"], {**names, node["bind"]: "本次翻开的牌"})])
        if op == "draw":
            text = f"受影响玩家抽 {self.expr(node['count'], names)} 张牌；抽牌堆空时洗混弃牌堆继续"
            return item(text, [self.node(node["then"], {**names, node["bind"]: "本次抽到的牌"})] if "bind" in node else [])
        if op in ("destroy", "discard", "mark_destroy", "show", "exclude_combat"):
            verbs = {"destroy": "立即摧毁", "discard": "弃掉", "mark_destroy": "标记摧毁：本场战斗结算后再摧毁",
                     "show": "展示", "exclude_combat": "使其不参与本场战斗："}
            text = verbs[op] + "「" + target() + "」"
            if node.get("when") == "turn_end":
                text = "标记在本回合结束时摧毁「" + target() + "」"
            if node.get("as_owner"):
                text += "（按该牌自己的持有者处理，可涉及其他玩家）"
            return item(text)
        if op == "mod_card":
            change = node["amount"]
            value = f"{change:+d}" if isinstance(change, int) else self.expr(change, names)
            return item(f"「{target()}」本回合的{STATS[node['stat']]}修正 {value}")
        if op in ("mod_attack", "mod_magic_attack", "mod_light", "mod_gold", "mod_next_gold", "mod_next_hand"):
            label = {"mod_attack": "队伍普通攻击", "mod_magic_attack": "队伍魔法攻击", "mod_light": "队伍光照",
                     "mod_gold": "本回合临时金币", "mod_next_gold": "受影响玩家下回合临时金币", "mod_next_hand": "受影响玩家下次补充手牌数"}[op]
            value = node["amount"]
            return item(label + "修正 " + (f"{value:+d}" if isinstance(value, int) else amount()))
        if op in ("gain_xp", "spend_xp", "lose_xp", "gain_disease", "random_discard"):
            return item({"gain_xp": f"受影响玩家获得 {amount()} 点经验", "spend_xp": f"受影响玩家支付 {amount()} 点经验",
                         "lose_xp": f"受影响玩家失去 {amount()} 点经验（最低为 0）",
                         "gain_disease": f"受影响玩家逐张获得 {amount()} 张疾病，放入弃牌堆；每张均经过获得替代流程",
                         "random_discard": f"受影响玩家随机弃掉 {amount()} 张手牌"}[op])
        if op == "set_battle_flag":
            if node["flag"] == "cannot_defeat":
                text = "设置“无法击败”限制；若战斗结算时尚未解除，即使攻击足够也判负，并执行战败离场规则" if node["value"] else "解除本词条的无法击败限制；仍需攻击值达到生命值"
            elif node["flag"] == "lose_on_battle_loss":
                text = "本场战斗失败时淘汰当前玩家，其余玩家继续" if node["value"] else "取消本场战斗的失败淘汰规则"
            else:
                text = self.unknown("战斗标记", node["flag"])
            return item(text)
        if op == "move":
            destination = {"draw_top": "受影响玩家抽牌堆顶部", "discard": "受影响玩家弃牌堆", "hand": "受影响玩家手牌",
                           "draw_bottom": "受影响玩家抽牌堆底部"}.get(node["destination"], node["destination"])
            return item(f"把「{target()}」放到{destination}")
        if op in ("destroy_supply", "destroy_matching_supply"):
            kind = "同系列英雄供应堆" if node.get("family") else "对应供应堆"
            end = "底部" if node.get("from_bottom") else "顶部"
            return item(f"从「{target()}」{kind}{end}摧毁 {self.expr(node['count'], names)} 张；基础牌供应无限，不实际耗尽")
        if op == "destroy_purchased_supply":
            return item("从本次购买所来自的供应堆，再摧毁现有堆顶 1 张；基础牌供应不会耗尽")
        if op == "destroy_basic_supply":
            return item(f"请求摧毁基础供应中的 {self.expr(node['count'], names)} 张{self.card(node['card_id'])}；当前基础牌无限供应，只记录事件")
        if op == "random_destroy":
            return item("从受影响玩家手牌中随机展示 1 张；除非该牌满足「" + "；".join(self.filters(node["filter"], names)) + "」，否则摧毁它")
        if op == "set_retreat_position":
            return item(f"本场战败时，怪物回到地下城牌堆自顶向下第 {amount()} 张的位置")
        if op == "force_dungeon":
            return item("受影响玩家下个回合必须选择地下城行动")
        if op == "gain_card":
            return item("获得 1 张" + self.card(node["card_id"]) + "，放入受影响玩家弃牌堆")
        if op == "show_hand":
            return item("受影响玩家展示全部手牌")
        if op in ("clear_collection", "collect"):
            return item("清空本次汇总的英雄集合" if op == "clear_collection" else "把" + self.query(node["query"], names) + "加入本次汇总集合，供稍后比较")
        if op == "buy":
            budget = "使用当前存活手牌的完整金币单独进行一次购买" if "maximum_cost" not in node else "免费获得购买价不大于 " + self.expr(node["maximum_cost"], names) + " 的牌"
            return item(budget + "；限定为「" + "；".join(self.filters(node["filter"], names)) + "」；可放弃，获得的牌进入" + {"hand": "手牌", "discard": "弃牌堆"}[node["destination"]])
        if op == "shuffle_destroyed_traps":
            return item("将已摧毁陷阱与当前地下城牌堆顶部最多 10 张一起洗混，再放回牌堆顶部")
        return item(self.unknown("效果节点", op))

    def mechanic(self, mechanic):
        """Explain parameters actually consumed by the runtime mechanic hook."""
        p, op = mechanic.params, mechanic.op
        parts = []
        if op == "target_restriction":
            direct = {"immune_unarmed": "未装备武器的英雄不贡献攻击", "immune_spells": "持续免疫法术：法术牌不贡献攻击，也不能选取或直接影响此大厅怪物；法术的其他无关效果仍可结算",
                      "equipped_only": "未装备武器的英雄不贡献攻击", "magic_required": "队伍没有魔法攻击时，无法击败此怪物",
                      "half_magic": "队伍魔法攻击减半并向下取整", "half_attack_no_magic": "没有魔法攻击时，普通攻击减半并向下取整",
                      "half_attack_no_weapon": "队伍没有装备武器时，总攻击减半并向下取整",
                      "no_darkness": "仍有光照惩罚时，不能宣告攻击此怪物", "forbid_used_spell": "本回合已使用法术时，不能宣告攻击此怪物",
                      "forbid_equipment": "存在已装备武器时，不能宣告攻击此怪物",
                      "requires_used_spell_or_item": "本回合未使用法术或物品时，无法击败此怪物",
                      "half_no_element": "手牌中没有元素牌时，总攻击减半并向下取整"}
            for key, value in p.items():
                if key in direct:
                    if value:
                        parts.append(direct[key])
                elif key == "exclude_tags":
                    parts.append("以下英雄不贡献攻击：" + "／".join(value))
                elif key == "strength_min":
                    parts.append(f"当前力量低于 {value} 的英雄不贡献攻击")
                elif key == "immune_weapon_tag":
                    parts.append(f"「{value}」武器不贡献攻击")
                elif key == "min_heroes":
                    parts.append(f"队伍英雄少于 {value} 名时，无法击败此怪物")
                else:
                    parts.append(self.unknown("目标限制参数", key))
        elif op == "target_health":
            if "gold_below_double" in p:
                parts.append(f"当前手牌金币总值小于 {p['gold_below_double']} 时，此怪物生命值翻倍")
            elif "other_tag" in p:
                parts.append(f"当前手牌或大厅存在其他「{p['other_tag']}」牌时，此怪物生命值增加 {p.get('multiplier', 1)}")
            else:
                metric = p.get("metric", "count")
                if "hall_filter" in p:
                    base = "大厅中其他满足「" + "；".join(self.filters(p["hall_filter"])) + "」的牌数"
                elif metric == "xp":
                    base = "当前玩家的经验值"
                elif metric == "gold":
                    base = "当前手牌的金币总值"
                else:
                    base = "当前手牌中满足「" + ("；".join(self.filters(p.get("filter", {}))) or "任意牌") + "」的牌数"
                if p.get("flat"):
                    parts.append(f"{base}不少于 {p.get('minimum', 0)} 时，生命值增加 {p.get('multiplier', 1)}")
                else:
                    parts.append(f"此怪物生命值增加：{base} × {p.get('multiplier', 1)}")
                if p.get("amount"):
                    parts.append(f"生命值另外修正 {p['amount']:+d}")
        elif op == "hall_aura":
            for key, value in p.items():
                if key in STATS:
                    parts.append(("队伍" if key == "light" else "其他大厅怪物" if key == "health" else "队伍所有英雄") + STATS[key] + f" {value:+d}")
                elif key == "strength_per_spell":
                    parts.append("当前手牌每有 1 张法术，所有英雄力量 -1")
                elif key == "disease_attack":
                    parts.append(f"当前玩家每张疾病的普通攻击额外修正 {value:+d}")
                elif key == "double_darkness":
                    parts.append("普通阶层所需光照翻倍")
                elif key == "rank0_only":
                    parts.append("仅来源牌位于阶层 0 时生效")
                else:
                    parts.append(self.unknown("大厅参数", key))
        elif op == "light_requirement":
            if p.get("irreducible"):
                parts.append("正常阶层的光照缺口不因光照或无视惩罚效果而减少；每点仍扣 2 攻击")
            for rank, amount in p.get("ranks", {}).items():
                parts.append(f"攻击此怪物时，阶层 {rank} 的光照需求改为 {amount}；每缺 1 点扣 2 攻击")
        elif op == "immovable":
            parts.append("此怪物未被击败时不能移出大厅；战败也不会返回牌堆底部")
        elif op == "dungeon_deck_lock":
            parts.append("禁止发动以地下城牌堆为目标的能力")
        elif op == "hall_movement_lock":
            parts.append("大厅内所有怪物只有被击败才能移出；败战和移动效果都不能令其离场")
        elif op == "hall_target_restriction":
            parts.append(f"此牌在大厅时，禁止攻击其他具有「{p['protected_tag']}」标签的怪物")
        elif op == "battle_aura":
            if "light" in p:
                parts.append(f"仅对抗此怪物时，队伍光照 {p['light']:+d}；此文字不作为怪物手牌的光照数值")
            if "strength" in p:
                parts.append(f"仅对抗此怪物时，手牌中所有英雄力量 {p['strength']:+d}")
        elif op in ("hero_aura", "target_bonus"):
            if op == "hero_aura":
                parts.append("对队伍中满足「" + ("；".join(self.filters(p.get("filter", {}))) or "任意英雄") + "」的英雄生效")
            else:
                parts.append("攻击具有「" + p.get("tag", "任意") + "」标签的怪物时，此手牌贡献以下修正")
            for key in ("attack", "magic_attack", "strength", "light"):
                if key in p:
                    parts.append(f"{STATS[key]} {p[key]:+d}")
        elif op == "response":
            if p.get("action") == "ignore_trap":
                parts.append("持有者可以展示此手牌，忽略一张陷阱作用于自己那部分的效果" + ("；每回合限一次" if p.get("once_per_turn") else ""))
            else:
                parts.append(self.unknown("反应机制", p.get("action")))
        elif op == "replace_monster":
            parts.append("此标记进入大厅时，改用对应储备牌堆顶的下一张怪物；储备耗尽则移走标记并继续补厅")
        elif op == "scoring":
            parts.append(f"每张此牌的胜利点等于持有者所拥有「{p['group']}」怪物的张数（包括此牌）" + (f"，每张最高 {p['maximum']} 分" if "maximum" in p else ""))
        elif op == "economy":
            for key, value in p.items():
                if key == "scope":
                    parts.append("此规则仅在来源位于" + {"hall": "大厅", "hand": "手牌"}[value] + "时生效")
                elif key == "one_purchase":
                    parts.append("玩家本回合已购买 1 张牌后，不能继续购买，额外购买次数也不能绕过")
                else:
                    parts.append(self.unknown("商店机制", key))
        else:
            parts.append(self.unknown("机制", op))
        return [{"text": part, "children": []} for part in parts]
