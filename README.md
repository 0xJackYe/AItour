# AItour

AItour 是一个 AI 旅行规划应用：用户用自然语言描述目的地、天数、预算、节奏和偏好，系统生成结构化行程，再用 Google Maps Platform 校验地点、查询交通点并绘制真实路线。

## 核心能力

- DeepSeek 生成结构化旅行计划，并进行一次独立自审；发现严重问题时最多重生成一次。
- 12 天及以上的长行程采用“完整骨架 + 每 7 天分段细化”的工作流，避免超长 JSON 被截断。
- Google Maps JavaScript API 提供原生地图、卫星图、街景、缩放和信息窗口。
- Google Places、Geocoding 和 Routes 提供地点搜索、城市约束定位、附近交通点和步行路线。
- 通过国家、城市视口、行政区组件和地点名称多层校验，拦截外地同名景点。
- WebGL 可用时优先启用矢量地图和连续缩放；低能力环境自动回退到兼容模式。
- 行程历史保存在浏览器 IndexedDB 中，不上传到项目服务端数据库。

## 技术栈

- 前端：React 18、Vite 5、Google Maps JavaScript API、IndexedDB
- 后端：Node.js、Express、DeepSeek Chat Completions API
- 地图数据：Google Places API、Geocoding API、Routes API
- 测试：Node.js 内置测试运行器

## 工作流

```text
自然语言需求
  -> DeepSeek 生成结构化计划
  -> DeepSeek 自审，必要时重生成一次
  -> Google 地点搜索与城市/国家/名称校验
  -> Google 附近交通点查询
  -> Google Routes 生成每日路线
  -> React 地图与计划面板渲染
  -> IndexedDB 保存本地历史
```

## 本地运行

### 1. 准备环境

需要 Node.js 18 或更高版本，以及已启用以下服务的 Google Maps Platform 项目：

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
GOOGLE_MAPS_API_KEY=...
PORT=3001
```

`.env` 和 `api.txt` 已被 Git 忽略。不要把真实密钥提交到仓库。生产环境建议拆分浏览器 Key 与服务端 Key，并分别设置域名、IP 和 API 范围限制。

### 4. 启动项目

Windows 可以双击 `start.bat`，或在终端执行：

```bash
npm run dev
```

- 前端：http://localhost:5173
- 后端健康检查：http://localhost:3001/api/health

## 验证

运行后端测试：

```bash
npm --prefix server test
```

构建前端：

```bash
npm --prefix client run build
```

当前测试覆盖长行程识别与分段合并、JSON 容错与截断重试、单城市约束、国家/行政区/名称校验以及同名景点唯一键。

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

- AI 生成内容仍可能存在事实偏差；地理校验能降低地点错误，但不能代替开放时间、票务和实时班次核实。
- 当前地图路线统一由 Google Routes 的步行模式生成，LLM 文案中的火车、地铁或出租车建议尚未形成统一的分段交通数据。
- 历史记录仅保存在当前浏览器，清除站点数据后会丢失。
- 项目尚未提供账号系统、云端同步、部署配置和移动端原生应用。

详细演进过程与验证结果见 [CHANGELOG.md](./CHANGELOG.md)。
