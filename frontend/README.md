# Frontend

前端使用 TypeScript／JavaScript 与 Vite。根目录保留 HTML 入口、构建配置、启动脚本和说明；页面实现放在 `src/pages/`。

```text
frontend/
  index.html / auth.html / config.html / match.html / profile.html
  public/favicon.ico               首页圆框闪电标志的多尺寸网站图标，所有正式页面共用
  public/rulebooks/TS4_rules_CN.pdf  首页规则书入口使用的中文 PDF，随构建发布
  src/
    app/session.ts          浏览器会话与 API 客户端实例
    pages/
      auth/                 独立登录与注册表单
      lobby/                大厅、房间视图与页面样式
      match/                正式牌桌、回合操作、效果选择、战斗预览和结算
      profile/              个人设置与头像裁剪
      config/               房主的房间规则配置
    shared/
      components/game-card/        通用卡牌、程序翻面、E 原图检视
      components/player-avatar/   设置、房间和游戏玩家列表共用的圆形头像
      components/player-list/     独立玩家列表、回合标记、玩家牌区浏览与隐私展示
      components/public-table-area/ 公共视窗组件、独立桌面、Tab、复位与玩家列表
      components/table-areas/      地下城、大厅与村庄供应的底层展示
      components/table-viewport/   桌面视窗、双轴平移、边界及区域定位
      components/player-deck-area/  玩家牌组组件、布局、动画、样式和光标
      api/                  请求、认证刷新、网络契约类型
      realtime/             WebSocket 连接与重连
      styles/global.css     全局主题和基础组件
      styles/browse-dialog.css 卡牌浏览弹窗的共用外观与打开动画（由 global.css 加载）
      styles/switch.css      iCinema BaseSwitch 的原生开关样式（由 global.css 加载）
      styles/game-cursor.css 游戏区域共用光标状态
  tests/                    前端行为与构建配置测试
    fixtures/game-probe/    原 probe 的组件回归夹具，不对外提供页面
```

配置页 `index.js` 组合页面状态和事件；`model.js` 处理环境影响与导出参数，`selection.js` 渲染选牌，`room-editor.js` 校验登录及房主身份并保存房间配置。`/config?room={id}` 仅编辑房间，直接访问 `/config` 返回大厅；实际组局与飞龙尖塔分配在正式对局中完成。

`/login` 和 `/register` 共用独立的居中表单页面，不加载大厅和 WebSocket。登录成功后回到请求的正式页面，未指定则进入 `/play`。未登录访问大厅、对局、个人设置或房间配置会前往登录页；登录回跳仅允许已知应用路由。

公共模块不依赖具体页面。玩家牌组区域封装在 `shared/components/player-deck-area/`，公共视窗封装在 `shared/components/public-table-area/`，后者组合 `table-areas/` 的地下城、村庄供应、`table-viewport/` 的独立桌面以及 `player-list/` 的玩家列表。玩家列表与牌区弹窗也可独立挂载，接口见 [PlayerList](src/shared/components/player-list/README.md)。各区域共用 `game-card/` 的卡牌展示和光标样式，DOM 元素创建与身份保持工具放在 `shared/dom/`；演示数据和按钮仅作为 `tests/fixtures/game-probe/` 的回归夹具保留。怪物审核页已完成用途并移除，审核结论保留在 `cards/reviews/`。

首页顶部的“规则书”在新标签页打开 `/rulebooks/TS4_rules_CN.pdf`，无需登录。文件从初始资产 `game_TTS/TS4_rules_CN.pdf` 复制到 `public/rulebooks/`，由 Git 保存并由 Vite 直接提供，生产构建也会复制到 `dist/rulebooks/`。

## 卡图与规则书缓存

每个页面通过 `src/app/asset-cache.ts` 注册根路径的 `public/asset-cache-sw.js`，用 Cache Storage 保存实际加载过的卡图、统一牌背和规则书；不预下载完整卡库，不缓存网页、脚本、账号或对局接口。首次安装也会补存当前页面已经加载的图片。缓存属于当前浏览器的站点数据，关闭网页或浏览器后仍可复用。

卡图优先从本地读取，后台用 ETag／Last-Modified 校验；未修改返回 304，不重复传输文件内容。更新过的卡图写入缓存供下一次加载使用。每个资源在同一 worker 生命周期内最多每分钟后台校验一次，强制刷新会立即校验。规则书打开时先校验版本，完整 PDF 只下载一次，后续字节范围请求从缓存切片；并发加载同一文件会合并下载。缓存不可用或空间不足时仍可正常在线查看，离线时可读取已缓存的媒体，但这不代表支持离线对局。

Service Worker 需要 [HTTPS 或 localhost 等安全上下文](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register)；普通 HTTP 局域网地址使用浏览器 HTTP 缓存和 304 校验。无痕模式、清除站点数据或浏览器回收存储空间可能使缓存消失，届时按需重新下载；不主动弹出持久存储权限申请。缓存原理与存储限制见 [MDN Cache](https://developer.mozilla.org/en-US/docs/Web/API/Cache)。

Vite 开发服务直接提供 worker 和 PDF；后端提供卡图及校验响应。生产构建将 worker 和 PDF 原样复制到 `dist/`，后端 `api/resources.py` 提供对应入口。更新代码后需重启后端并刷新页面；部署到反向代理时，保持 `/asset-cache-sw.js` 位于站点根路径、可重新校验，并保留媒体的 ETag／Last-Modified 和 Range 响应。

## 正式对局

在 `/play` 创建或加入房间，全员准备后由房主选择随机或指定先手并开始。页面会进入 `/match?id=...`；飞龙尖塔需要房主先分配两组怪物到地下城 A，其余进入 B，并分配地下城特征。确认后显示大厅、供应、环境、疾病和自己的手牌，点击任意卡图查看详情。

手牌上方响应区显示当前阶段、选卡要求和确认／跳过选项。合法卡牌在原位置发光；单张选卡点击后立即提交，强制且只有唯一合法目标时自动选择。可选单张效果保留“跳过”，多选和排序仍需确认。自动提交等待正在播放的动画和上一请求完成，仅对有权响应的玩家执行；网络失败后停下来等待手动重试。牌堆内部和其他玩家的牌使用原有浏览窗口，升级目标使用原英雄供应及等级浏览。不创建额外候选卡牌区域。没有常驻位置的临时公开牌以响应区文字选项表示；同一张牌有多项可选能力时，先点原牌再在响应区选择词条。多选可再次点击取消，卡文明示的排序按点击顺序决定。被要求响应的玩家可以在他人的回合中完成自己的选择。金币和 XP 常驻显示；自己的回合读取权威金币，回合外金币显示 0。购买使用后端计算的实际价格，升级候选使用引擎核对过的 XP、英雄系列和库存。结束后显示结算，玩家可返回房间重新准备。

地下城准备直接使用手牌区表达队伍，不另占区域。英雄／法术／支援初始未选，点击切换本场贡献；疾病和怪物战利品强制选中，用紫色边缘区分且不能取消。点击武器后高亮能装备它的手牌英雄，选定后武器缩小、附着在英雄左下方，再点武器卸下；英雄无须先参战，撤回英雄参战也不卸下装备。只有英雄参战时才计入武器贡献。响应区的“使用效果”切换能力模式：开启后仅高亮仍有合法地下城能力的牌，点击列出能力；关闭后恢复直接点击参战。攻击、魔法攻击和光照以图标＋数字显示在响应区，逐次使用共享引擎计算。勾选／取消法术只更新本地草稿，不发请求，也不登记使用；仅 `ActivateAbility` 实际发动能力或 `SubmitBattleTeam` 提交时仍选中该法术，才登记“已使用”。`EquipWeapon`／`UnequipWeapon` 同步装备状态及相关事件；所有牌始终属于手牌。能力结算及同版本刷新保留仍合法的草稿，新增手牌不自动参战。同一草稿的数值与状态共享预览结果，普通参战切换不重新插入手牌 DOM。

房主可用“取消本局，返回房间”重新组局；普通“房间”导航只返回房间信息，不取消对局。进行中的房间不能准备、编辑配置或离开。

自动理牌开关通过 `PATCH /users/me` 保存 `auto_sort_hand` 账号偏好（默认关闭），正式对局和已登录的 probe 在加载时恢复。保存请求按顺序发送，失败恢复上次保存值并在响应区提示；它不属于游戏状态。匿名 probe 的开关只作用于当前页面。

维里斯系列的持续加成由共享引擎同时给出数值及武器增益状态。准备阶段本地勾选／取消参战、装备／卸下立即更新状态图标和 空格 状态栏，不发送预览请求。力量降为 0 使用普通战斗摧毁标记；判定胜负后、怪物离场前由事件时间线播放摧毁，保护替代为弃牌时在同一位置播放弃牌动画。

卡牌的 `statuses` 由共享引擎生成并经后端按可见性投影。右上角分别显示增益、减益和摧毁标记；同类只占一个图标，悬停或键盘聚焦显示来源与数值。牌背和未公开手牌不泄漏状态。地下城动画按事件顺序处理英雄摧毁、怪物归属、大厅补位和宝藏展示；播放提交结果时会切回手牌，获得宝藏后再切到宝藏 tab。

对局页面先恢复登录，再请求参与者专属 `MatchView`；只展示服务器投影的公开牌桌与自己的手牌。`/match` 无编号时恢复当前对局，登录失效则通过安全的 `next` 参数回到登录页。WebSocket 的 `room_changed` / `match_changed` 通知与重新连接都会重新获取权威视图，不在浏览器保存游戏状态。

正式牌桌直接组合已验证的 `PublicTableArea`（含独立 PlayerList）和 `PlayerDeckArea`，保留桌面平移缩放、牌堆与英雄浏览、手牌拖动排序、E检视和卡牌动画。`pages/match/table-state.ts` 适配 `MatchView`，`table.ts` 管理组件；演示按钮和假数据仅留在测试夹具中。`board-picker.ts` 负责临时选卡，`effect-interaction.ts` 将合法效果响应映射为牌桌选择，`battle-editor.ts` 管理本地队伍及预览。旧“行动与战斗”入口保持隐藏，旧选卡弹窗控制器已移除。玩家抽牌堆浏览的是无序清单，对手未公开手牌只收到牌背所需信息。完整数据边界见[正式对局说明](../docs/match-lifecycle.md)。

轮到自己时，手牌上方响应区左侧显示小旗帜，右侧显示行动及当前编号阶段；回合开始的“访问村庄／进入地下城／休整”按钮分别使用铜金、淡紫、浅蓝。休整第一阶段显示“摧毁手牌／跳过”。点击“摧毁手牌”后，后端 `RestDestroy.instance_ids` 指定的合法手牌发光，再点该按钮可取消选牌；点击一张牌提交摧毁，该牌移至视窗中央、放大并消散。摧毁或跳过都进入第二阶段，仅显示红色“结束回合”。村庄完成升级、地下城完成战斗也停在 `ACTION_END`，三种行动统一提交 `FinishTurn` 后才弃牌、补牌并交接。`rest-interaction.ts` 只管理本地选牌状态；行动及阶段来自权威视图，刷新重连可恢复；新权威版本到达时退出选牌，请求失败且版本未改变时恢复提示以便重试。

村庄效果阶段仅保留“跳过”，可发动效果的手牌立即发光；点击卡牌弹出其合法能力列表。购买阶段为“购买卡牌／跳过”，进入购买选择后切到村庄，按效果结算后的价格高亮合法顶牌，卡面不叠加价格；购买牌从对应供应堆顶正面飞入自己的弃牌堆。商人等效果获取供应牌也使用相同飞牌动画，包括无限基础供应；商人摧毁牌后必须选择合法非英雄牌，不提供跳过。购买及其触发效果完成后，仍有合法购买才保留此阶段，否则引擎自动进入升级。升级阶段为“升级英雄／跳过”，只高亮合法手牌；单一目标直接升级，多个目标在原英雄供应中点击选择，支持 E 检视。升级成功后，原英雄移至中央，播放光环和聚能粒子，在亮光中显现升级后的卡面，再飞入弃牌堆；新旧卡图均先完成解码，实例身份保持独立。没有合法升级时自动进入 `ACTION_END`，仍需手动结束回合。

地下城准备响应区提供“使用效果／完成”，完成时只提交本地队伍和装备，并结清强制疾病效果。第三阶段“宣言战斗”才高亮大厅目标，点击怪物后开始战斗；“调整队伍”可以返回准备。`card-actions.ts` 管理卡牌菜单，`interaction-panel.ts` 仅用于列出这张牌的可选动作和能力；所有牌目标改在牌桌上选择，数值／玩家等非卡牌选择直接显示在响应区。

`MatchView.card_motion` 提供观看者自己的已提交牌区移动，由后端 `animation_view.py` 从引擎事件投影；不暴露其他玩家的抽牌实例或洗牌顺序。`effect-motion.ts` 将其转为展示步骤，`event-timeline.ts` 与公开事件按序合并播放。酋长战鼓等翻开后弃牌、按结果继续抽牌，以及弃牌堆回收、放回抽牌堆、旁置和取回，都保留中间移动；抽牌不足时先抽完剩余牌、洗回弃牌堆、继续补抽。`deck-transitions.ts` 保留为旧事件记录的兼容回退，已播放的移动不会再次推断。整个队列期间禁用手牌操作与响应按钮，同版本刷新不重播；新版本、失焦、隐藏或卸载时跳到正确最终状态。缺少可重建信息时直接展示最新快照。尚需确定的多玩家揭牌、附着与长链表现见[效果动画审核](../docs/effect-animation-review.md)。

`event-timeline.ts` 是正式页公开事件的动画编排入口。引擎先提交权威结果和有序事件，前端逐条等待对应动画完成。延后摧毁顺序为判定胜负→凯旋→摧毁标记实际结算及动画→怪物离场→补位；回放期间响应区保留地下城第 4 阶段。摧毁只由 `card_destroyed` 事件触发，不预读未来受害者，也不在库存差异兜底中重复播放；英雄升级的旧牌移除交给进化动画。宝藏展示、收入、怪物移动及翻牌仍复用相同飞牌能力。陷阱进入大厅原位高亮，玩家点击提交 `ResolveTrap` 后才执行效果，响应结束前一直留在大厅。`trap_removed` 到达时在原位褪色、下沉淡出，再继续补位；对应的底层销毁事件不重复播放动画。重连直接恢复大厅快照，不再使用中央展示或 `pending_trap`。动画期间锁定公共区域及玩家操作；中断收束到最终快照，同版本刷新不重播。物理飞牌能力位于 `shared/components/game-card/card-motion.ts`，动画模块不读取隐藏牌堆顺序。

效果点选不改变牌桌布局，也不强制切换公共桌面；目标在另一个桌面时，该 Tab 高亮提示，进入后原牌继续发光。宝藏、旁置及牌堆浏览中的选择使用相同规则。装备缩略牌固定在英雄左下角，右上角留给状态图标。有状态的正面卡牌在 E 检视时显示右侧状态栏，高度取原卡图像素高度；栏内滚动条隐藏，E 检视期间滚轮优先滚动过长的状态内容。无状态和牌背继续只显示卡图。

当前玩家从回合开始起整手牌公开，包含回合内新获得的手牌；回合结束补牌后至下次自己的回合开始前隐藏，效果单独展示的牌除外。浏览窗口完全使用服务器的逐牌 `revealed`，不在客户端猜测。展示手牌阶段及原编号保留、自动完成；休整第一阶段去掉常驻提示，选择摧毁时仍提示选牌。其他玩家的列表条目旁向左展开临时气泡，展示手牌、摧毁卡牌及后续阶段消息默认 4.5 秒消失，新消息替换旧消息；同版本刷新不重播。probe 的外部演示面板提供“演示展示手牌气泡／演示摧毁气泡”。

在任意工作目录执行本目录的 `run_frontend.bat`，或运行 `bash frontend/run_frontend.sh`，默认访问 `http://127.0.0.1:5173/`。依赖在仓库根目录通过 `npm ci` 安装，启动器会先构建共享引擎。后端另用 `backend/run_backend.bat` 启动。

`vite.config.mjs` 将 API、WebSocket、卡图代理到 `http://127.0.0.1:8765`；调整后端地址时，可复制 `.env.example` 为 `.env.local` 并修改 `VITE_API_ORIGIN`。正式页面地址及房间查询参数在开发与构建后保持一致。测试目录、测试构建、game-probe、effect-lab 等旧地址在 Vite 和预览服务中均被拦截；后端只提供正式页面白名单。

从仓库根目录执行 `npm run build:frontend` 生成 `frontend/dist/`；后端可直接托管该产物，保持原有 8765 审核地址。前端测试用 `npm test --workspace @thunderstone/frontend`，类型检查用 `npm run typecheck --workspace @thunderstone/frontend`。

## 个人设置

登录后点击大厅或对局页右上角的玩家名称进入 `/profile`，也可直接访问该地址；未登录时返回登录页，登录成功后回到设置。页面沿用全局主题，保存名称、新密码和头像，邮箱只读且不会提交。修改密码后清除当前会话并返回登录页，旧访问与刷新凭据同时失效。离开时若有未保存的更改会提示确认。

交互参考 [iCinema 的个人设置页](https://github.com/Icezero0/iCinema/blob/main/frontend/src/pages/profile/ProfileEditPage.vue)。选择头像后通过原生 Canvas 拖动、以鼠标位置为中心滚轮缩放、左右旋转及复位，裁剪为 512×512 PNG，再统一保存；聚焦预览后也可按加减键缩放、`0` 复位。裁剪窗口复用全局浏览弹窗样式与动画，无新增前端依赖。头像支持 PNG、JPEG、WebP，最大 5 MB、1600 万像素。图片预览和临时 URL 随撤销、保存、取消及卸载释放。

头像先上传到 `PATCH /api/v1/users/me/avatar`，资料再提交 `PATCH /api/v1/users/me`；部分保存失败时明确显示已完成的部分，保留未保存的表单。账号、房间与对局响应的 `avatar_url` 可直接交给 `PlayerAvatar.setSource()`，或映射为公共视窗玩家的 `avatarUrl`。`profile_changed` 实时通知触发正式房间／对局的玩家数据重载。`game-probe` 的己方名称和头像读取登录账号，牌组与其他玩家继续使用本地演示快照。

## 开发页面的处理

开发页面清理后，`game-probe` 只在测试目录中充当 DOM 夹具，效果实验台页面已删除。它们都不进入 `dist/`。需要回归时运行 `npm test --workspace @thunderstone/frontend`，无需启动监听服务。实际视觉效果由用户在正式对局中核对。

## 全局样式

所有页面以规则配置页为视觉基准，使用 [global.css](src/shared/styles/global.css) 的全局样式。它定义暖纸色页面、米白面板、深蓝灰渐变页头、铜金色主按钮，以及正文无衬线字体和标题衬线字体。

## 加载与职责

每个 HTML 先加载全局样式，再加载页面自己的布局样式：

```html
<link rel="stylesheet" href="/src/shared/styles/global.css">
<link rel="stylesheet" href="/src/pages/example/style.css">
```

共享颜色、字体、圆角、阴影和基础控件放在 `src/shared/styles/global.css`；可复用功能组件在自身目录维护有作用域的样式，并通过入口模块加载，继续复用全局主题。页面 CSS 负责该页的排列、密度和响应式布局。功能状态使用全局语义色。

| 用途 | 变量 |
| --- | --- |
| 页面／面板背景 | `--paper`、`--panel`、`--surface-subtle` |
| 正文／辅助文字 | `--ink`、`--muted` |
| 边框 | `--line`、`--panel-border`、`--control-border` |
| 铜金色强调与操作 | `--gold`、`--gold-soft`、`--primary`、`--primary-hover` |
| 成功／错误／信息 | `--green`、`--red`、`--info` 及对应背景色 |
| 页头 | `--header-background`、`--header-ink`、`--header-muted` |
| 字体 | `--font-body`、`--font-heading`、`--font-code` |
| 面板／控件圆角、阴影 | `--radius-panel`、`--radius-control`、`--shadow` |

## 共用组件

```html
<header class="masthead">
  <div class="masthead-inner">
    <a class="brand" href="/play">
      <span class="brand-mark" aria-hidden="true">ϟ</span>
      <span><strong>雷霆之石</strong><small>THUNDERSTONE</small></span>
    </a>
  </div>
  <div class="hero-copy">
    <p class="eyebrow">页面上下文</p>
    <h1>页面标题</h1>
    <p>这一页的简短说明。</p>
  </div>
</header>
<main>
  <section class="panel">
    <h2>区域标题</h2>
    <button class="button primary" type="button">主要操作</button>
    <button class="button secondary" type="button">次要操作</button>
  </section>
</main>
```

`main` 的宽度、网格、区域间距由页面布局定义。表单控件、键盘焦点、隐藏状态和基础按钮外观由全局样式提供；工具页的步骤、卡牌和执行轨迹保留各自结构。

## 开关

公开房间选择使用 [switch.css](src/shared/styles/switch.css)，直接移植 [iCinema 的 BaseSwitch](https://github.com/Icezero0/iCinema/blob/main/frontend/src/ui/base/BaseSwitch.vue) 的结构、42×24 轨道、16px 滑块、淡色选中层次与过渡，只映射到本项目的主题变量。原生 checkbox 保留键盘、标签点击及禁用行为，无 JavaScript 依赖。页面仅负责布局。

```html
<label class="ui-switch">
  <span class="ui-switch-control">
    <input class="ui-switch-input" type="checkbox" role="switch">
    <span class="ui-switch-visual" aria-hidden="true"></span>
  </span>
  <span class="ui-switch-label">公开房间</span>
</label>
```

## 浏览弹窗

玩家牌区、抽牌堆／弃牌堆和英雄等级预览共用 [browse-dialog.css](src/shared/styles/browse-dialog.css)，由全局样式自动加载。统一使用深色标题栏、米白内容区、圆角和遮罩；打开时遮罩淡入，窗口淡入并上移 14px，默认耗时 180ms。关闭直接隐藏，系统启用“减少动态效果”时不播放动画。动画结束后不保留变换，避免卡图持续处于变换图层中。

```html
<section class="browse-dialog" role="dialog" aria-modal="true" aria-labelledby="example-dialog-title" hidden>
  <div class="browse-dialog-panel panel">
    <header class="browse-dialog-heading masthead">
      <div class="browse-dialog-heading-group"><h2 id="example-dialog-title">牌堆浏览</h2></div>
      <button class="browse-dialog-close button secondary" type="button">关闭 ×</button>
    </header>
    <div class="browse-dialog-body browse-dialog-grid"><!-- 每张卡牌放在一个 article 中 --></div>
  </div>
</section>
```

控制器通过 `hidden` 切换开关；仅打开时播放动画，窗口内更新卡牌或切换 Tab 不重播。`.browse-dialog-body` 提供可滚动内容区；卡牌清单可叠加 `.browse-dialog-grid`，英雄等级对照保留自己的网格布局。弹窗上可设 `--dialog-width` 调整宽度，`--dialog-open-duration` 调整动画时长。焦点循环、Esc、遮罩关闭、背景 `inert` 及快照同步仍由各组件控制。

## 疾病响应与陷阱顺序

疾病获得会在中央凝聚生成卡面，若有替代响应则停留；玩家列表高亮合法接收者，点击玩家直接提交，不打开浏览窗口。响应区可跳过转交并自行获得，疫病破除者仍自动摧毁。最终卡牌从中央飞入接收者弃牌堆，明确指定手牌／抽牌堆的效果仍遵从实际目标。

公开的 pending_disease 和 gain_id 用于重连恢复及串接响应，不公开疾病实例 ID、抽样或解释器内部状态。生成不随同版本刷新或后续响应重播，取消对局会清除中央卡面。连续陷阱逐张处理；同一陷阱的词条按编号顺序执行，摧毁刚获得的怪物时先播放收入，再从弃牌堆飞至中央消散。详见[疾病与陷阱结算](../docs/game-engine/disease-and-trap-resolution.md)。
