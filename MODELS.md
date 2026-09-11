# 端点与模型可用性清单

扫描时间：2026-09-11 18:59　·　实测方式：每个模型发一次最小请求（`max_tokens=8`）

## 总览

| 端点 | 地址 | 对话模型可用 | 状态 |
|---|---|---|---|
| LabAPI | `api.labapi.work/v1` | **35 / 37** | 正常 |
| Xiaomi MiMo | `api.xiaomimimo.com/v1` | **2**（另 4 个是语音） | 正常 |
| Relay 隧道 | `according-conditions-self-prospects.trycloudflare.com/v1` | **4 / 5** | 正常 |

流式（SSE）已在三个端点上全部验证通过，均能正确返回 `[DONE]` 结束标记。

---

## LabAPI —— 35 个可用（40 个模型）

### 对话模型（实测可跑）

| 模型 | 首字延迟 | 备注 |
|---|---|---|
| `deepseek-v4-flash` | 0.7s | 最快，适合日常问答 |
| `lab-s2-preview-35b` | 0.7s | |
| `lab-s2-preview` | 0.8s | |
| `lab-s1` | 0.8s | |
| `gemini-2.5-flash` | 1.1s | |
| `minimax-m3` | 1.2s | 后端实际为 `MiniMax-M3` |
| `lab-s1-mini` | 1.4s | |
| `gemini-3.7-flash` | 1.9s | |
| `lab-vl3.5-latest` | 2.2s | 视觉模型 |
| `lab-vl3.5-241b-a28b` | 2.6s | 视觉模型 |
| `deepseek-v4-pro` | 2.6s | 后端为 `deepseek-v4-pro-ga-260813` |
| `glm-5.3-flash` | 2.6s | |
| `glm-5.3` | 2.7s | |
| `gpt-5.6-luna` | 2.7s | |
| `gpt-6-astra` | 3.0s | |
| `gemini-3-flash` | 3.0s | |
| `claude-sonnet-4-6` | 3.2s | |
| `gemini-3.5-flash` | 3.2s | |
| `grok-4.6` | 3.3s | |
| `gpt-5.3-codex-spark` | 3.3s | 代码方向 |
| `claude-opus-4-8` | 3.5s | |
| `lab-s1-pro` | 3.7s | |
| `qwen3.8-max` | 3.8s | |
| `claude-opus-4-6` | 4.4s | |
| `claude-fable-5` | 4.6s | |
| `lab-latest` | 5.1s | |
| `gemini-3.1-pro-preview` | 5.4s | |
| `grok-4.5` | 5.6s | |
| `gemini-3.6-flash` | 5.9s | |
| `claude-opus-4-7` | 9.1s | |
| `gpt-5.6-terra` | 13.0s | |
| `gpt-5.6-sol` | 14.2s | |
| `lab-s2-preview-397b` | 16.5s | 大参数，较慢 |
| `gpt-5.5` | 23.9s | 慢但可用 |
| `claude-opus-5` | 23.9s | 慢但可用 |

### 未通过

| 模型 | 情况 |
|---|---|
| `glm-5.2` | 60 秒超时 |
| `kimi-k3` | 60 秒超时 |

> 两者可能是排队或当前上游拥塞，不是彻底不可用，可以再试。

### 非对话模型

`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` —— 图像生成，不能走 chat 接口。

---

## Xiaomi MiMo —— 2 个对话模型

| 模型 | 首字延迟 | 用途 |
|---|---|---|
| `mimo-v2.5` | 1.4s | 对话 |
| `mimo-v2.5-pro` | 1.8s | 对话 |

语音类（不走 chat）：`mimo-v2.5-asr`（识别）、`mimo-v2.5-tts`、`mimo-v2.5-tts-voiceclone`、`mimo-v2.5-tts-voicedesign`。

---

## Relay 隧道 —— 4 个可用（5 个模型）

| 模型 | 首字延迟 | 后端实际模型 |
|---|---|---|
| `deepseek-v4-flash` | 2.3s | `deepseek-v4-flash` |
| `deepseek-v4-flash-max32000` | 2.5s | `self-dploy/DeepSeek-V4-Flash` |
| `qwen-3.8-flash` | 3.5s | `self-dploy/Qwen3.8-Flash-Next` |
| `sensenova-6.8-flash-lite` | 13.0s | `sensenova-6.8-flash-lite` |

未通过：

| 模型 | 原因 |
|---|---|
| `step-3.7-flash` | 上游返回 `you have no active step plan subscription` —— 该账号没有 Step 套餐 |

> 这个端点是 Cloudflare 临时隧道，域名会变。先前给的 `cement-underlying-too-somewhat...` 已失效（DNS 解析不了），当前生效的是 `according-conditions-self-prospects...`。

---

## 模型名冲突提醒

`deepseek-v4-flash` 在 **LabAPI** 和 **Relay** 两个端点同时存在，用统一网关时必须写前缀区分：

```
labapi/deepseek-v4-flash
relay/deepseek-v4-flash
```
