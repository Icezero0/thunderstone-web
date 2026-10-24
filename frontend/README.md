# Frontend

前端使用 TypeScript／JavaScript 与 Vite。根目录保留 HTML 入口、构建配置、启动脚本和说明；页面实现放在 `src/pages/`。

```text
frontend/
  index.html / config.html / match.html / profile.html / game-probe.html / effect-lab.html
  src/
    app/session.ts          浏览器会话与 API 客户端实例
    pages/
      lobby/                登录、大厅、房间视图与页面样式
      match/                正式牌桌、回合操作、效果选择、战斗预览和结算
      profile/              个人设置与头像裁剪
      game-probe/           游戏区域试验：地下城、村庄供应、玩家牌组
      config/               规则配置与本地组局预览
      effect-lab/           效果执行轨迹与页面样式
    shared/
      components/game-card/        通用卡牌、程序翻面、Alt 原图检视
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
```

配置页 `index.js` 组合页面状态和事件；`model.js` 处理环境影响与导出参数，`draft-storage.js` 恢复浏览器草稿，`selection.js` 渲染选牌，`room-editor.js` 保存房间配置，`setup-preview.js` 处理生成及飞龙尖塔选择，`setup-results.js` 展示结果。子模块通过参数接收页面状态和回调，不反向导入入口。

公共模块不依赖具体页面。玩家牌组区域封装在 `shared/components/player-deck-area/`，公共视窗封装在 `shared/components/public-table-area/`，后者组合 `table-areas/` 的地下城、村庄供应、`table-viewport/` 的独立桌面以及 `player-list/` 的玩家列表。玩家列表与牌区弹窗也可独立挂载，接口见 [PlayerList](src/shared/components/player-list/README.md)。各区域共用 `game-card/` 的卡牌展示和光标样式，DOM 元素创建与身份保持工具放在 `shared/dom/`；演示数据和按钮留在 `pages/game-probe/`。怪物审核页已完成用途并移除，审核结论保留在 `cards/reviews/`。

## 正式对局

在 `/play` 创建或加入房间，全员准备后由房主选择随机或指定先手并开始。页面会进入 `/match?id=...`；飞龙尖塔需要房主先分配两组怪物到地下城 A，其余进入 B，并分配地下城特征。确认后显示大厅、供应、环境、疾病和自己的手牌，点击任意卡图查看详情。

操作区显示当前玩家可执行的村庄、地下城和休息操作，以及卡牌效果的选择窗口。被要求响应的玩家可以在他人的回合中完成自己的选择。购买选项显示后端计算的实际价格；英雄升级显示所需经验。结束后显示结算，玩家可返回房间重新准备。

地下城准备区通过 `@thunderstone/engine` 的 `updateBattleDraft` 和 `previewBattleTeam` 逐次计算参战、支援、装备及目标调整。预览不发送请求，也不执行效果；确认队伍才提交正式命令。选中的英雄和武器仍属于手牌，后端重新校验并结算。

房主可用“取消本局，返回房间”重新组局；普通“房间”导航只返回房间信息，不取消对局。进行中的房间不能准备、编辑配置或离开。

对局页面先恢复登录，再请求参与者专属 `MatchView`；只展示服务器投影的公开牌桌与自己的手牌。`/match` 无编号时恢复当前对局，登录失效则通过安全的 `next` 参数回到登录页。WebSocket 的 `room_changed` / `match_changed` 通知与重新连接都会重新获取权威视图，不在浏览器保存游戏状态。

正式牌桌直接组合 probe 已验证的 `PublicTableArea`（含独立 PlayerList）和 `PlayerDeckArea`，保留桌面平移缩放、牌堆与英雄浏览、手牌拖动排序、Alt 检视和卡牌动画。`pages/match/table-state.ts` 适配 `MatchView`，`table.ts` 管理组件；演示按钮和假数据仅保留在 `/game-probe`。手牌响应栏提供行动／阶段结束选项。“行动与战斗”侧栏及其打开入口暂时隐藏，内部命令与本地预览逻辑保留，效果交互随审核逐步接入。准备战斗时点击英雄／支援牌切换参战，点击大厅怪物选择目标，预览使用共享引擎，不发送网络请求。玩家抽牌堆浏览的是无序清单，对手未公开手牌只收到牌背所需信息。完整数据边界见[正式对局说明](../docs/match-lifecycle.md)。

轮到自己时，手牌上方响应区左侧显示小旗帜，右侧显示行动及当前编号阶段；回合开始的“访问村庄／进入地下城／休整”按钮分别使用铜金、淡紫、浅蓝。休整第一阶段显示“摧毁手牌／跳过”。点击“摧毁手牌”后，后端 `RestDestroy.instance_ids` 指定的合法手牌发光，再点该按钮可取消选牌；点击一张牌提交摧毁，该牌移至视窗中央、放大并消散。摧毁或跳过都进入第二阶段，仅显示红色“结束回合”。村庄完成升级、地下城完成战斗也停在 `ACTION_END`，三种行动统一提交 `FinishTurn` 后才弃牌、补牌并交接。`rest-interaction.ts` 只管理本地选牌状态；行动及阶段来自权威视图，刷新重连可恢复；新权威版本到达时退出选牌，请求失败且版本未改变时恢复提示以便重试。

`deck-transitions.ts` 将权威快照及新的公开事件适配为展示步骤：先弃掉全部手牌，再从剩余抽牌堆抽取；不足时播放弃牌堆洗回，再补抽剩余张数。实际抽牌名单和数量完全来自引擎结果，支持手牌增减效果与全牌组不足六张。通用公开 `card_destroyed` 事件可为已知手牌触发摧毁动画，休整旧记录仍支持 `rest_card_destroyed`。整个动画队列期间禁用手牌操作与响应按钮，同版本刷新不重播；新版本、失焦、隐藏或卸载时跳到正确最终状态。缺少可重建信息时直接展示最新快照。

当前玩家从回合开始起整手牌公开，包含回合内新获得的手牌；回合结束补牌后至下次自己的回合开始前隐藏，效果单独展示的牌除外。浏览窗口完全使用服务器的逐牌 `revealed`，不在客户端猜测。展示手牌阶段及原编号保留、自动完成；休整第一阶段去掉常驻提示，选择摧毁时仍提示选牌。其他玩家的列表条目旁向左展开临时气泡，展示手牌、摧毁卡牌及后续阶段消息默认 4.5 秒消失，新消息替换旧消息；同版本刷新不重播。probe 的外部演示面板提供“演示展示手牌气泡／演示摧毁气泡”。

在任意工作目录执行本目录的 `run_frontend.bat`，或运行 `bash frontend/run_frontend.sh`，默认访问 `http://127.0.0.1:5173/`。依赖在仓库根目录通过 `npm ci` 安装，启动器会先构建共享引擎。后端另用 `backend/run_backend.bat` 启动。

`vite.config.mjs` 将 API、WebSocket、卡图和工具数据代理到 `http://127.0.0.1:8765`；调整后端地址时，可复制 `.env.example` 为 `.env.local` 并修改 `VITE_API_ORIGIN`。页面地址 `/config`、`/effect-lab` 和房间查询参数在开发与构建后保持一致。

从仓库根目录执行 `npm run build:frontend` 生成 `frontend/dist/`；后端可直接托管该产物，保持原有 8765 审核地址。前端测试用 `npm test --workspace @thunderstone/frontend`，类型检查用 `npm run typecheck --workspace @thunderstone/frontend`。

## 个人设置

登录后点击大厅或对局页右上角的玩家名称进入 `/profile`，也可直接访问该地址；未登录时返回登录页，登录成功后回到设置。页面沿用全局主题，保存名称、新密码和头像，邮箱只读且不会提交。修改密码后清除当前会话并返回登录页，旧访问与刷新凭据同时失效。离开时若有未保存的更改会提示确认。

交互参考 [iCinema 的个人设置页](https://github.com/Icezero0/iCinema/blob/main/frontend/src/pages/profile/ProfileEditPage.vue)。选择头像后通过原生 Canvas 拖动、以鼠标位置为中心滚轮缩放、左右旋转及复位，裁剪为 512×512 PNG，再统一保存；聚焦预览后也可按加减键缩放、`0` 复位。裁剪窗口复用全局浏览弹窗样式与动画，无新增前端依赖。头像支持 PNG、JPEG、WebP，最大 5 MB、1600 万像素。图片预览和临时 URL 随撤销、保存、取消及卸载释放。

头像先上传到 `PATCH /api/v1/users/me/avatar`，资料再提交 `PATCH /api/v1/users/me`；部分保存失败时明确显示已完成的部分，保留未保存的表单。账号、房间与对局响应的 `avatar_url` 可直接交给 `PlayerAvatar.setSource()`，或映射为公共视窗玩家的 `avatarUrl`。`profile_changed` 实时通知触发正式房间／对局的玩家数据重载。`game-probe` 的己方名称和头像读取登录账号，牌组与其他玩家继续使用本地演示快照。

## 卡牌交互试验

打开 `/game-probe`，无需登录。上方的“公共视窗”通过“地下城／村庄”Tab 切换两个独立桌面，各自保存平移位置，隐藏时保留库存和已加载卡图。左键拖动空白处可上下左右平移，中键可从卡牌上拖动，超出视窗的内容也能完整查看。Tab 支持左右方向键、Home／End。视窗右侧是竖排的本地示例玩家列表；底部固定为左侧抽牌堆、中间手牌、右侧弃牌堆。

玩家列表显示圆形头像与名称，当前回合玩家突出标记，不显示编号。自己的列表条目点击无操作，直接使用底部玩家牌组区域；点击其他玩家可按 Tab 浏览其手牌、抽牌堆和弃牌堆，两种牌堆的清单均按卡牌 ID 排序。对手手牌仅每实例 `revealed` 为真的牌显示正面，其余及其 Alt 检视均为牌背；未公开牌不加载正面图。己方牌区跟随底部演示牌组更新，对手提供部分公开的本地示例。外部“测试手牌公开同步（2 秒）”可在窗口打开时演示牌背更新为公开卡面。公开状态由传入的快照控制，完整契约见 [PublicTableArea](src/shared/components/public-table-area/README.md)。

有登录会话时，“你”的名称和头像使用 `/api/v1/users/me` 中的当前账号资料；未设置头像显示默认人物轮廓，不显示邮箱。`pages/game-probe/profile-binding.ts` 在初始化、重新聚焦、页面重新可见及缓存恢复时刷新资料，把普通快照交给展示组件。更新资料不会重置示例牌组或关闭正在查看的其他玩家窗口；未登录或登录过期时使用原有示例身份，暂时离线保留当前显示，probe 仍可操作。退出页面后忽略迟到响应并清理监听。

手牌数量、抽弃牌、宝藏／旁置演示、场景选择、额外阶层、供应取牌和重置等控件集中在牌桌外的“演示与测试”折叠面板中，默认收起。牌桌内仅保留实际游戏交互和区域定位。当前使用本地示例牌，仅加载卡图，不请求卡牌详情或提交游戏命令。

- 公共区只显示地下城／村庄 Tab，不再重复写视窗或各地城分区标题。场景选择可切换普通地下城、荆棘森林环境／飞龙尖塔双地下城。有环境牌时，在地下城左侧的独立面板中正面展示，上方写“环境”，支持 Alt；无环境时整个面板和槽位隐藏。飞龙尖塔的两组地下城上下排列，共用左侧环境面板。每组背面牌堆上方写“地下城”，其右侧是正面大厅，从左向右按阶层降序排列，越靠近牌堆阶层越高。默认阶层 1、2、3，开关可增加阶层 0／4。当前不预留虫群、兽潮的显示位置。
- 村庄从上到下是英雄、村庄、基础供应，均为正面牌堆，每行最多四堆，多出的自动换行。牌堆上方左侧显示供应名称，右侧显示数量，不显示分类标题或顶牌等级。点击英雄供应查看各等级卡面与数量，包括方阵的二级系列及克雷尔的四级系列；Alt 检视原图。英雄按等级从低到高暴露顶牌，预览高等级不会改变取牌对象。
- 外部测试面板的供应下拉框与“演示取顶牌”把一张新示例牌放入玩家弃牌堆，有限库存减一，当前等级用尽时暴露下一等级。基础牌显示 `∞`，按 16 张模拟纸张厚度，取牌后不减少数量或厚度。“重置供应”恢复示例库存。这些操作只测试展示，不执行购买费用或升级规则。

公共区挂载、完整快照、切换、复位及卸载接口见 [PublicTableArea 说明](src/shared/components/public-table-area/README.md)，底层卡牌数据见 [table-areas 说明](src/shared/components/table-areas/README.md)。

视窗初始缩放为 150%，支持平移及 80%～250% 滚轮缩放，鼠标所在位置作为缩放中心；100% 时只按整数像素平移，没有嵌套滚动区。桌面在能完整放下的方向默认居中，四周另留最多 240 像素平移余量，即使内容全部可见也能调整位置。切换 Tab 分别保留位置及缩放，尺寸变化保留用户相对默认视野的偏移，边界保证仍有部分桌面可见。视窗右下角的图标按钮固定在内容上方，采用 Lucide `focus`（四角取景框与中心圆），恢复当前 Tab 的默认位置和 150% 缩放；仅保留悬停提示和无障碍标签，授权见 `public/licenses/lucide.txt`，无需安装图标库。聚焦视窗后按 Home 同样可复位。地下城和村庄的空白处、牌堆与卡牌都可按住左键拖动视窗，达到 5 像素阈值才开始平移；英雄供应单击打开预览，大厅卡牌单击选择目标，拖拽结束不触发这些点击。平移期间暂停公共卡牌悬停／检视，缩放时清理过期的悬停；键盘聚焦到视窗外的卡牌时会自动移入。Alt 大图、底部玩家牌组及右侧玩家列表不随桌面缩放。接口见 [TableViewport 说明](src/shared/components/table-viewport/README.md)。

- 鼠标移入卡牌时按原卡比例轻微放大、浮起；选中手牌时保持同样的放大尺寸，只再抬高 6 像素。卡图、边框、阴影与选中标记共用同一容器。也可以用 Tab 聚焦卡牌。
- 玩家牌组中间以“手牌／宝藏／旁置”Tab 隔离，初始只有手牌；宝藏、旁置中有牌才显示对应 Tab，清空当前区域时自动回到手牌，新区域出现时保留当前视图。各区共用卡牌重叠布局及 Alt 检视；旁置可展示牌背，手牌保留选中与本地顺序，两侧抽牌堆和弃牌堆固定不动。外部面板的“演示获得宝藏／清空宝藏”和“演示旁置／归还旁置牌”用于检查增减与回退。
- Tab 右侧、自动理牌开关左侧为独立的响应区，默认保留空白。`setResponse(null)` 清空，`setResponse({id, prompt})` 显示纯阶段提示，传入 `choices` 则显示临时选项，通过 `onResponse` 返回选择。外部测试面板可触发回合开始的“村庄／地下城／休整”选择；选择后收起，休整则替换为选择摧毁手牌或结束回合的提示。另可单独演示纯阶段提示及清空。流程仅改变显示，不提交引擎命令、不摧毁卡牌或推进回合。动画及拖拽归位期间禁用响应与 Tab；响应不随卡牌 Tab 切换而消失。
- 页头可以用滑块或加减按钮重设 0～30 张示例手牌，同时将抽牌堆恢复为 24 张、弃牌堆恢复为 8 张。已经创建的卡牌视图与卡图会复用。
- “抽 1 张”和“抽多张”演示抽牌；批量张数可输入，实际数量受抽牌堆剩余张数和本页 30 张手牌上限约束。抽牌堆抽空后可点击“重置演示”。
- “演示摧毁”优先使用已选中的第一张手牌，否则使用最左侧手牌：卡牌约 300ms 内移至中央并放大，随后约 1 秒逐渐化为保留原图颜色的细尘，沿不同轨迹旋转、上扬并消散。该按钮只更新本地演示手牌，不改变抽弃牌堆，也不发送游戏命令；可用“重置演示”重复查看。
- 点击手牌切换选中状态，再点击“弃选中”；也可以直接“全部弃牌”。最终弃牌堆顶牌由原手牌顺序决定。
- 牌堆仅显示顶牌，底下最多绘制 5 层纸张侧边，总厚度 7.5 像素，旁边显示准确张数；0 张时显示空牌位。顶牌和纸张侧边一起悬停浮起；顶牌离开牌堆时，纸张侧边留给新的顶牌。
- 点击抽牌堆或弃牌堆打开网格浏览，保留重复卡牌的每一个实例，网格只显示卡图。窗口标题栏使用全局深蓝灰背景、浅色文字与铜金色分隔线。弃牌堆按牌堆自顶向下排列；抽牌堆按卡牌 ID 升序排列。窗口和牌堆悬停均不显示提示。空牌位也可以打开浏览窗口。
- 浏览窗口使用独立的卡牌视图，不改变实际牌堆顺序或顶牌朝向；网格中的卡牌同样支持悬停、Tab 聚焦和按住 Alt 检视原尺寸大图。Esc、关闭按钮或点击窗口外空白处均可关闭，并恢复牌堆焦点；窗口打开时牌桌暂停接收交互。
- 外部快照更新牌堆时，浏览窗口保持打开，列表、排序、张数与空状态同步更新，并保留滚动位置和仍存在的焦点牌。“测试抽牌堆同步”／“测试弃牌堆同步”打开对应窗口，2 秒后模拟外部移走 2 张牌，再过 2 秒放回；重置或离开页面会取消测试。
- “演示洗回”直接播放空抽牌堆场景：先将当前两侧牌堆合并为演示用弃牌堆，手牌保持原样，再用最多 6 张已加载的卡牌代表整叠牌，翻背、分成两叠交错收拢，最后移到抽牌堆。约 0.65 秒完成，移动中的牌堆不附带张数标签，可反复播放；`shuffle-motion.ts` 只负责视觉，不调用引擎或真实洗牌算法，也不会在抽牌时自动触发。
- 手牌从左到右排列，右侧牌覆盖左侧牌。空间充足时保持 14 像素间距并居中；空间不足时均匀压缩 `张数 − 1` 个间隔，保证首尾边缘都在手牌区内。`ResizeObserver` 在区域或卡牌尺寸变化时重新计算布局。
- 手牌标题旁的“自动理牌”默认关闭。关闭时可以横向拖动手牌调整顺序，移动限制在手牌区内；虚线牌位标出落点，其他卡牌实时让位，松手后约 160 毫秒归位。轻点仍切换选中，拖动不改变选中状态；Esc、失焦、缩放或指针取消会撤销尚未松手的拖动。
- 开启自动理牌后，立即按卡牌 ID 升序排列，抽牌、弃牌和重设手牌后也持续保持排序；相同 ID 的不同实例保留相对顺序。开启期间暂停手动拖动，关闭后可继续调整当前顺序。拖动和归位期间暂停抽弃牌、牌堆浏览和 Alt 检视，避免动画互相干扰。
- 玩家没有翻面快捷键或按钮。抽牌堆默认背面朝上、弃牌堆默认正面朝上；卡牌朝向和翻面动画由前端展示逻辑通过 `PhysicalCard.setFaceUp()` 控制。
- 按住 Alt 只显示当前朝向的原尺寸卡图，正反面均不附带额外信息；松开、移出或窗口失焦时关闭。
- Alt 检视、实体卡牌和程序翻面由 [game-card 通用模块](src/shared/components/game-card/README.md)提供。地下城、村庄等区域可直接注册自己的卡牌；玩家牌组已复用该模块，各区域协调为一个当前检视对象。
- 牌桌及牌堆浏览窗口沿用免费的 [Kenney Cursor Pack](https://kenney.nl/assets/cursor-pack) 手形光标（CC0）：空白处、控件和卡牌统一使用原本的斜向指示手，悬停、按住及普通点击均不改变光标。手牌实际开始拖动或公共桌面开始平移（超过移动阈值）后，整个牌桌区域切换为握手；松开或取消立即恢复，归位动画期间同样使用斜向指示手。光标跟随现有的 `data-dragging`／`data-panning` 标记，不单独监听鼠标按键。两张 32 × 32 原图、点击热点和来源授权保存在组件的 `cursors/` 目录，随页面预加载；页头和牌桌外仍使用原有光标。
- 正面原图为 504 × 704，牌背为 501 × 704 个 CSS 像素。小屏保持原尺寸，可在按住 Alt 时滚动查看，不强制缩小。

实现使用原生 TypeScript／CSS，摧毁特效采用 [Vanilla Disintegrate](https://github.com/uvarov-frontend/vanilla-disintegrate) 的 WebGL2 粒子渲染器（MIT，许可见 `public/licenses/vanilla-disintegrate.txt`）。只导入 `/particles`，直接将已解码卡图绘制为临时纹理，不需要 SnapDOM、React 或 Three.js；WebGL 不可用时回退为 35 块不规则纸片的独立运动。中断时同步取消并释放粒子资源。[PlayerDeckArea](src/shared/components/player-deck-area/README.md) 与 [PublicTableArea](src/shared/components/public-table-area/README.md) 各自创建完整区域、交互及覆盖层，接收展示快照并提供回调；不读取规则引擎或后端。`game-probe.html` 为这两个组件各保留一个挂载点；页面保留 `demo-state.ts` 的示例牌组、`demo-controller.ts` 的玩家演示按钮、`public-demo-*` 的公共区域示例、原 DOM ID 的适配和外层布局。演示状态不写入正式对局。

`card-motion.ts` 将已加载的同一个卡牌元素暂时移入固定动画层，以 250 毫秒完成移动；批量动作间隔 60 毫秒。抽牌途中由展示层自动翻正，弃牌保持正面。最终状态先一次确定，原有手牌只调整一次位置，新牌依次飞入预留位置。抽牌堆张数在起飞时减少，弃牌堆张数和顶牌在落下时更新。动画期间暂时停用抽弃牌、手牌选择和检视，重置按钮始终可用。

窗口缩放、失焦、页面隐藏或离开页面时，立即完成已提交的移动并移除动画层；重置和迟到的图片解码不会覆盖新状态。系统启用减少动态效果或浏览器不支持动画时，直接显示最终状态。

桌面正反面与检视大图均使用固定的图片元素，在初始化时通过 `HTMLImageElement.decode()` 等待图片可用后开放翻面和检视。后续操作只改变旋转角度或显隐，不替换 `src`，也不重复调用解码流程。浏览器仍负责动画帧的绘制与合成。

桌面卡牌采用同一平面上的两个图案，始终只显示其中一个。程序控制的翻面用 Web Animations API 先从 0° 收拢到 -90°，切换图案，再从 +90° 展开到 0°，总时长为 220 毫秒；不使用背对背元素、`backface-visibility` 或常驻 `preserve-3d`。结束后取消动画，回到没有 transform 的静态卡面。连续更新朝向时以最后要求为准；窗口失焦、切换标签页和离开页面时立即完成最后朝向。系统启用减少动态效果时直接切换图案。

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
