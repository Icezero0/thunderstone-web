"""Hall capacity shared by setup and ordinary card movement."""

EXTRA_RANK_CARD_IDS = frozenset({'TS-0571', 'TS-0572', 'TS-0573', 'TS-0574', 'TS-0575'})


def base_hall_capacity(settings) -> int:
    return 4 if "TS-0188" in settings else 3


def hall_capacity(card_ids, settings) -> int:
    return base_hall_capacity(settings) + sum(card_id in EXTRA_RANK_CARD_IDS for card_id in card_ids)
