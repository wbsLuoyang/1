/**
 * /v1/* —— OpenAI 兼容统一网关（EdgeOne Makers Cloud Functions）
 *
 * 用 GATEWAY_KEY 鉴权，模型名写 provider/model。
 * 注意：空 token 必须拒绝，不能放行。
 */
import * as core from '../_lib/core.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
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

  let sub = url.pathname.replace(/^\/v1/, '');
  if (sub.length > 1 && sub.endsWith('/')) sub = sub.replace(/\/+$/, '');
  if (!sub) sub = '/';

  const cfg = core.loadConfig(env);

  try {
    /* ---------- 网关鉴权（空 token 一律拒绝） ---------- */
    if (cfg.gatewayKey) {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      if (token !== cfg.gatewayKey) {
        return withCors(
          core.json(
            {
              error: {
                message: '网关密钥缺失或不正确。请在请求头带上 Authorization: Bearer <key>',
                type: 'invalid_api_key',
              },
            },
            401
          )
        );
      }
    }

    const cache = await core.getModels(cfg, false);

    /* ---------- 模型列表 ---------- */
    if ((sub === '/models' || sub === '/models/') && request.method === 'GET') {
      const data = [];
      for (const [pid, v] of Object.entries(cache)) {
        if (!v.ok) continue;
        for (const m of v.models) {
          data.push({ id: pid + '/' + m.id, object: 'model', created: 0, owned_by: pid });
        }
      }
      return withCors(core.json({ object: 'list', data }));
    }

    /* ---------- 对话 ---------- */
    if (sub === '/chat/completions' && request.method === 'POST') {
      const { data: body, error } = await core.readJson(request);
      if (error) return withCors(core.json({ error: { message: error } }, 400));

      const r = core.resolveModel(cache, body.model);
      if (r.error) return withCors(core.json({ error: { message: r.error } }, 400));

      const payload = { ...body, model: r.model, stream: body.stream === true };
      const res = await core.relayChat(cfg, r.providerId, payload);
      return withCors(res);
    }

    return withCors(core.json({ error: { message: '未定义接口 ' + request.method + ' /v1' + sub } }, 404));
  } catch (e) {
    return withCors(core.json({ error: { message: '服务端错误: ' + ((e && e.message) || e) } }, 500));
  }
}
