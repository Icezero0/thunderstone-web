# 卡牌资料模型

## 标识与类型

`cards.csv` 的一行对应一个图集格子，`card_id` 是稳定的格子标识，例如 `deck_04_4x2_r01_c01`。同一牌面在 TTS 存档中可能出现多次；它们仍只对应一条卡牌定义。游戏实现时应另建对局中的卡牌实例，实例引用 `card_id`，并拥有自己的区域、顺序和状态。

`slot_kind` 为 `front`、`reference`、`back` 或 `blank`。牌背和空位保留在目录中，方便核对图集位置，游戏卡牌列表应只选取 `front`。

`card_type` 是一级分类，例如随机生成卡、地下城卡、英雄卡、村庄卡、特殊卡。`subcategory` 是二级分类，例如怪物、环境、宝藏。`waist_text` 原样保存卡面腰部的具体标签，例如 `亡灵・幽影` 或 `战士・弓箭手`。牌组默认分类来自 `deck_catalog.csv`，混合牌组再依据腰部标签或 `card_overrides.csv` 修正。

`tts_card_id` 对应 TTS `CardID` 的牌组编号与零起始格子序号。`tts_copy_count` 是当前存档中的 `Card` 对象数量，只作为存档参照；不应直接当作游戏规则规定的牌库数量。

## 中文文字

`name` 来自卡面顶部，`waist_text` 来自中部较短的标签，`effect_text` 汇集其余正文。提取过程按文字框坐标排序，并保留原始框在 `text_boxes.csv`；该文件的 `role` 记录本次提取给每个框分配的用途。`other_text` 保存未能可靠归入前三类的文字。

`review_status=needs_review` 的行位于 `review_queue.csv`。`review_reasons` 使用 `|` 分隔，当前可能包括：

- `missing_localization_text`：中文嵌字状态没有文字框；可依据成品图补录。
- `not_in_tts_save`：成品图有该正面，但当前 TTS 存档中没有对应卡牌实例。
- `unassigned_text`：有独立辅助标签，未自动归入正文。
- `missing_name`、`missing_waist_text`：对应字段无法从文字框提取。

切图位置和文字框都可重新生成。人工校对文字时，在 `card_text_overrides.csv` 按 `card_id` 增加一行，只填写需要覆盖的字段；确认全部字段后将 `reviewed` 设为 `true`。脚本会将状态标为 `reviewed`。避免只修改生成的 `cards.csv`，以免下次重建时丢失。

## 后续存储

目前的 CSV 是卡牌定义的可审阅来源，不需要部署数据库。后续联机游戏可以将定义导入数据库，并分别存储对局、玩家、卡牌实例和操作记录。卡面上的价值、胜利点、光照点等数字字段将在识别或人工录入后增加，未知值应保持为空，不能填为零。
