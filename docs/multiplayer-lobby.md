# Multiplayer lobby

## 当前流程

网页登录入口是 `/play`，提供注册／登录、等待房间列表、创建与加入、玩家列表、规则配置和准备状态。全员准备后，房主可开始[正式对局](match-lifecycle.md)，在 `/match?id=...` 查看各自的开局牌桌并完成飞龙尖塔分配。原有本地配置和效果实验台继续用于开发；怪物审核页已拆除。

房间只保存玩家列表。列表按加入顺序显示，不设置座位、座位编号或换座接口。先手策略和对局的玩家顺序会在启动请求中明确提交给规则引擎。

从项目根目录准备依赖与构建，再分别在两个终端启动后端和前端：

```powershell
cd D:\project\thunderstone-web
npm ci
npm run build
.\backend\run_backend.bat
```

```powershell
.\frontend\run_frontend.bat
```

打开 `http://127.0.0.1:5173/play`；前端代理 API 和 WebSocket 到后端的 8765 端口。后端也可直接托管构建后的 `http://127.0.0.1:8765/play`。启动时自动应用数据库迁移，包括 `0004_persistent_matches`。房间配置编辑使用已导入 SQLite 的卡牌目录；新环境的安装和目录导入见 [backend README](../backend/README.md)。联机大厅和共享 API 使用 TypeScript，构建产物在被 Git 忽略的 `frontend/dist/`。

## 存储与权限

`rooms` 保存房间名称、房主用户 ID、`waiting/playing/closed` 状态、当前对局 ID、房间版本、配置版本及规则配置 JSON。`room_players` 保存成员用户 ID、加入时间和准备时对应的配置版本。成员记录的主键仅用于稳定地按加入先后读取列表，不作为游戏属性公开。

- 一个账号同时属于一个房间。退出登录或断线不自动离开，重新登录可从数据库恢复房间和当前对局。
- 大厅只列出公开的等待房间；创建时 `is_public` 默认为 `true`，取消勾选“公开房间”则创建私有房间。私有房间不列入大厅，持有分享编号的登录玩家仍可读取并加入；无需房间密码。账号重新登录仍可恢复自己所在的私有房间。
- 登录用户可查看可加入房间的玩家显示名、头像和规则配置；列表和房间响应均不包含邮箱、令牌或密码数据。首页右上角共用圆形头像和用户名入口，点击进入个人设置。
- 房主可保存配置、关闭房间；每名玩家只修改自己的准备状态。身份从访问令牌取得，请求不能指定另一名玩家。
- 加入、离开和实际修改配置会清除全员准备。准备记录绑定当前 `config_version`；保存完全相同的配置不清除准备。
- 房主离开后，身份交给列表中最早加入的剩余玩家。最后一人离开时关闭房间；房主主动关闭则移除全部成员。
- `playing` 期间锁定成员和配置，准备、加入、离开和关闭操作返回冲突；房主取消当前对局后，房间恢复等待状态并清空准备标记。

每个写入请求携带 `expected_version`，数据库通过条件更新原子地抢占当前版本，随后在同一事务提交成员／配置／准备状态。两个同版本请求最多接受一个；失败返回 `409 room_version_conflict`，不留下部分修改。重复加入已经属于的同一等待房间返回当前房间。正式开局、设置分配和取消另外使用 `command_id` 幂等记录，见对局接口说明。

## HTTP 接口

以下接口均要求 `Authorization: Bearer <access token>`。

| 方法与路径 | 请求 | 返回 |
| --- | --- | --- |
| `GET /api/v1/rooms` | 无 | 最多 50 个公开的等待房间摘要 |
| `GET /api/v1/rooms/current` | 无 | 当前房间或 `null` |
| `GET /api/v1/rooms/{id}` | 无 | 等待房间的玩家列表、配置和准备状态 |
| `POST /api/v1/rooms` | `{name, is_public?}` | 创建并加入的房间，201；`is_public` 必须为布尔值，默认为 `true` |
| `POST /api/v1/rooms/{id}/join` | `{expected_version}` | 加入后的房间 |
| `POST /api/v1/rooms/{id}/leave` | `{expected_version}` | 离开后的房间 |
| `POST /api/v1/rooms/{id}/ready` | `{expected_version, ready}` | 更新后的房间 |
| `PATCH /api/v1/rooms/{id}/config` | `{expected_version, config}` | 校验并保存后的房间 |
| `POST /api/v1/rooms/{id}/close` | `{expected_version}` | 已关闭的房间 |
| `POST /api/v1/rooms/{id}/start` | `{expected_version, command_id, first_player?}` | 创建的对局玩家视图 |

配置仍使用共享引擎的正式校验器。`/config?room={id}` 复用现有选卡面板，房主手动保存后才生效；页面草稿不覆盖本地实验用的规则草稿。保存前读取最新房间版本，允许准备状态／成员变更后的正常保存；如果配置版本已被另一页面修改，则保留当前草稿并提示重新载入。

## 实时同步与网页会话

事务提交后，经现有鉴权 WebSocket 向已连接用户广播公共失效通知：

```json
{"v":1,"type":"room_changed","payload":{"room_id":"...","version":3}}
```

公开房间通知只带房间 ID 和版本；私有房间使用空 `payload` 的同类失效通知，开局、取消和结算时也不会广播私有房间编号。网页重新读取经过鉴权的当前房间／公开列表 API；连接重建或页面重新可见时也会刷新，补回断线期间错过的通知。当前连接管理器在单个后端进程中工作，启动器默认一个进程；多个服务进程之间的通知总线需在部署阶段补齐。

迁移 `0007_room_visibility` 在后端下次启动时增加 `rooms.is_public`，原有房间均保持公开，不更改成员、配置、准备状态或对局数据。

访问令牌与刷新令牌保存在当前标签页的 `sessionStorage`。访问过期后，HTTP 客户端合并同时发生的刷新请求，成功后重试原始请求；刷新令牌失效则返回登录页。退出期间尚未完成的刷新不能恢复旧会话。

## 验证

```powershell
npm run typecheck
npm run build
npm test --workspace @thunderstone/frontend
.\.venv\Scripts\python.exe -B -X utf8 -m unittest backend.tests.modules.test_rooms backend.tests.api.test_backend_auth backend.tests.api.test_backend_api -q
```

测试覆盖真实 SQLite 迁移和认证、多人同时写入、过期版本、房主权限、准备失效、主机身份移交、进程重建后的数据恢复，以及提交后通知。网页测试覆盖登录续期、退出与刷新竞态、共享环境组数计算、实时协议，以及房间配置编辑的并发覆盖保护。测试通过进程内客户端执行，不启动监听服务。
