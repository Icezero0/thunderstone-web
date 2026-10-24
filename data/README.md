# 本地运行数据

本目录保存当前环境的持久数据。除本说明外，目录内容由 Git 忽略。

| 路径 | 用途 |
| --- | --- |
| `thunderstone.db` | 默认 SQLite 数据库，保存卡牌目录快照、用户账号、等待房间和玩家列表。 |
| `thunderstone.db-wal`、`-shm`、`-journal` | SQLite 按运行模式生成的临时日志文件。 |
| `jwt_secret` | 自动生成并复用的开发环境登录签名密钥；设置 `THUNDERSTONE_JWT_SECRET_KEY` 时使用环境变量。 |
| `avatars/` | 玩家上传并裁剪后的 512×512 PNG 头像。数据库账号表保存当前图片标识；换头像后移除旧文件。备份账号时也应备份此目录。 |
| `backups/` | 本地迁移备份和校验记录。2026-10-22 的目录迁移备份包含旧数据库、CSV、设置索引、签名密钥及文件校验清单。 |

数据库位置可通过 `THUNDERSTONE_DATABASE_URL` 修改；默认路径相对于项目根目录固定，不受启动命令所在目录影响。

正式卡牌内容位于 [cards/](../cards/README.md)。新环境先安装依赖，再运行以下命令创建数据库表并导入目录：

```powershell
.\.venv\Scripts\python.exe backend\scripts\catalog\import_cards_to_sqlite.py
```

之后修改 CSV 时，先重建 `cards/setup_catalog.json`，再用同一命令加 `--replace` 显式更新三张卡牌目录表；账号和房间表独立保留。
