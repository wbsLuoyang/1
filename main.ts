// @ts-nocheck
/**
 * luoy-ai —— Deno Deploy 入口
 *
 * 复用 workers/index.js 里已经验证过的网关逻辑，
 * 只需要把环境变量转成普通对象传进去。
 *
 * 部署到 Deno Deploy 后：
 *   Base URL:  https://<你的项目>.deno.dev/v1
 *   API Key:   你在环境变量里设的 GATEWAY_KEY
 *
 * Deno Deploy 控制台里需要配置两个环境变量：
 *   PROVIDERS_JSON   端点配置（JSON 数组）
 *   GATEWAY_KEY      调用密钥
 */

import worker from "./workers/index.js";

const env = {
  PROVIDERS_JSON: Deno.env.get("PROVIDERS_JSON") ?? "",
  GATEWAY_KEY: Deno.env.get("GATEWAY_KEY") ?? "",
};

// 本地调试：deno run --allow-net --allow-env main.ts
Deno.serve((request) => worker.fetch(request, env));
