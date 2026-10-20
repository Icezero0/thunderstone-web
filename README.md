# 雷霆之石网页版：卡牌资产

本阶段的正式产物是 [data/cards.csv](data/cards.csv) 和 [assets/cards/](assets/cards/) 中按 `card_id` 命名的卡图。`cards.csv` 是卡牌定义的唯一数据源；分类、中文文字、数值、审核状态、排序和新旧编号都已写入其中。后续游戏后端可直接读取或导入这份 CSV。

## 资产

- `data/cards.csv`：722 条记录，其中 720 张可玩卡正面、1 张回合顺序参考卡、1 张公共牌背。`card_id` 是正式编号，`source_card_id` 保存原图集牌位名，`catalog_order` 保存当前目录顺序。
- `assets/cards/`：720 张 `TS-0001.png` 至 `TS-0720.png`，以及 `TS-REFERENCE-001.png`、`TS-BACK-001.jpg`。每条记录的 `image_path` 指向相同编号的图片。
- `archive/`：早期文字框、英雄系列核对结果和 Wiki 研究资料，仅供溯源，不参与当前目录编辑。

初期输入 `game/` 与 `black_edges/` 保留在本地，仍被 Git 忽略。人工修订的卡图已并入正式图片 `TS-0147.png`、`TS-0187.png`、`TS-0679.png`。当前不再使用图集切割、数据重建或覆盖表。

历史编号映射、牌组分类和 Wiki 候选值均已并入 `cards.csv`；旧构建输入与命令已清理。

## 使用数据

`cards.csv` 使用带 BOM 的 UTF-8 编码，空白数值表示未知或不适用，不等于 0。卡牌图片的路径由 `image_path` 字段给出。当前阶段仅保留资产和只读数据检查，不附带审核页面或本地服务。

分类、标签、英雄系列、经验值字段与审核状态见 [数据模型](docs/data-model.md)。

## 游戏引擎设计

Python 规则引擎的设计见[总览](docs/game-engine-design.md)和[详细文档目录](docs/game-engine/README.md)。详细文档依次说明卡牌目录与规则包、状态、组局、回合、战斗、能力结算、联机和验证。
