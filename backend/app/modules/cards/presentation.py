"""Public card text and printed values, shared by catalog and match views."""

STAT_FIELDS = {
    "wiki_购买价格": "价格", "wiki_金币值": "金币值", "wiki_光照": "光照值",
    "wiki_重量": "重量", "wiki_英雄等级": "英雄等级", "wiki_力量": "力量",
    "wiki_生命值": "生命值", "wiki_胜利点": "胜利点",
    "upgrade_xp_cost": "升级经验", "defeat_xp_reward": "经验值奖励",
    "正文_基础攻击": "攻击", "正文_基础魔法攻击": "魔法攻击",
}


def public_card(card_id: str, card: dict) -> dict:
    return {
        "card_id": card_id, "name": card.get("name", card_id),
        "card_type": card.get("card_type", ""), "subcategory": card.get("subcategory", ""),
        "tags": [tag for tag in card.get("tags", "").split("|") if tag],
        "effects": card.get("effect_text", ""),
        "image_url": f"/cards/{card_id}.{'jpg' if card_id == 'TS-BACK-001' else 'png'}",
        "stats": {label: str(card[key]) for key, label in STAT_FIELDS.items()
                  if card.get(key) not in (None, "")},
    }
