/**
 * AI Hub —— 多端点模型聚合平台（本地后端）
 * 零依赖，只需 node server.js
 *
 * 职责：
 *   1. 托管前端静态页面
 *   2. 聚合各 provider 的模型列表（密钥只留在服务端，绝不下发前端）
 *   3. 代理聊天请求，透传 SSE 流
 *   4. 暴露一个 OpenAI 兼容统一网关 /v1/chat/completions
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CFG_PATH = path.join(ROOT, 'config.json');
const MODEL_CACHE_PATH = path.join(ROOT, 'models.cache.json');

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */
function loadConfig() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  } catch (e) {
    // 云部署时通常没有 config.json，全部靠环境变量注入
    console.log('[配置] 未读到 config.json（' + e.message + '），改用环境变量');
    c = {};
  }
  c.server = c.server || {};
  c.auth = c.auth || {};
  c.gateway = c.gateway || {};
  c.providers = Array.isArray(c.providers) ? c.providers : [];

  /* ---------- 环境变量优先，方便托管平台注入密钥 ---------- */
  if (process.env.PORT) c.server.port = Number(process.env.PORT);
  if (process.env.HOST) c.server.host = process.env.HOST;
  // 有 PORT 说明跑在托管平台/容器里，必须监听所有网卡，否则外面连不上
  else if (process.env.PORT) c.server.host = '0.0.0.0';

  if (process.env.AIHUB_AUTH_PASSWORD) {
    c.auth.enabled = true;
    c.auth.password = process.env.AIHUB_AUTH_PASSWORD;
  }
  if (process.env.AIHUB_AUTH_ENABLED === 'false') c.auth.enabled = false;
  if (process.env.AIHUB_GATEWAY_KEY) c.gateway.apiKey = process.env.AIHUB_GATEWAY_KEY;

  if (process.env.AIHUB_PROVIDERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.AIHUB_PROVIDERS_JSON);
      if (Array.isArray(parsed) && parsed.length) {
        c.providers = parsed;
        console.log('[配置] 已从 AIHUB_PROVIDERS_JSON 载入 ' + parsed.length + ' 个端点');
      } else {
        console.error('[配置] AIHUB_PROVIDERS_JSON 不是非空数组，已忽略');
      }
    } catch (e) {
      console.error('[配置] AIHUB_PROVIDERS_JSON 解析失败，已忽略：' + e.message);
    }
  }

  return c;
}
let CONFIG = loadConfig();

const PORT = (CONFIG.server && CONFIG.server.port) || 8899;
const HOST = (CONFIG.server && CONFIG.server.host) || '127.0.0.1';

const IMG_RE = /image|dall-?e|flux|midjourney|sd-xl|stable-diffusion/i;
const NONCHAT_RE = /asr|tts|whisper|embed|rerank|moderation|voiceclone|voicedesign/i;

function classify(id) {
  if (NONCHAT_RE.test(id)) return 'audio';
  if (IMG_RE.test(id)) return 'image';
  return 'chat';
}

/* ------------------------------------------------------------------ */
/* 访问密码                                                            */
/* ------------------------------------------------------------------ */
const AUTH_COOKIE = 'hub_token';

function authEnabled() {
  const a = CONFIG.auth || {};
  return a.enabled !== false && !!(a.password && String(a.password).length);
}
/** 不存明文，cookie 里放派生值 */
function tokenOf(pw) {
  return crypto.createHash('sha256').update('aihub::' + String(pw)).digest('hex').slice(0, 40);
}
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function isAuthed(req) {
  if (!authEnabled()) return true;
  const want = tokenOf((CONFIG.auth || {}).password);
  // 前端走 Header（部署到 Serverless 平台时更可靠），同时兼容 Cookie 方式
  if (safeEq(req.headers['x-hub-token'], want)) return true;
  return safeEq(parseCookies(req.headers.cookie || '')[AUTH_COOKIE], want);
}
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push({ name, address: i.address });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJSON(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 带超时的上游请求 */
async function upstreamFetch(url, opts, timeoutMs = 180000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('上游超时(' + timeoutMs + 'ms)')), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 模型列表聚合                                                        */
/* ------------------------------------------------------------------ */
let modelCache = { at: 0, providers: {} };

function loadModelCache() {
  try {
    const c = JSON.parse(fs.readFileSync(MODEL_CACHE_PATH, 'utf8'));
    if (c && c.providers) modelCache = c;
  } catch (e) {
    /* 首次运行无缓存，忽略 */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把 fetch 的模糊错误还原成可读原因 */
function describeError(e) {
  const msg = (e && e.message) || String(e);
  const cause = e && e.cause;
  const code = cause && (cause.code || cause.message);
  if (msg === 'fetch failed' && code) return 'fetch failed (' + code + ')';
  return msg + (code && msg.indexOf(String(code)) < 0 ? ' (' + code + ')' : '');
}

/**
 * 拉取单个端点的模型列表。
 * 网络抖动很常见（服务刚启动时尤其明显），所以内置重试，
 * 避免一次瞬时失败被缓存成"端点不可用"而必须手动刷新。
 */
async function fetchProviderModels(p, timeoutMs = 20000, retries = 2) {
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(700 * attempt);
    try {
      const r = await upstreamFetch(
        p.base + '/models',
        { method: 'GET', headers: { Authorization: 'Bearer ' + p.key } },
        timeoutMs
      );
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        lastError = 'HTTP ' + r.status + ' ' + t.slice(0, 160);
        // 4xx 多半是密钥或地址问题，重试没意义
        if (r.status < 500) return { ok: false, error: lastError, models: [] };
        continue;
      }
      const j = await r.json();
      const list = Array.isArray(j) ? j : j.data || [];
      const models = list
        .map((m) => ({
          id: typeof m === 'string' ? m : m.id,
          owner: (m && m.owned_by) || '',
          kind: classify(typeof m === 'string' ? m : m.id),
        }))
        .filter((m) => m.id);
      return { ok: true, models };
    } catch (e) {
      lastError = describeError(e);
    }
  }
  return { ok: false, error: lastError + (retries ? '（已重试 ' + retries + ' 次）' : ''), models: [] };
}

async function refreshModels() {
  const out = {};
  await Promise.all(
    CONFIG.providers
      .filter((p) => p.enabled !== false)
      .map(async (p) => {
        const r = await fetchProviderModels(p);
        out[p.id] = { name: p.name, base: p.base, ok: r.ok, error: r.error || null, models: r.models };
      })
  );
  modelCache = { at: Date.now(), providers: out };
  try {
    fs.writeFileSync(MODEL_CACHE_PATH, JSON.stringify(modelCache, null, 2), 'utf8');
  } catch (e) {
    console.error('写入模型缓存失败: ' + e.message);
  }
  return modelCache;
}

/** 启动时：先用缓存秒开，再后台刷新 */
async function refreshModelsInBackground() {
  await refreshModels();
  const total = Object.values(modelCache.providers).reduce((n, p) => n + p.models.length, 0);
  console.log('[模型] 已刷新，共 ' + total + ' 个模型');
  for (const [id, p] of Object.entries(modelCache.providers)) {
    console.log('   ' + (p.ok ? '✓' : '✗') + ' ' + id.padEnd(10) + ' ' + (p.ok ? p.models.length + ' 个模型' : p.error));
  }
}

/* ------------------------------------------------------------------ */
/* 聊天代理                                                            */
/* ------------------------------------------------------------------ */
function resolveProvider(id) {
  return CONFIG.providers.find((p) => p.id === id);
}

/**
 * 核心转发：把请求打到上游，流式或非流式回传。
 * @param {{providerId:string, payload:object, wantStream:boolean, res:http.ServerResponse, clientReq:http.IncomingMessage}} o
 */
async function relayChat({ providerId, payload, res, clientReq }) {
  const p = resolveProvider(providerId);
  if (!p) {
    sendJSON(res, 400, { error: { message: '未知的 provider: ' + providerId } });
    return;
  }

  let upstream;
  try {
    upstream = await upstreamFetch(p.base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer ' + p.key,
        Accept: payload.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // 上游连不上：显式报错，不静默
    sendJSON(res, 502, {
      error: {
        message: '[' + p.id + '] 上游不可达: ' + (e.message || e),
        type: 'upstream_unreachable',
        provider: p.id,
      },
    });
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    if (!res.headersSent) {
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(
      JSON.stringify({
        error: {
          message: '[' + p.id + '] 上游返回 ' + upstream.status,
          detail: text.slice(0, 2000),
          provider: p.id,
          model: payload.model,
        },
      })
    );
    return;
  }

  if (!payload.stream) {
    const text = await upstream.text();
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
    return;
  }

  // ---- 流式透传 ----
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let closed = false;

  const onClose = () => {
    closed = true;
    try {
      reader.cancel();
    } catch (e) {}
  };
  clientReq.on('close', onClose);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      res.write(Buffer.from(value));
    }
  } catch (e) {
    if (!closed) {
      res.write('data: ' + JSON.stringify({ error: { message: '流中断: ' + (e.message || e) } }) + '\n\n');
    }
  } finally {
    clientReq.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  // CORS：允许本地其它工具调用统一网关
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    /* ---------- 访问密码 ---------- */
    if (p === '/api/auth-status' && req.method === 'GET') {
      sendJSON(res, 200, { enabled: authEnabled(), authed: isAuthed(req) });
      return;
    }

    if (p === '/api/login' && req.method === 'POST') {
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (e) {
        sendJSON(res, 400, { error: { message: '请求体不是合法 JSON' } });
        return;
      }
      if (!authEnabled()) {
        sendJSON(res, 200, { ok: true, note: '未启用密码' });
        return;
      }
      const want = String((CONFIG.auth || {}).password);
      const got = String(body.password == null ? '' : body.password);
      const okLen = got.length === want.length;
      const okVal = okLen && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
      if (!okVal) {
        console.warn('  [访问] 密码错误，来自 ' + (req.socket.remoteAddress || '?'));
        sendJSON(res, 401, { error: { message: '密码不正确' } });
        return;
      }
      res.setHeader(
        'Set-Cookie',
        AUTH_COOKIE + '=' + tokenOf(want) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'
      );
      // 同时返回 token，前端用它做 X-Hub-Token 头鉴权
      sendJSON(res, 200, { ok: true, token: tokenOf(want) });
      return;
    }

    if (p === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', AUTH_COOKIE + '=; Path=/; HttpOnly; Max-Age=0');
      sendJSON(res, 200, { ok: true });
      return;
    }

    // 其余 /api/* 一律需要密码
    if (p.startsWith('/api/') && !isAuthed(req)) {
      sendJSON(res, 401, { error: { message: '需要访问密码', code: 'unauthorized' } });
      return;
    }

    /* ---------- 前端用的 API ---------- */
    if (p === '/api/providers' && req.method === 'GET') {
      const provs = Object.entries(modelCache.providers).map(([id, v]) => ({
        id,
        name: v.name,
        ok: v.ok,
        error: v.error,
        models: v.models,
      }));
      sendJSON(res, 200, { at: modelCache.at, providers: provs });
      return;
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      const c = await refreshModels();
      const provs = Object.entries(c.providers).map(([id, v]) => ({
        id,
        name: v.name,
        ok: v.ok,
        error: v.error,
        models: v.models,
      }));
      sendJSON(res, 200, { at: c.at, providers: provs });
      return;
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch (e) {
        sendJSON(res, 400, { error: { message: '请求体不是合法 JSON' } });
        return;
      }
      const { providerId, model, messages, temperature, max_tokens, top_p, system, stream } = body;
      if (!providerId || !model) {
        sendJSON(res, 400, { error: { message: '缺少 providerId 或 model' } });
        return;
      }
      const finalMessages = system && system.trim() ? [{ role: 'system', content: system }, ...(messages || [])] : messages || [];
      const payload = { model, messages: finalMessages, stream: stream !== false };
      if (temperature !== undefined && temperature !== null && temperature !== '') payload.temperature = Number(temperature);
      if (max_tokens !== undefined && max_tokens !== null && max_tokens !== '') payload.max_tokens = Number(max_tokens);
      if (top_p !== undefined && top_p !== null && top_p !== '') payload.top_p = Number(top_p);
      await relayChat({ providerId, payload, res, clientReq: req });
      return;
    }

    if (p === '/api/config-reload' && req.method === 'POST') {
      CONFIG = loadConfig();
      const c = await refreshModels();
      sendJSON(res, 200, { ok: true, providers: Object.keys(c.providers) });
      return;
    }

    /* ---------- OpenAI 兼容统一网关 ---------- */
    // 网关下所有路径统一鉴权：注意空 token 也必须拒绝，否则不带 Authorization 头就能白用
    if (p === '/v1' || p.startsWith('/v1/')) {
      const gw = CONFIG.gateway || {};
      if (gw.enabled !== false && gw.apiKey) {
        const auth = req.headers.authorization || '';
        const token = auth.replace(/^Bearer\s+/i, '').trim();
        if (token !== String(gw.apiKey)) {
          sendJSON(res, 401, {
            error: {
              message: '网关密钥缺失或不正确。请在请求头带上 Authorization: Bearer <apiKey>',
              type: 'invalid_api_key',
            },
          });
          return;
        }
      }
    }

    if (p === '/v1/models' && req.method === 'GET') {
      const data = [];
      for (const [pid, v] of Object.entries(modelCache.providers)) {
        if (!v.ok) continue;
        for (const m of v.models) {
          data.push({ id: pid + '/' + m.id, object: 'model', created: 0, owned_by: pid });
        }
      }
      sendJSON(res, 200, { object: 'list', data });
      return;
    }

    if (p === '/v1/chat/completions' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch (e) {
        sendJSON(res, 400, { error: { message: '请求体不是合法 JSON' } });
        return;
      }
      // 模型名格式：provider/model；不带前缀时全端点搜索唯一匹配
      let providerId, model;
      const full = String(body.model || '');
      if (full.includes('/')) {
        const idx = full.indexOf('/');
        providerId = full.slice(0, idx);
        model = full.slice(idx + 1);
      } else {
        const hits = [];
        for (const [pid, v] of Object.entries(modelCache.providers)) {
          if (v.ok && v.models.some((m) => m.id === full)) hits.push(pid);
        }
        if (hits.length === 1) {
          providerId = hits[0];
          model = full;
        } else if (hits.length > 1) {
          sendJSON(res, 400, {
            error: { message: '模型 ' + full + ' 在多个端点存在，请用 provider/model 指定：' + hits.join(', ') },
          });
          return;
        } else {
          sendJSON(res, 404, { error: { message: '找不到模型 ' + full } });
          return;
        }
      }
      const payload = { ...body, model, stream: body.stream === true };
      await relayChat({ providerId, payload, res, clientReq: req });
      return;
    }

    /* ---------- 静态页面 ---------- */
    if (req.method === 'GET') {
      serveStatic(req, res, p);
      return;
    }

    sendJSON(res, 404, { error: { message: '未定义路由 ' + req.method + ' ' + p } });
  } catch (e) {
    console.error('[服务器错误]', e);
    if (!res.headersSent) sendJSON(res, 500, { error: { message: String(e.message || e) } });
    else res.end();
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
loadModelCache();
server.listen(PORT, HOST, () => {
  const n = CONFIG.providers.filter((p) => p.enabled !== false).length;
  const anyHost = HOST === '0.0.0.0' || HOST === '::';
  console.log('');
  console.log('  AI Hub 已启动');
  console.log('  ------------------------------------------');
  console.log('  控制台   http://127.0.0.1:' + PORT);
  if (anyHost) {
    const ips = lanAddresses();
    if (ips.length) {
      console.log('  局域网   ' + ips.map((i) => 'http://' + i.address + ':' + PORT).join('\n           '));
      console.log('           （手机/平板连同一个 WiFi 即可打开）');
    } else {
      console.log('  局域网   未检测到内网网卡');
    }
  } else {
    console.log('  监听     ' + HOST + ' —— 仅本机可访问，如需多设备请把 config.json 的 server.host 改为 0.0.0.0');
  }
  console.log('  网关     /v1/chat/completions');
  console.log('  端点     ' + n + ' 个已启用');
  if (authEnabled()) {
    const pw = String((CONFIG.auth || {}).password);
    console.log('  访问密码 已开启（当前：' + pw + '）');
    if (pw === 'hub-8899') {
      console.log('           ⚠ 这是默认密码，暴露到公网前请务必在 config.json 里改掉');
    }
  } else {
    console.log('  访问密码 ✗ 未设置 —— 任何能访问到此地址的人都能用掉你的额度');
  }
  if (modelCache.at) {
    console.log('  模型缓存 ' + new Date(modelCache.at).toLocaleString() + '（正在后台刷新…）');
  }
  console.log('');
  refreshModelsInBackground().catch((e) => console.error('[模型刷新失败] ' + e.message));
});

process.on('SIGINT', () => {
  console.log('\n已停止。');
  process.exit(0);
});
