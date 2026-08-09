# AItour

AItour 是一个连续、可执行、可局部调整的 AI 旅行规划应用。用户同时提供自然语言需求和结构化旅行资料，系统生成城市阶段、住宿、每日时间轴、逐段交通及跨日连接，再用 Google Maps Platform 核验地点和可路由交通。

## 核心能力

- 生成前补全旅行天数、预算、节奏和交通优先级，并可进一步填写开始日期、预算硬上限、同行人、允许/避免交通、步行上限、作息、住宿、饮食及无障碍需求。
- DeepSeek 生成候选行程并进行内容覆盖复核；结构化偏好会作为硬约束注入短行程和长行程工作流。
- 12 天及以上的长行程采用“完整骨架 + 每 7 天分段细化”的工作流，避免超长 JSON 被截断。
- 每天拥有稳定 ID、住宿起终点、活动节点、逐段 Leg、时间轴和相邻日连接；换城时明确显示跨城方式、估时及确认状态。
- WALK、TRANSIT、DRIVE、BICYCLE 逐段请求 Google Routes；RAIL、FLIGHT 明确标记为需确认班次，只提供估时，不伪造地图折线。
- 路线、地点、日程、跨日和预算在生成结束后进行确定性健康检查；AI 审核不可用时不会再伪称“已通过”。
- Google Maps JavaScript API 提供原生地图、卫星图、街景、缩放和信息窗口。
- Google Places、Geocoding 和 Routes 提供地点搜索、城市约束定位、附近交通点和逐段路线。
- 通过国家、城市视口、行政区组件和地点名称多层校验，拦截外地同名景点。
- 行程与地图双向选择，支持全程概览、按城市分组的日期导航、节点锁定、上下移动、删除、重新计算、撤销和重做。
- 新方案失败时保留当前可用方案；历史版本以完整快照保存在浏览器 IndexedDB，不上传到项目服务端数据库。
- 桌面端采用 44% 行程 / 56% 地图布局；移动端采用地图背景与可滚动行程面板。

## 技术栈

- 前端：React 18、Vite 7、Google Maps JavaScript API、IndexedDB
- 后端：Node.js、Express、DeepSeek Chat Completions API
- 地图数据：Google Places API、Geocoding API、Routes API
- 测试：Node.js 内置测试运行器

## 工作流

```text
自然语言需求 + 结构化旅行资料
  -> 完整性检查 / 结构化追问
  -> DeepSeek 生成结构化候选计划
  -> DeepSeek 内容覆盖复核，必要时修正一次
  -> Google 地点搜索与城市/国家/名称校验
  -> 编译稳定 Trip / Stage / Day / Node / Leg
  -> 按偏好选择每段交通并请求真实路线
  -> 调度每日时间轴和跨日连接
  -> 预算摘要与确定性健康检查
  -> React 时间轴 / 地图双向渲染
  -> IndexedDB 保存版本快照
```

## 本地运行

### 1. 准备环境

需要 Node.js 20.19 或更高版本，以及已启用以下服务的 Google Maps Platform 项目：

- Maps JavaScript API
- Places API (New)
- Geocoding API
- Routes API

同时需要一个可用的 DeepSeek API Key。

### 2. 安装依赖

```bash
npm run install:all
```

### 3. 配置环境变量

复制 `.env.example` 为 `.env`，再填写密钥：

```dotenv
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
GOOGLE_MAPS_API_KEY=...              # 服务端 Places / Geocoding / Routes Key
VITE_GOOGLE_MAPS_API_KEY=...         # 浏览器 Maps JavaScript Key
VITE_GOOGLE_MAP_ID=...               # 可选
PORT=3001
CORS_ORIGINS=https://your-app.example.com  # 生产环境允许的前端来源，可逗号分隔
PLAN_RATE_LIMIT_MAX=10
PLAN_RATE_LIMIT_WINDOW_MS=900000
TRUST_PROXY=0                        # 仅在可信单层反向代理后设为 1
```

`.env` 和 `api.txt` 已被 Git 忽略。不要把真实密钥提交到仓库。两个 Google Key 必须分开：浏览器 Key 应限制 HTTP referrer 和 Maps JavaScript API；服务端 Key 应限制服务器 IP、Places、Geocoding 和 Routes API。前端绝不会回退或打包 `GOOGLE_MAPS_API_KEY`；未配置浏览器 Key 时地图会明确降级，但服务端仍可生成计划和计算路线。

### 4. 启动项目

Windows 可以双击 `start.bat`，或在终端执行：

```bash
npm run dev
```

- 前端：http://localhost:5173
- 后端健康检查：http://localhost:3001/api/health

## 验证

运行全部单元、HTTP 契约测试与前端数据层测试：

```bash
npm test
```

运行完整发布门禁：

```bash
npm run check
```

依赖安全审计：

```bash
npm audit --registry=https://registry.npmjs.org
npm audit --prefix server --registry=https://registry.npmjs.org
npm audit --prefix client --registry=https://registry.npmjs.org
```

当前自动化测试覆盖结构化偏好、中文天数、预算口径、稳定 ID、酒店首尾、逐段交通选择、真实路线/失败语义、时间轴、跨城连接、健康检查、HTTP 接口、长行程分段、地理边界、前端快照、竞态保护及撤销/重做。GitHub Actions 会自动执行测试、构建和三层依赖审计。

## 目录结构

```text
AItour/
├─ client/                 React + Vite 前端
│  └─ src/
│     ├─ components/      输入、计划、地图、交通、校验和历史面板
│     └─ services/        API、Google Maps 加载与 IndexedDB
├─ server/                 Express 后端
│  ├─ routes/plan.js      完整规划工作流编排
│  ├─ services/           LLM、Google、地理编码、路线、交通和自审
│  └─ test/               自动化回归测试
├─ .env.example            环境变量模板
├─ CHANGELOG.md            完整项目更新日志
├─ prompt.md               项目原始需求说明
└─ start.bat               Windows 启动脚本
```

## 当前边界

- AI 生成内容仍可能存在事实偏差；地理与路线校验不能代替开放时间、票务、价格和实时班次核实。
- Google Routes 无法直接确认铁路和航班班次，因此这些路段会明确显示为“需确认”，绝不会用直线冒充真实路线。
- 预算只汇总币种一致、计价口径明确且有合理估算的数据；`null`、空值、异币种和语义不明费用不会被当成 0 元，覆盖不足会明确警告。
- 未填写开始日期时，公共交通结果会标记为待复核；路线服务失败时只保留明确标注的估时，且不会为了“跑通”而回退成长距离步行。
- 历史记录仅保存在当前浏览器，清除站点数据后会丢失。
- 项目尚未提供账号系统、云端同步、部署配置和移动端原生应用。

详细演进过程与验证结果见 [CHANGELOG.md](./CHANGELOG.md)。
