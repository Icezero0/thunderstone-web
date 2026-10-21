"""Environment effects that change classic setup targets."""

ENVIRONMENT_SETUP_RULES = {
    "TS-0191": {"count_delta": {"monster": 1},
                "note": "末日之门：额外增加 1 个怪物组。"},
    "TS-0192": {"count_delta": {"village": 2, "hero": -1},
                "note": "绝境庇护所：村庄组 +2，英雄组 -1。"},
    "TS-0198": {"count_override": {"monster": 4}, "thunderstone_target": 2,
                "scenario": "two_dungeons",
                "note": "飞龙尖塔：固定使用 4 个怪物组，分成两个地下城；每个牌堆底部 5 张内各放 1 张雷霆之石，取得两张后终局。地下城特征需在组局时分配牌堆。"},
    "TS-0199": {"thunderstone_target": 7, "scenario": "banishing_ritual",
                "note": "放逐仪式：额外 7 张雷霆之石洗入地下城牌堆，末日之心置底；启用对应取得雷石和终局规则。"},
}
