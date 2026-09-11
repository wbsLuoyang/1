# AI Hub · 多端点模型聚合平台

把几个不同来源的 OpenAI 兼容端点聚合成一个界面。后端零依赖，`node server.js` 即跑。

## 启动

```bash
cd ai-hub
node server.js          # 或者双击 start.bat
```

然后打开 http://127.0.0.1:8899

## 已接入的端点

| 端点 | 地址 | 状态 |
|---|---|---|
| LabAPI | `api.labapi.work/v1` | 40 个模型 |
| Xiaomi MiMo | `api.xiaomimimo.com/v1` | 6 个（含 ASR / TTS） |
| Relay 隧道 | `according-conditions-self-prospects.trycloudflare.com` | 5 个 |

> 密钥全部保存在服务端 `config.json`，前端页面拿不到，只走本地代理转发。

## 多设备访问

默认已经监听 `0.0.0.0`，启动时终端会打印局域网地址，比如：

```
局域网   http://192.168.10.164:8899
         （手机/平板连同一个 WiFi 即可打开）
```

手机连同一个 WiFi，浏览器打开这个地址就行。首次进入要输访问密码（默认 `hub-8899`）。

只想让本机访问，把 `config.json` 的 `server.host` 改回 `127.0.0.1`。

## 访问密码（重要）

服务默认带一层密码保护，**这个密码是必需的** —— 因为后端握着你的三个 API 密钥，谁能打开这个地址，谁就能用你的额度。

- 改密码：`config.json` 里的 `auth.password`
- 云部署时用环境变量 `AIHUB_AUTH_PASSWORD` 注入，不要写进文件
- 忘记密码：直接改配置文件里的值，重启生效
- 确实不需要密码（比如只跑在本机）：把 `auth.enabled` 设成 `false`

## 部署到公网

如果要在家以外的地方也能用，有三条路，按省事程度排：

### 1. 内网穿透 / 组网（推荐，最安全）

服务留在自己电脑上，只是把端口打通，**密钥永远不会离开你的机器**：

| 工具 | 说明 |
|---|---|
| **Tailscale** | 最推荐。把电脑和手机组成一个虚拟内网，手机在外地用 4G 也能访问，且完全不暴露公网。免费版够个人用 |
| **Cloudflare Tunnel** | 免费，`cloudflared tunnel --url http://localhost:8899` 直接给一个临时公网域名，但域名每次重启会变 |
| frp / ngrok | 需要自己有服务器，或者免费版有限速和随机域名 |

### 2. 托管平台（真正跑在云上）

本项目零依赖，任何支持 Node 的平台都能直接跑。注意这些平台**都要求把密钥配成环境变量**，不要提交 `config.json`。

需要设置的环境变量：

| 变量 | 作用 |
|---|---|
| `AIHUB_AUTH_PASSWORD` | 访问密码，务必设置 |
| `AIHUB_GATEWAY_KEY` | `/v1` 网关的密钥 |
| `AIHUB_PROVIDERS_JSON` | 端点配置，JSON 数组字符串 |

`AIHUB_PROVIDERS_JSON` 示例（一行）：

```json
[{"id":"labapi","name":"LabAPI","base":"https://api.labapi.work/v1","key":"sk-xxx"},{"id":"mimo","name":"MiMo","base":"https://api.xiaomimimo.com/v1","key":"sk-yyy"}]
```

平台对比：

| 平台 | 免费额度 | 主要限制 |
|---|---|---|
| **Render** | 750 小时/月 | 15 分钟无流量会休眠，冷启动 30–60 秒 |
| **Railway** | 每月 $5 额度 | 额度用完要付费，但不会休眠 |
| **Fly.io** | 3 台小规格 VM | 需要装 CLI、配 Dockerfile |
| **Koyeb** | 有免费实例 | 规格较小 |
| Vercel / Netlify | 免费 | **不适合本项目** —— 它们是 Serverless，扛不住 SSE 长连接 |

已经准备了 `Dockerfile`，Fly.io / Koyeb / Railway 都能直接用。

> ⚠️ 部署前务必确认：`config.json` 已在 `.gitignore` 里，推代码前用 `git status` 检查一遍，别把密钥提交上去。

### 3. 租一台 VPS

最自由但要自己装环境、配 HTTPS、管安全更新。国内访问海外平台可能慢，选机器时把"你从哪访问"和"API 在哪"都考虑进去。

## 功能

- **多模型并排对比**：模型选择器里多选，一次提问同屏对比回答
- **流式输出**：SSE 逐字显示，支持中途停止
- **思考过程**：自动识别 `reasoning_content` 并折叠展示
- **会话管理**：本地保存，可重命名、删除、导出 Markdown
- **参数面板**：系统提示词 / temperature / max_tokens / 流式开关
- **模型筛选**：区分对话 / 图像 / 语音模型，支持搜索
- **深浅主题**

## OpenAI 兼容统一网关

除界面外，还能把本平台当单一网关用（给别的软件配）：

```
Base URL: http://127.0.0.1:8899/v1
API Key:  hub-local-key        # 见 config.json 的 gateway.apiKey
Model:    labapi/claude-opus-5 # 格式 provider/model
```

不带前缀写模型名也可以 —— 只要该模型在所有端点里唯一，会自动路由；重名时会返回提示让你加前缀。

查询全部可用模型：

```bash
curl http://127.0.0.1:8899/v1/models -H "Authorization: Bearer hub-local-key"
```

## 增删端点

编辑 `config.json` 的 `providers` 数组，然后重启，或在界面上点「刷新模型」。每项格式：

```json
{
  "id": "labapi",
  "name": "LabAPI",
  "base": "https://api.labapi.work/v1",
  "key": "sk-...",
  "enabled": true
}
```

`id` 会作为网关里的模型前缀，建议用简短的英文。

## 目录结构

```
ai-hub/
├── server.js              后端：静态托管 + 模型聚合 + 聊天代理 + 网关 + 密码保护
├── config.json            端点与密钥配置（已被 .gitignore 排除，不会进版本库）
├── config.example.json    配置模板，照着填
├── models.cache.json      模型列表缓存（自动生成）
├── start.bat              前台启动，带窗口
├── start-hidden.vbs       后台启动，无窗口
├── install-autostart.bat  设置开机自启
├── Dockerfile             云平台部署用
├── README.md              本文件
├── MODELS.md              三个端点的模型可用性清单
├── REMOTE-ACCESS.md       在外面访问的完整方案（Tailscale）
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js             前端逻辑（含自研 Markdown 渲染 + SSE 解析 + 登录门）
└── tools/
    ├── net-check.js       网络自检：服务状态 / 监听范围 / 防火墙 / 可用地址
    ├── probe.js           单点连通性快速探测
    ├── scan.js            全量模型可用性扫描 → scan.json
    └── ui-test.js         浏览器端到端测试（Edge CDP 驱动）
```

## 排查

- **手机/其它设备连不上**：先跑 `node tools/net-check.js`，它会一次性告诉你服务在没在跑、监听范围对不对、防火墙放没放行、以及该用哪个地址访问。
- **页面显示某端点不可用**：点侧栏「刷新模型」重试；若仍失败，看终端里打印的错误（会写明 HTTP 状态码或超时）。
- **某个模型报错**：错误会原样显示在回答气泡里，包含端点返回的原始信息，不会被吞掉。
- **端口被占用**：改 `config.json` 里的 `server.port`。
- **隧道类端点失效**：`trycloudflare.com` 的临时隧道每次重启都会换域名，域名解析不了就说明隧道已关，需要换成新地址。
