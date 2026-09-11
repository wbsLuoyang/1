# 部署到 EdgeOne Makers（腾讯云）

目标：把平台部署到公网，从 GitHub 自动构建，密钥只存在平台环境变量里，不进代码仓库。

## 项目结构

```
├── edgeone.json              部署配置（函数超时、地域、静态目录）
├── public/                   静态前端（会被 CDN 分发）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── cloud-functions/          Node.js 函数（密钥只在这一侧使用）
│   ├── _lib/core.js          共享逻辑：模型聚合 / 聊天代理 / 鉴权
│   ├── api/[[default]].js    /api/*  → 前端接口
│   └── v1/[[default]].js     /v1/*   → OpenAI 兼容网关
└── server.js                 本地自托管版（部署到 EdgeOne 时用不到，可留可删）
```

访问时静态资源优先命中，`/api/*` 和 `/v1/*` 落到函数，两者互不干扰。

---

## 一、先推代码到 GitHub

```bash
cd ai-hub
git init
git add .
git status          # 确认列表里【没有】config.json
git commit -m "init"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

**推之前先跑一次自检**：

```bash
node tools/check-secrets.js
```

看到「可以安全推送到公开仓库」再推。`config.json` 已被 `.gitignore` 排除，但仍值得确认一次。

---

## 二、在 EdgeOne 创建项目

1. 打开 https://console.cloud.tencent.com/edgeone/pages （或 pages.edgeone.ai）
2. 进入 **Pages 服务**（Makers），点「创建项目」
3. 绑定 GitHub，选择刚推的仓库
4. 构建配置：
   - **框架预设**：其他 / 无
   - **构建命令**：留空（本项目零依赖，不需要构建）
   - **输出目录**：`public`
   - **Node 版本**：20.x
5. 点「开始部署」，等 1–2 分钟

> `edgeone.json` 里已经写好 `outputDirectory: "public"` 和函数超时 120 秒，平台会优先采用文件配置，控制台里保持默认即可。

---

## 三、配置环境变量（关键一步）

进入项目 **设置 → 环境变量**，添加这三个：

| 变量名 | 值 |
|---|---|
| `PROVIDERS_JSON` | 端点配置的 JSON 数组（见下方模板） |
| `AUTH_PASSWORD` | 访问密码，自己起一个 |
| `GATEWAY_KEY` | `/v1` 网关密钥，自己起一个，建议 `sk-hub-` 开头 |

`PROVIDERS_JSON` 模板（一行，把 key 换成你自己的）：

```json
[{"id":"labapi","name":"LabAPI","base":"https://api.labapi.work/v1","key":"sk-xxxx"},{"id":"mimo","name":"MiMo","base":"https://api.xiaomimimo.com/v1","key":"sk-yyyy"},{"id":"relay","name":"Relay","base":"https://xxx.trycloudflare.com/v1","key":"sk-zzzz"}]
```

字段说明：

- `id`：短英文，会作为网关里的模型前缀，也用于前端分组
- `base`：端点根地址，**要带 `/v1`**
- `key`：该端点的密钥
- 不想要某个端点，把它从数组里删掉，或者加 `"enabled": false`

**改完环境变量必须重新部署一次才生效**（控制台点「重新部署」，或往 GitHub 推一次提交）。

---

## 四、验证

打开平台域名，应该看到密码门，输入 `AUTH_PASSWORD` 的值进入。

也可以直接用命令行验证网关：

```bash
# 列出全部模型（注意模型名带 provider 前缀）
curl https://<你的域名>/v1/models -H "Authorization: Bearer <GATEWAY_KEY>"

# 调用一次
curl https://<你的域名>/v1/chat/completions \
  -H "Authorization: Bearer <GATEWAY_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"labapi/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

---

## 五、常见问题

**页面能开，但模型列表全红**

进 Makers 控制台看 **函数日志**，错误会写明具体原因（HTTP 状态码或网络超时）。常见的是 `PROVIDERS_JSON` 格式不对 —— 它必须是合法 JSON 数组，不能有换行注释。

**改完环境变量没变化**

环境变量只在下一次部署时注入，需要手动触发一次重新部署。

**回答不是逐字出现，而是憋一大段才出来**

函数超时设短了。确认 `edgeone.json` 里 `cloudFunctions.nodejs.maxDuration` 是 120。

**调用网关返回 401**

请求头必须是 `Authorization: Bearer <GATEWAY_KEY>`，注意空格和 Bearer 前缀。空 token 也会被拒绝。

**自定义域名**

控制台「项目设置 → 域名管理」里绑定，EdgeOne 会自动签发 HTTPS 证书。

---

## 六、费用与限制

- 个人自用强度下，免费额度充足
- Node 函数单次执行最长 120 秒（已配置），请求/响应体上限 6 MB
- 首次请求可能有几百毫秒冷启动
- 每次部署会重新实例化函数，模型列表缓存随之失效，第一次访问会重新拉取

---

## 七、本地继续开发

改了代码想先在本地验证：

```bash
node tools/test-edgeone.mjs     # 直接调用 EdgeOne 的函数逻辑，验证路由/鉴权/流式
node server.js                  # 本地起完整服务，浏览器访问 127.0.0.1:8899
node tools/ui-test.js           # 浏览器端到端测试（需要本地服务在跑）
```

改完推到 GitHub 就会自动重新部署。
