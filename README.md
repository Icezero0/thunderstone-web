# 雷霆之石网页版：卡牌资料整理

此仓库目前保存可重复运行的切图脚本和卡牌目录。后续游戏计划使用 Python 后端与 Vue 前端；当前阶段尚未建立联机服务。

## 本地输入

将原始资料放在项目根目录的 `game/` 和 `black_edges/`。这两个目录及 `generated/` 均不纳入 Git：

- `game/assets/deck_XX_列数x行数.png`：已汉化的 TTS 成品图集，每格为 504×704 像素。
- `game/TDS_CN.json`：TTS 存档，用于交叉核对卡牌 ID 和存档中的实例数量。
- `black_edges/deck_XX_列数x行数_rYY_cZZ.png`：500×700 的英文原图，提供位置命名和空位判断。
- `black_edges/.card_localizer_work/work_state.json`：中文文字框、坐标和样式。
- `black_edges/.card_localizer_state.json`：较旧的编辑状态，仅供溯源。

## 生成卡图与资料

需要 Python 3.11 或更新版本。以下命令从项目根目录运行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts\split_decks.py
.\.venv\Scripts\python.exe scripts\split_decks.py --verify
.\.venv\Scripts\python.exe scripts\build_card_data.py
```

切图结果保存在 `generated/cards/`，文件名与英文原图逐一对应，尺寸为 504×704。`--verify` 会逐张比较输出图片与成品图集中的对应像素。图片未纳入 Git，重新取得输入资料后可以再生成。

`build_card_data.py` 生成以下纳入 Git 的 UTF-8 CSV（带 BOM，方便 Windows 表格软件读取）：

| 文件 | 内容 |
| --- | --- |
| `data/cards.csv` | 每个图集位置一行；包含卡牌类型、二级分类、名称、腰部原文、效果、图片路径和 TTS 参照信息 |
| `data/text_boxes.csv` | 原始中文文字框及坐标、字体、颜色等样式，供重新提取和人工修正 |
| `data/review_queue.csv` | 需要人工核对的卡牌 |

`data/deck_catalog.csv` 定义牌组默认分类；`data/card_overrides.csv` 记录少量按图集位置识别的特殊卡；`data/card_text_overrides.csv` 用于保存后续人工校对的文字。分类提取依据见 [数据模型说明](docs/data-model.md)。

## 当前结果

20 张成品图集共切出 763 个位置：723 张卡牌正面、1 张回合顺序参考卡、21 张牌背、18 个空位。保留了 1,972 个中文文字框。32 个位置进入待核对清单，其中 27 张卡牌正面缺少嵌字记录，3 张已切出的卡牌未在当前 TTS 存档中实例化，另外 2 张宝藏牌有独立的辅助标签。

现阶段的 `effect_text` 是自动提取的卡面正文，部分卡牌可能包含风味文字。`extracted` 表示脚本成功提取，不表示经过人工校对。卡牌价值、胜利点、光照点等未嵌字的数字尚未建模。
