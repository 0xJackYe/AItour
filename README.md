# AItour

AItour 是一个 AI 旅行规划应用：用户用一句自然语言描述目的地、天数、预算、节奏和偏好，系统生成结构化的每日行程，用 Google 地图逐一核实地点，并规划每两个地点之间的真实交通方式与路线。

> 项目审查结论、本次优化细节与商业化路线图见 [docs/REVIEW.md](./docs/REVIEW.md)。

## 核心能力

- **可以直接照着走的方案**：每个地点都有到达时间、停留时长、费用和具体看点；每天安排午餐和晚餐；换城市的日子写清车次与车程；另有人均预算、需要提前预订的项目和每个过夜城市的住宿建议。支持一键复制为纯文本或打印 / 存为 PDF。
- **一句话生成行程**：理解“京都三天”“两周”“四天三夜”“半个月自驾”等中英文表达，天数作为硬约束写入提示词并逐日校验。
- **稳定可靠的生成**：流式调用 + 空闲超时识别卡死；429/5xx/网络错误自动退避重试；缺天只做定向补全；单次输出被截断时自动降级为“骨架 + 分段细化”；8 天以上直接分段生成。
- **双重校验**：AI 自审与 Google 地点核实并行进行；问题较多时带反馈重生成一次，并在两版之间择优，质量只升不降。
- **地点核实**：按城市都市圈半径、行政区和名称多层判断，拦截外地同名地点，同时保留凡尔赛宫、东京迪士尼、京都→奈良一日游等近郊/一日游地点；无法确认的地点保留但不上图。
- **真实路线**：每段路程单独选择步行 / 公共交通（含线路名）/ 驾车；在不破坏时段安排的前提下优化当天顺序，减少折返；一键在 Google 地图中打开当天导航。
- **城市间交通**：每次换城市（包括一日游往返）都有一条城际交通，写明车次 / 航班 / 自驾道路、出发与到达站、时刻、时长、票价和订票建议，例如“札幌 → 函馆：JR 特急北斗号，约 3 小时 45 分钟”。模型没有写时，按每天的城市、车站和交通说明推断。自驾和有公交数据的地区画真实路线，没有数据的地区（如日本铁路）画虚线示意，并给出 Google 地图路线链接。出发站和到达站相邻时，这段交通就是时间线上的一段路程，排程按列车时长计算。
- **实时进度**：SSE 推送“理解需求 → 生成行程 → 校验地点 → 规划路线”各阶段进度，可随时停止；用户断开后服务端立即停止调用付费 API。
- **简洁界面**：一个输入框 + 一条时间线；地图与行程联动，移动端地图吸顶。多城市行程有“总览 → 城市 → 某一天”三级视图：总览看城市和城际交通，点城市看城市内的景点路线，点某一天看当天路线。
- **随时回到输入页**：顶栏的“新行程”按钮和标志都能回到输入页；浏览器后退 / 前进可以在输入页和行程之间切换，刷新页面会从本地历史恢复当前行程。
- **本地历史**：行程保存在浏览器 IndexedDB（最近 30 条），兼容旧版本记录。

## 工作流

```text
自然语言需求
  → 确定性解析（天数 / 交通偏好 / 上限检查）
  → 大模型生成（≤7 天单次生成；≥8 天或被截断时：骨架 + 分段细化；缺天定向补全）
  → [AI 自审 ∥ Google 地点核实（缓存 + 限流 + 重试）]
  → 必要时带反馈重生成一次，两版择优
  → 当日顺序优化 → 城市间交通（模型给出 + 按行程推断）
  → [城际路线 → 逐段路线规划 ∥ 住宿附近交通站] → 按真实路程排程
  → SSE 推送结果 → React 地图与时间线渲染 → IndexedDB 保存
```

## 本地运行

### 1. 准备

- Node.js 20 或更高版本（18 已停止维护，但仍可运行）
- Google Maps Platform 项目，启用：Maps JavaScript API、Places API (New)、Routes API（服务端所有调用都通过请求头携带 Key，不再需要 Geocoding API）
- DeepSeek API Key（或任意 OpenAI 兼容服务，修改 `DEEPSEEK_BASE_URL` 与 `DEEPSEEK_MODEL` 即可）。截至 2026 年 11 月，`deepseek-chat` 是 `deepseek-flash`（V4.1-Flash）非推理模式的别名，速度最快；也可以显式指定 `deepseek-flash` 或 `deepseek-v4-pro`

### 2. 安装依赖

```bash
npm run install:all
```

> 锁文件中的依赖地址是国内镜像。如果在海外网络下安装缓慢，可以加上
> `--replace-registry-host=always --registry=https://registry.npmjs.org/`。

### 3. 配置环境变量

复制 `.env.example` 为 `.env` 并填写密钥。完整的可选参数（超时、重试、限流、缓存等）见 `.env.example` 中的注释。

### 4. 启动

Windows 可以双击 `start.bat`，或在终端执行：

```bash
npm run dev
```

- 前端：http://localhost:5173
- 后端健康检查：http://localhost:3001/api/health

### 5. 生产部署（单进程）

```bash
npm run build
```

```bash
NODE_ENV=production npm start
```

也可以部署到 Cloudflare Workers（静态资源由 Cloudflare 托管，大模型可回退到 Workers AI）：`npm run cloudflare:deploy`，配置见 `wrangler.jsonc`。

Express 会同时托管 `client/dist` 与 `/api`。浏览器端 Google Key 通过 `/api/config` 在运行时下发，同一份构建产物可以部署到任意环境。部署到反向代理之后时请设置 `TRUST_PROXY`，并确保代理允许 SSE 长连接（关闭响应缓冲、超时 ≥ 10 分钟）。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/plan` | 请求体 `{ "query": "..." }`。请求头带 `Accept: text/event-stream` 时以 SSE 推送 `progress` / `result` / `error` 事件，否则返回 JSON。 |
| GET | `/api/health` | 服务状态与密钥配置情况（不返回密钥本身）。 |
| GET | `/api/config` | 浏览器端运行时配置（地图 Key、Map ID、输入限制）。 |

错误统一返回 `{ error, code, retryable, request_id }`，例如 `RATE_LIMITED`、`LLM_TIMEOUT`、`PLAN_INCOMPLETE`。每个响应都带 `X-Request-Id`，便于排查日志。

## 测试

```bash
npm test
```

```bash
npm run build && npm run test:e2e
```

- `npm test`：服务端 147 项单元与集成测试（真实 Express 应用 + 模拟 DeepSeek / Google 上游），以及前端 24 项单元测试。
- `npm run test:e2e`：Playwright 浏览器端到端测试（桌面、移动端、多城市三级视图与城际交通、新行程与浏览器后退 / 刷新、错误 / 澄清 / 取消、导出与打印、地图不可用降级）。Playwright 已在根目录依赖中；本机浏览器版本不一致时设置 `E2E_BROWSER_PATH`。

### 性能测试

```bash
npm run build && npm run perf
```

服务端流水线 CPU 与延迟、并发上限与突发流量、内存稳定性，以及前端包体积、首屏、30 天多城市行程的渲染与视图切换。方法与结果见 [docs/PERF.md](./docs/PERF.md)。

### 行程质量评测

```bash
npm run eval
```

用真实的大模型（以及配置了 Key 时的 Google 地图）跑 `eval/cases.json` 中的 12 个典型需求，按“完整、具体、可执行”的规则自动打分，并为每个用例输出一份可读的行程文档。结果写入 `eval/results/`，方法与最新结果见 [docs/EVAL.md](./docs/EVAL.md)。

> 服务器需要通过代理访问外网时（例如在国内调用 Google 地图接口），Node.js 内置的 fetch 默认不读取 `HTTPS_PROXY`。Node 22.21 及以上版本可以在启动命令前加 `NODE_USE_ENV_PROXY=1`。
- GitHub Actions 在每次推送和 PR 时自动运行以上全部测试。

## 目录结构

```text
AItour/
├─ client/                    React + Vite 前端
│  ├─ src/components/         输入框、进度、行程、时间线、质量提示、地图、历史
│  ├─ src/lib/                纯函数：格式化、视图模型、导航链接
│  ├─ src/services/           API（SSE）、Google Maps 加载、IndexedDB
│  └─ test/                   前端单元测试
├─ server/                    Express 后端
│  ├─ app.js / index.js       应用工厂 / 启动与优雅退出
│  ├─ config.js               集中配置
│  ├─ routes/plan.js          HTTP 层：校验、限流、SSE、取消
│  ├─ services/               需求解析、提示词、大模型、规范化、自审、地点核实、
│  │                          顺序优化、城市间交通、路线、排程、交通站、工作流编排
│  ├─ lib/                    重试、缓存、并发、错误、日志、SSE、限流、地理计算
│  ├─ testing/                模拟上游（测试与 E2E 共用）
│  └─ test/                   自动化测试
├─ e2e/                       浏览器端到端测试
├─ perf/                      性能测试（npm run perf）
├─ docs/                      审查与路线图（REVIEW）、质量评测（EVAL）、性能测试（PERF）
├─ .github/workflows/ci.yml   持续集成
├─ .env.example               环境变量模板
└─ CHANGELOG.md               更新日志
```

## 当前边界

- AI 生成内容仍可能存在事实偏差；地点核实能拦截错误地点，但不能代替开放时间、票务与实时班次核实。
- 公共交通线路基于“次日上午 10 点出发”的估算，实际以出行当天为准。
- 日本等地区的 Google Routes API 不提供公共交通方案：此时 2.5km 内显示步行，更远显示打车参考并标注“公交线路见 Google 地图”，每天的导航链接默认以公交模式打开 Google 地图。
- 历史记录仅保存在当前浏览器；限流与缓存为单实例内存实现，多实例部署需换成 Redis 等共享存储。
- Google 地图在中国大陆无法直接访问；面向大陆用户需要接入国内地图服务（见路线图）。
- 尚未提供账号、支付、分享与云端同步（按计划后续由业务侧接入）。
