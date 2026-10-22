# Frontend

前端使用 TypeScript 与 Vite。`src/` 放客户端模块，根目录的四个 HTML 是大厅、规则配置、实验台和怪物审核的入口；`tests/` 放前端测试。

在任意工作目录执行本目录的 `run_frontend.bat`，或运行 `bash frontend/run_frontend.sh`，默认访问 `http://127.0.0.1:5173/`。依赖在仓库根目录通过 `npm ci` 安装，启动器会先构建共享引擎。后端另用 `backend/run_backend.bat` 启动。

`vite.config.mjs` 将 API、WebSocket、卡图和工具数据代理到 `http://127.0.0.1:8765`；调整后端地址时，可复制 `.env.example` 为 `.env.local` 并修改 `VITE_API_ORIGIN`。页面地址 `/config`、`/effect-lab`、`/monster-audit` 和房间查询参数在开发与构建后保持一致。

从仓库根目录执行 `npm run build:frontend` 生成 `frontend/dist/`；后端可直接托管该产物，保持原有 8765 审核地址。前端测试用 `npm test --workspace @thunderstone/frontend`，类型检查用 `npm run typecheck --workspace @thunderstone/frontend`。

## 全局样式

所有页面以规则配置页为视觉基准，使用 [global.css](global.css) 的全局样式。它定义暖纸色页面、米白面板、深蓝灰渐变页头、铜金色主按钮，以及正文无衬线字体和标题衬线字体。

## 加载与职责

每个 HTML 先加载全局样式，再加载页面自己的布局样式：

```html
<link rel="stylesheet" href="/global.css">
<link rel="stylesheet" href="/example.css">
```

共享颜色、字体、圆角、阴影和基础组件放在 `global.css`；页面 CSS 只负责该页的排列、密度、响应式布局及业务组件。新增通用组件时直接补充全局样式，避免在各页复制一份主题。功能状态使用全局语义色。

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

`main` 的宽度、网格、区域间距由页面布局定义。表单控件、键盘焦点、隐藏状态和基础按钮外观由全局样式提供；工具页的步骤、卡牌和审核状态保留各自结构。
