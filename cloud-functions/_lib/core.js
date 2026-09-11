/**
 * AI Hub 核心逻辑（EdgeOne Makers Cloud Functions 版）
 *
 * 与本地 server.js 的区别：
 *   - 配置全部来自环境变量（控制台配置），不读文件
 *   - 无状态，模型列表用模块级内存缓存（实例复用期间有效）
 *   - 返回标准 Web Response，流式直接透传上游 ReadableStream
 */

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */
export function loadConfig(env) {
  const e = env || {};
  let providers = [];
  let parseError = null;

  if (e.PROVIDERS_JSON || e.AIHUB_PROVIDERS_JSON) {
    const raw = e.PROVIDERS_JSON || e.AIHUB_PROVIDERS_JSON;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) providers = parsed;
      else parseError = 'PROVIDERS_JSON 不是数组';
    } catch (err) {
      parseError = 'PROVIDERS_JSON 解析失败: ' + err.message;
    }
  } else {
    parseError = '未配置环境变量 PROVIDERS_JSON';
  }

  return {
    providers: providers.filter((p) => p && p.id && p.base && p.key && p.enabled !== false),
    password: e.AUTH_PASSWORD || e.AIHUB_AUTH_PASSWORD || '',
    gatewayKey: e.GATEWAY_KEY || e.AIHUB_GATEWAY_KEY || '',
    parseError,
  };
}

const IMG_RE = /image|dall-?e|flux|midjourney|sd-xl|stable-diffusion/i;
const NONCHAT_RE = /asr|tts|whisper|embed|rerank|moderation|voiceclone|voicedesign/i;

export function classify(id) {
  if (NONCHAT_RE.test(id)) return 'audio';
  if (IMG_RE.test(id)) return 'image';
  return 'chat';
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function tokenOf(password) {
  const data = new TextEncoder().encode('aihub::' + String(password));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 校验访问密码；未配置密码时放行 */
export async function isAuthed(cfg, request) {
  if (!cfg.password) return true;
  const got = request.headers.get('X-Hub-Token') || '';
  const want = await tokenOf(cfg.password);
  return timingSafeEqualStr(got, want);
}

/* ------------------------------------------------------------------ */
/* 模型列表（带内存缓存）                                               */
/* ------------------------------------------------------------------ */
const CACHE_TTL = 10 * 60 * 1000;
let modelCache = { at: 0, fingerprint: '', providers: null };

function fingerprintOf(cfg) {
  return cfg.providers.map((p) => p.id + '|' + p.base).join(',');
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

/** 拉取单个端点的模型列表，带重试（瞬时抖动不该被记成"端点不可用"） */
async function fetchProviderModels(p, retries = 2) {
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(700 * attempt);
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      let r;
      try {
        r = await fetch(p.base + '/models', {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + p.key },
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
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
        .map((m) => {
          const id = typeof m === 'string' ? m : m.id;
          return { id, owner: (m && m.owned_by) || '', kind: classify(id) };
        })
        .filter((m) => m.id);
      return { ok: true, models };
    } catch (e) {
      lastError = describeError(e);
    }
  }
  return { ok: false, error: lastError + (retries ? '（已重试 ' + retries + ' 次）' : ''), models: [] };
}

export async function getModels(cfg, force) {
  const fp = fingerprintOf(cfg);
  const fresh = modelCache.providers && modelCache.fingerprint === fp && Date.now() - modelCache.at < CACHE_TTL;
  if (fresh && !force) return modelCache.providers;

  const out = {};
  await Promise.all(
    cfg.providers.map(async (p) => {
      const r = await fetchProviderModels(p);
      out[p.id] = { name: p.name || p.id, base: p.base, ok: r.ok, error: r.error || null, models: r.models };
    })
  );
  modelCache = { at: Date.now(), fingerprint: fp, providers: out };
  return out;
}

/** 给前端用的精简结构 */
export function publicProviders(cache, cfg) {
  return cfg.providers.map((p) => {
    const v = cache[p.id] || { ok: false, error: '未探测', models: [] };
    return { id: p.id, name: v.name || p.id, ok: v.ok, error: v.error, models: v.models };
  });
}

/* ------------------------------------------------------------------ */
/* 聊天代理                                                            */
/* ------------------------------------------------------------------ */
export async function relayChat(cfg, providerId, payload) {
  const p = cfg.providers.find((x) => x.id === providerId);
  if (!p) return json({ error: { message: '未知端点: ' + providerId } }, 400);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 115000);

  let upstream;
  try {
    upstream = await fetch(p.base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer ' + p.key,
        Accept: payload.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return json(
      {
        error: {
          message: '[' + p.id + '] 上游不可达: ' + ((e && e.message) || e),
          type: 'upstream_unreachable',
          provider: p.id,
        },
      },
      502
    );
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    const t = await upstream.text().catch(() => '');
    return json(
      {
        error: {
          message: '[' + p.id + '] 上游返回 ' + upstream.status,
          detail: t.slice(0, 2000),
          provider: p.id,
          model: payload.model,
        },
      },
      upstream.status
    );
  }

  if (!payload.stream) {
    clearTimeout(timer);
    const text = await upstream.text();
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }

  // 流式：直接透传上游 body，避免任何缓冲
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}

/* ------------------------------------------------------------------ */
/* 模型名解析（统一网关用）                                             */
/* ------------------------------------------------------------------ */
export function resolveModel(cache, model) {
  const full = String(model || '');
  if (full.includes('/')) {
    const i = full.indexOf('/');
    return { providerId: full.slice(0, i), model: full.slice(i + 1) };
  }
  const hits = [];
  for (const [pid, v] of Object.entries(cache)) {
    if (v.ok && v.models.some((m) => m.id === full)) hits.push(pid);
  }
  if (hits.length === 1) return { providerId: hits[0], model: full };
  if (hits.length > 1) return { error: '模型 ' + full + ' 在多个端点存在，请写 provider/model：' + hits.join(', ') };
  return { error: '找不到模型 ' + full };
}

/** 读取并解析 JSON 请求体 */
export async function readJson(request) {
  try {
    return { data: await request.json() };
  } catch (e) {
    return { error: '请求体不是合法 JSON' };
  }
}
