/**
 * EdgeOne 函数本地验证
 *   node tools/test-edgeone.mjs
 *
 * 直接用 Node 调用 cloud-functions 里的 handler，模拟 EdgeOne 的 context，
 * 验证路由、鉴权、模型聚合、流式代理是否正常。部署前先跑这个。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Windows 上动态 import 绝对路径必须先转成 file:// URL
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const apiHandler = (await load('cloud-functions/api/[[default]].js')).default;
const v1Handler = (await load('cloud-functions/v1/[[default]].js')).default;

/* 用本地 config.json 构造 EdgeOne 的环境变量 */
const localCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const env = {
  PROVIDERS_JSON: JSON.stringify(localCfg.providers),
  AUTH_PASSWORD: localCfg.auth.password,
  GATEWAY_KEY: localCfg.gateway.apiKey,
};

const PW = localCfg.auth.password;
const GW = localCfg.gateway.apiKey;

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name + (detail ? '  → ' + detail : ''));
  } else {
    fail++;
    console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '  → ' + detail : ''));
  }
}

async function call(handler, urlPath, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (opts.body) headers.set('Content-Type', 'application/json');
  const req = new Request('https://example.edgeone.run' + urlPath, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handler({ request: req, env, params: {} });
  return res;
}

console.log('\n  EdgeOne 函数本地验证');
console.log('  ==========================================\n');

/* ---------- 1. 状态与登录 ---------- */
console.log('  [1] 鉴权');
{
  const r = await call(apiHandler, '/api/auth-status');
  const j = await r.json();
  check('auth-status 未登录时 authed=false', r.status === 200 && j.authed === false, 'enabled=' + j.enabled);
  check('配置解析无错误', !j.configError, j.configError || 'ok');
}
{
  const r = await call(apiHandler, '/api/login', { method: 'POST', body: { password: 'wrong-pw' } });
  check('错误密码被拒', r.status === 401, 'HTTP ' + r.status);
}
let token = '';
{
  const r = await call(apiHandler, '/api/login', { method: 'POST', body: { password: PW } });
  const j = await r.json();
  token = j.token || '';
  check('正确密码返回 token', r.status === 200 && token.length === 40, 'token ' + token.slice(0, 10) + '…');
}
{
  const r = await call(apiHandler, '/api/providers');
  check('无 token 访问受保护接口 → 401', r.status === 401, 'HTTP ' + r.status);
}
{
  const r = await call(apiHandler, '/api/providers', { headers: { 'X-Hub-Token': 'deadbeef'.repeat(5) } });
  check('伪造 token → 401', r.status === 401, 'HTTP ' + r.status);
}

/* ---------- 2. 模型聚合 ---------- */
console.log('\n  [2] 模型聚合');
let providers = [];
{
  const r = await call(apiHandler, '/api/providers', { headers: { 'X-Hub-Token': token } });
  const j = await r.json();
  providers = j.providers || [];
  const okN = providers.filter((p) => p.ok).length;
  const total = providers.reduce((n, p) => n + p.models.length, 0);
  check('带 token 可取模型列表', r.status === 200 && providers.length > 0, okN + '/' + providers.length + ' 端点在线，' + total + ' 个模型');
  for (const p of providers) {
    console.log('       ' + (p.ok ? '✓' : '✗') + ' ' + p.id.padEnd(10) + (p.ok ? p.models.length + ' 个模型' : p.error));
  }
}

/* ---------- 3. 聊天（流式） ---------- */
console.log('\n  [3] 聊天代理');
const chatProvider = providers.find((p) => p.ok && p.models.some((m) => m.kind === 'chat'));
if (chatProvider) {
  const model = (chatProvider.models.find((m) => m.kind === 'chat' && /flash|mini|lite/i.test(m.id)) || chatProvider.models.find((m) => m.kind === 'chat')).id;
  const t0 = Date.now();
  const r = await call(apiHandler, '/api/chat', {
    method: 'POST',
    headers: { 'X-Hub-Token': token },
    body: { providerId: chatProvider.id, model, messages: [{ role: 'user', content: '只回答两个字：你好' }], stream: true },
  });
  check('流式请求返回 200', r.status === 200, 'HTTP ' + r.status);
  check('Content-Type 是 SSE', (r.headers.get('Content-Type') || '').includes('text/event-stream'), r.headers.get('Content-Type'));
  check('响应体是 ReadableStream', r.body && typeof r.body.getReader === 'function');

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let chunks = 0;
  let text = '';
  let reasoning = '';
  const started = Date.now();
  let firstChunkAt = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstChunkAt) firstChunkAt = Date.now();
    chunks++;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const d = t.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      try {
        const j = JSON.parse(d);
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        if (delta) {
          if (delta.content) text += delta.content;
          if (delta.reasoning_content) reasoning += delta.reasoning_content;
        }
      } catch (e) {}
    }
  }
  check('真正逐块流式（非一次性返回）', chunks > 1, chunks + ' 个数据块');
  check('收到内容', !!(text || reasoning), JSON.stringify((text || reasoning).slice(0, 40)));
  console.log('       首块延迟 ' + (firstChunkAt - started) + 'ms，总耗时 ' + (Date.now() - t0) + 'ms');
} else {
  check('找到可用对话端点', false, '没有在线端点');
}

/* ---------- 4. 统一网关 ---------- */
console.log('\n  [4] 统一网关 /v1');
{
  const r = await call(v1Handler, '/v1/models');
  check('无凭证访问 /v1/models → 401', r.status === 401, 'HTTP ' + r.status);
}
{
  const r = await call(v1Handler, '/v1/models', { headers: { Authorization: 'Bearer wrong-key' } });
  check('错误网关密钥 → 401', r.status === 401, 'HTTP ' + r.status);
}
{
  const r = await call(v1Handler, '/v1/models', { headers: { Authorization: 'Bearer ' + GW } });
  const j = await r.json();
  check('正确密钥可取模型列表', r.status === 200 && (j.data || []).length > 0, (j.data || []).length + ' 个模型');
  const sample = (j.data || []).slice(0, 3).map((m) => m.id);
  if (sample.length) console.log('       例: ' + sample.join(', '));
}
{
  const r = await call(v1Handler, '/v1/models', { headers: { Authorization: 'Bearer ' } });
  check('空 Bearer token → 401（不能放行）', r.status === 401, 'HTTP ' + r.status);
}
if (chatProvider) {
  const model = (chatProvider.models.find((m) => m.kind === 'chat' && /flash|mini|lite/i.test(m.id)) || chatProvider.models.find((m) => m.kind === 'chat')).id;
  const r = await call(v1Handler, '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + GW },
    body: { model: chatProvider.id + '/' + model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 },
  });
  check('网关非流式对话', r.status === 200, 'HTTP ' + r.status);
  if (r.status === 200) {
    const j = await r.json().catch(() => null);
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    check('返回了 choices', !!msg, msg ? JSON.stringify((msg.content || msg.reasoning_content || '').slice(0, 30)) : '无');
  }
}

/* ---------- 5. 错误处理 ---------- */
console.log('\n  [5] 错误处理');
{
  const r = await call(apiHandler, '/api/chat', {
    method: 'POST',
    headers: { 'X-Hub-Token': token },
    body: { providerId: 'nonexistent', model: 'x', messages: [] },
  });
  const j = await r.json();
  check('未知端点显式报错', r.status === 400 && /未知端点/.test(j.error.message), j.error.message);
}
{
  const r = await call(apiHandler, '/api/chat', { method: 'POST', headers: { 'X-Hub-Token': token }, body: { providerId: 'x' } });
  const j = await r.json();
  check('缺参数报错', r.status === 400, j.error.message);
}
{
  const r = await call(v1Handler, '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + GW },
    body: { model: 'no-such-model-xyz', messages: [] },
  });
  const j = await r.json();
  check('网关未知模型报错', r.status === 400 && /找不到模型/.test(j.error.message), j.error.message);
}
{
  const r = await call(apiHandler, '/api/nothing-here', { headers: { 'X-Hub-Token': token } });
  check('已登录时未知接口 → 404', r.status === 404, 'HTTP ' + r.status);
}
{
  const r = await call(apiHandler, '/api/nothing-here');
  check('未登录时未知接口 → 401（鉴权先于路由）', r.status === 401, 'HTTP ' + r.status);
}

/* ---------- 6. 重试机制 ---------- */
console.log('\n  [6] 端点失败重试');
{
  const core = await load('cloud-functions/_lib/core.js');
  const badEnv = Object.assign({}, env, {
    PROVIDERS_JSON: JSON.stringify([
      { id: 'bad', name: 'Bad', base: 'https://nonexistent-host-xyz-12345.invalid/v1', key: 'sk-fake' },
    ]),
  });
  const badCfg = core.loadConfig(badEnv);
  const t0 = Date.now();
  const cache = await core.getModels(badCfg, true);
  const elapsed = Date.now() - t0;
  check('坏端点不崩溃，返回错误对象', cache.bad && cache.bad.ok === false, cache.bad && cache.bad.error);
  check('错误信息标明已重试', /已重试/.test((cache.bad && cache.bad.error) || ''), '耗时 ' + elapsed + 'ms');
  check('错误信息带根因（非裸 fetch failed）', /ENOTFOUND|EAI_AGAIN|fetch failed/.test((cache.bad && cache.bad.error) || ''), (cache.bad && cache.bad.error) || '');
}

/* ---------- 汇总 ---------- */
console.log('\n  ==========================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('  ==========================================\n');
process.exit(fail ? 1 : 0);
