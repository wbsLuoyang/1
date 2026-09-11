/**
 * luoy-ai —— 多端点 AI 聚合中转（Cloudflare Worker 单文件版）
 *
 * 目标：一个地址 + 一个 key，调用所有模型
 *   Base URL:  https://<你的>.workers.dev/v1
 *   API Key:   <你自己设的 GATEWAY_KEY>
 *   模型名:    labapi/claude-opus-5  或  直接写模型名（唯一时自动路由）
 *
 * 环境变量（在 Cloudflare 控制台 Settings -> Variables 里加）：
 *   PROVIDERS_JSON   端点配置，JSON 数组
 *   GATEWAY_KEY      调用密钥，自己起，建议 sk- 开头
 *
 * 免费额度：每天 10 万次请求，个人用绰绰有余。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

const CACHE_TTL = 10 * 60 * 1000; // 模型列表缓存 10 分钟
let modelCache = { at: 0, key: '', data: null };

const IMG_RE = /image|dall-?e|flux|midjourney|sd-xl|stable-diffusion/i;
const NONCHAT_RE = /asr|tts|whisper|embed|rerank|moderation|voiceclone|voicedesign/i;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS),
  });
}

function classify(id) {
  if (NONCHAT_RE.test(id)) return 'audio';
  if (IMG_RE.test(id)) return 'image';
  return 'chat';
}

function loadConfig(env) {
  let providers = [];
  let error = null;
  const raw = env && env.PROVIDERS_JSON;
  if (!raw) {
    error = '没有配置环境变量 PROVIDERS_JSON';
  } else {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) providers = parsed;
      else error = 'PROVIDERS_JSON 必须是数组';
    } catch (e) {
      error = 'PROVIDERS_JSON 不是合法 JSON: ' + e.message;
    }
  }
  providers = providers.filter(function (p) {
    return p && p.id && p.base && p.key && p.enabled !== false;
  });
  return {
    providers: providers,
    gatewayKey: (env && env.GATEWAY_KEY) || '',
    error: error,
  };
}

function describeError(e) {
  const msg = (e && e.message) || String(e);
  const cause = e && e.cause;
  const code = cause && (cause.code || cause.message);
  if (msg === 'fetch failed' && code) return 'fetch failed (' + code + ')';
  return msg;
}

async function fetchModelsOf(p) {
  let lastError = '';
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await new Promise(function (r) { setTimeout(r, 700 * attempt); });
    try {
      const ctl = new AbortController();
      const timer = setTimeout(function () { ctl.abort(); }, 20000);
      let r;
      try {
        r = await fetch(p.base + '/models', {
          headers: { Authorization: 'Bearer ' + p.key },
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) {
        lastError = 'HTTP ' + r.status;
        if (r.status < 500) return { ok: false, error: lastError, models: [] };
        continue;
      }
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.data || []);
      const models = list.map(function (m) {
        const id = typeof m === 'string' ? m : m.id;
        return { id: id, kind: classify(id) };
      }).filter(function (m) { return m.id; });
      return { ok: true, models: models };
    } catch (e) {
      lastError = describeError(e);
    }
  }
  return { ok: false, error: lastError + '（已重试 2 次）', models: [] };
}

async function getModels(cfg, force) {
  const fp = JSON.stringify(cfg.providers.map(function (p) { return p.id + '|' + p.base; }));
  if (!force && modelCache.data && modelCache.key === fp && Date.now() - modelCache.at < CACHE_TTL) {
    return modelCache.data;
  }
  const out = {};
  const results = await Promise.all(cfg.providers.map(function (p) {
    return fetchModelsOf(p).then(function (r) {
      out[p.id] = { name: p.name || p.id, ok: r.ok, error: r.error || null, models: r.models };
    });
  }));
  modelCache = { at: Date.now(), key: fp, data: out };
  return out;
}

function resolveModel(cache, model) {
  const full = String(model || '');
  if (full.indexOf('/') > 0) {
    const i = full.indexOf('/');
    return { providerId: full.slice(0, i), model: full.slice(i + 1) };
  }
  const hits = [];
  Object.keys(cache).forEach(function (pid) {
    const v = cache[pid];
    if (v.ok && v.models.some(function (m) { return m.id === full; })) hits.push(pid);
  });
  if (hits.length === 1) return { providerId: hits[0], model: full };
  if (hits.length > 1) {
    return { error: '模型 ' + full + ' 在多个端点都存在，请写成 provider/model 指定：' + hits.join(' / ') };
  }
  return { error: '找不到模型 ' + full };
}

async function relayChat(cfg, providerId, payload) {
  const p = cfg.providers.filter(function (x) { return x.id === providerId; })[0];
  if (!p) return json({ error: { message: '未知端点: ' + providerId } }, 400);

  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 115000);

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
    return json({
      error: {
        message: '[' + p.id + '] 上游不可达: ' + describeError(e),
        type: 'upstream_unreachable',
        provider: p.id,
      },
    }, 502);
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    const t = await upstream.text().catch(function () { return ''; });
    return json({
      error: {
        message: '[' + p.id + '] 上游返回 ' + upstream.status,
        detail: t.slice(0, 2000),
        provider: p.id,
        model: payload.model,
      },
    }, upstream.status);
  }

  if (!payload.stream) {
    clearTimeout(timer);
    const text = await upstream.text();
    return new Response(text, {
      status: 200,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS),
    });
  }

  // 流式：直接透传上游 body，不做任何缓冲
  return new Response(upstream.body, {
    status: 200,
    headers: Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    }, CORS),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 兼容有人把 /v1 写在 base 里或直接访问根路径
    if (path === '/' || path === '') {
      return json({
        service: 'luoy-ai',
        usage: {
          models: 'GET /v1/models',
          chat: 'POST /v1/chat/completions',
          auth: 'Authorization: Bearer <GATEWAY_KEY>',
        },
      });
    }

    const cfg = loadConfig(env);

    if (cfg.error) {
      return json({ error: { message: cfg.error } }, 500);
    }

    // ---- 鉴权：空 token 也必须拒绝 ----
    if (cfg.gatewayKey) {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      if (token !== cfg.gatewayKey) {
        return json({
          error: {
            message: '密钥缺失或不正确。请求头需要带 Authorization: Bearer <你的 GATEWAY_KEY>',
            type: 'invalid_api_key',
          },
        }, 401);
      }
    }

    let sub = path.replace(/^\/v1/, '');
    if (sub.length > 1 && sub.charAt(sub.length - 1) === '/') sub = sub.replace(/\/+$/, '');
    if (!sub) sub = '/';

    try {
      const cache = await getModels(cfg, url.searchParams.get('refresh') === '1');

      // ---- 模型列表 ----
      if (sub === '/models' && request.method === 'GET') {
        const data = [];
        Object.keys(cache).forEach(function (pid) {
          const v = cache[pid];
          if (!v.ok) return;
          v.models.forEach(function (m) {
            data.push({ id: pid + '/' + m.id, object: 'model', created: 0, owned_by: pid });
          });
        });
        return json({ object: 'list', data: data });
      }

      // ---- 对话 ----
      if (sub === '/chat/completions' && request.method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return json({ error: { message: '请求体不是合法 JSON' } }, 400);
        }
        const r = resolveModel(cache, body.model);
        if (r.error) return json({ error: { message: r.error } }, 400);

        const payload = Object.assign({}, body, { model: r.model, stream: body.stream === true });
        return await relayChat(cfg, r.providerId, payload);
      }

      return json({ error: { message: '未定义接口 ' + request.method + ' ' + path } }, 404);
    } catch (e) {
      return json({ error: { message: '服务端错误: ' + describeError(e) } }, 500);
    }
  },
};
