/**
 * /api/* 路由（EdgeOne Makers Cloud Functions）
 *
 * 处理前端的全部接口请求。
 */
import * as core from '../_lib/core.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Hub-Token',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function withCors(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

export default async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // 去掉 /api 前缀，剩下的当作子路由
  let sub = url.pathname.replace(/^\/api/, '');
  if (sub.length > 1 && sub.endsWith('/')) sub = sub.replace(/\/+$/, '');
  if (!sub) sub = '/';

  const cfg = core.loadConfig(env);

  try {
    /* ---------- 免鉴权：状态探测 ---------- */
    if (sub === '/auth-status') {
      return withCors(
        core.json({
          enabled: !!cfg.password,
          authed: await core.isAuthed(cfg, request),
          providers: cfg.providers.length,
          configError: cfg.parseError || null,
        })
      );
    }

    /* ---------- 免鉴权：登录 ---------- */
    if (sub === '/login' && request.method === 'POST') {
      const { data, error } = await core.readJson(request);
      if (error) return withCors(core.json({ error: { message: error } }, 400));
      if (!cfg.password) return withCors(core.json({ ok: true, note: '未启用密码' }));

      const got = String((data && data.password) || '');
      const want = cfg.password;
      let same = got.length === want.length;
      if (same) {
        let diff = 0;
        for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
        same = diff === 0;
      }
      if (!same) return withCors(core.json({ error: { message: '密码不正确' } }, 401));

      const token = await core.tokenOf(want);
      return withCors(core.json({ ok: true, token }));
    }

    /* ---------- 以下接口需要密码 ---------- */
    if (!(await core.isAuthed(cfg, request))) {
      return withCors(core.json({ error: { message: '需要访问密码', code: 'unauthorized' } }, 401));
    }

    if (sub === '/providers' && request.method === 'GET') {
      const cache = await core.getModels(cfg, false);
      return withCors(
        core.json({ at: Date.now(), providers: core.publicProviders(cache, cfg), configError: cfg.parseError || null })
      );
    }

    if (sub === '/refresh' && request.method === 'POST') {
      const cache = await core.getModels(cfg, true);
      return withCors(core.json({ at: Date.now(), providers: core.publicProviders(cache, cfg) }));
    }

    if (sub === '/chat' && request.method === 'POST') {
      const { data: body, error } = await core.readJson(request);
      if (error) return withCors(core.json({ error: { message: error } }, 400));
      if (!body.providerId || !body.model) {
        return withCors(core.json({ error: { message: '缺少 providerId 或 model' } }, 400));
      }

      const messages = body.system && String(body.system).trim()
        ? [{ role: 'system', content: body.system }, ...(body.messages || [])]
        : body.messages || [];

      const payload = { model: body.model, messages, stream: body.stream !== false };
      if (body.temperature !== undefined && body.temperature !== null && body.temperature !== '') {
        payload.temperature = Number(body.temperature);
      }
      if (body.max_tokens !== undefined && body.max_tokens !== null && body.max_tokens !== '') {
        payload.max_tokens = Number(body.max_tokens);
      }

      const res = await core.relayChat(cfg, body.providerId, payload);
      return withCors(res);
    }

    return withCors(core.json({ error: { message: '未定义接口 ' + request.method + ' /api' + sub } }, 404));
  } catch (e) {
    return withCors(core.json({ error: { message: '服务端错误: ' + ((e && e.message) || e) } }, 500));
  }
}
