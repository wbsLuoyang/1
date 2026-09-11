/**
 * Cloudflare Worker 本地验证
 *   node tools/test-worker.mjs
 *
 * 直接调用 workers/index.js 的 fetch handler，模拟 Cloudflare 的运行环境。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const worker = (await import(pathToFileURL(path.join(ROOT, 'workers/index.js')).href)).default;

const localCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const GW = 'sk-luoy-test-key-12345';
const env = {
  PROVIDERS_JSON: JSON.stringify(localCfg.providers),
  GATEWAY_KEY: GW,
};

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name + (detail ? '  → ' + detail : '')); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '  → ' + detail : '')); }
}

async function call(pathname, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  if (opts.body) headers.set('Content-Type', 'application/json');
  const req = new Request('https://luoy-ai.example.workers.dev' + pathname, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return worker.fetch(req, env);
}

console.log('\n  Cloudflare Worker 本地验证');
console.log('  ==========================================\n');

console.log('  [1] 根路径与鉴权');
{
  const r = await worker.fetch(new Request('https://x.workers.dev/'), env);
  const j = await r.json();
  check('根路径返回用法说明', r.status === 200 && j.service === 'luoy-ai', j.service);
}
{
  const r = await call('/v1/models');
  check('不带凭证 → 401', r.status === 401, 'HTTP ' + r.status);
}
{
  const r = await call('/v1/models', { headers: { Authorization: 'Bearer wrong' } });
  check('错误密钥 → 401', r.status === 401, 'HTTP ' + r.status);
}
{
  const r = await call('/v1/models', { headers: { Authorization: 'Bearer ' } });
  check('空 Bearer → 401（不能放行）', r.status === 401, 'HTTP ' + r.status);
}

console.log('\n  [2] 模型列表');
let sampleModel = null;
let sampleProvider = null;
{
  const r = await call('/v1/models', { headers: { Authorization: 'Bearer ' + GW } });
  const j = await r.json();
  const ids = (j.data || []).map(function (m) { return m.id; });
  check('正确密钥可取列表', r.status === 200 && ids.length > 0, ids.length + ' 个模型');
  const providers = {};
  ids.forEach(function (id) { const p = id.split('/')[0]; providers[p] = (providers[p] || 0) + 1; });
  console.log('       分布: ' + JSON.stringify(providers));
  const chat = ids.filter(function (id) { return /flash|mini|lite/i.test(id); });
  sampleModel = chat[0] || ids[0];
  sampleProvider = sampleModel.split('/')[0];
  console.log('       抽样: ' + sampleModel);
}

console.log('\n  [3] 对话（流式透传）');
if (sampleModel) {
  const t0 = Date.now();
  const r = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + GW },
    body: {
      model: sampleModel,
      messages: [{ role: 'user', content: '只回答两个字：你好' }],
      stream: true,
    },
  });
  check('流式请求 200', r.status === 200, 'HTTP ' + r.status);
  check('Content-Type 是 SSE', (r.headers.get('Content-Type') || '').indexOf('text/event-stream') >= 0, r.headers.get('Content-Type'));

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let chunks = 0;
  let text = '';
  let reasoning = '';
  while (true) {
    const out = await reader.read();
    if (out.done) break;
    chunks++;
    buf += dec.decode(out.value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach(function (line) {
      const t = line.trim();
      if (t.indexOf('data:') !== 0) return;
      const d = t.slice(5).trim();
      if (!d || d === '[DONE]') return;
      try {
        const j = JSON.parse(d);
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        if (delta) {
          if (delta.content) text += delta.content;
          if (delta.reasoning_content) reasoning += delta.reasoning_content;
        }
      } catch (e) {}
    });
  }
  check('真正逐块流式', chunks > 1, chunks + ' 块，总耗时 ' + (Date.now() - t0) + 'ms');
  check('拿到内容', !!(text || reasoning), JSON.stringify((text || reasoning).slice(0, 40)));
} else {
  check('拿到可测模型', false, '列表为空');
}

console.log('\n  [4] 非流式 + 模型名解析');
{
  const r = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + GW },
    body: { model: 'labapi/gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 },
  });
  check('带前缀的模型名可用', r.status === 200, 'HTTP ' + r.status);
  if (r.status === 200) {
    const j = await r.json();
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    check('返回 choices', !!msg, msg ? JSON.stringify((msg.content || msg.reasoning_content || '').slice(0, 30)) : '无');
  }
}
{
  const r = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + GW },
    body: { model: 'no-such-model-xyz', messages: [] },
  });
  const j = await r.json();
  check('未知模型显式报错', r.status === 400 && /找不到模型/.test(j.error.message), j.error.message);
}

console.log('\n  [5] 配置缺失的处理');
{
  const r = await worker.fetch(
    new Request('https://x.workers.dev/v1/models', { headers: { Authorization: 'Bearer ' + GW } }),
    { GATEWAY_KEY: GW }
  );
  const j = await r.json();
  check('没配 PROVIDERS_JSON 时明确报错', r.status === 500 && /PROVIDERS_JSON/.test(j.error.message), j.error.message);
}

console.log('\n  ==========================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('  ==========================================\n');
process.exit(fail ? 1 : 0);
