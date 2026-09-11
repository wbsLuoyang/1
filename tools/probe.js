/**
 * 端点连通性快速探测
 *
 * 密钥一律从 config.json 读取，绝不写死在代码里。
 * 用法：node tools/probe.js            （测 config.json 里的全部端点）
 *       node tools/probe.js labapi     （只测指定端点）
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const CFG_PATH = path.join(__dirname, '..', 'config.json');

let CFG;
try {
  CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
} catch (e) {
  console.error('读不到 config.json：' + e.message);
  console.error('先复制 config.example.json 为 config.json 并填入你的端点与密钥。');
  process.exit(1);
}

const only = process.argv[2];
const PROVIDERS = (CFG.providers || []).filter((p) => p.enabled !== false && (!only || p.id === only));

if (!PROVIDERS.length) {
  console.error(only ? 'config.json 里没有端点：' + only : 'config.json 里没有启用任何端点');
  process.exit(1);
}

/** 每个端点挑几个有代表性的模型来验证 */
function sampleModels(models) {
  if (!Array.isArray(models) || !models.length) return [];
  const prefer = models.filter((m) => /flash|mini|lite/i.test(m));
  const rest = models.filter((m) => !prefer.includes(m));
  return [...prefer.slice(0, 3), ...rest.slice(0, 2)];
}

function get(url, key) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Authorization: 'Bearer ' + key },
        timeout: 25000,
      },
      (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (e) => resolve({ status: 0, body: 'ERR: ' + e.message }));
    req.end();
  });
}

function post(url, key, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const started = Date.now();
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer ' + key,
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
        },
        timeout: 60000,
      },
      (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d, ms: Date.now() - started }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (e) => resolve({ status: 0, body: 'ERR: ' + e.message, ms: Date.now() - started }));
    req.write(payload, 'utf8');
    req.end();
  });
}

(async () => {
  for (const p of PROVIDERS) {
    console.log('\n################ ' + p.id + '  (' + p.name + ') ################');
    const r = await get(p.base + '/models', p.key);
    let models = [];
    try {
      const j = JSON.parse(r.body);
      models = (Array.isArray(j) ? j : j.data || []).map((m) => (typeof m === 'string' ? m : m.id));
    } catch (e) {
      /* 解析失败下面统一报 */
    }
    if (r.status !== 200) {
      console.log('  /models 失败 [' + r.status + '] ' + r.body.replace(/\s+/g, ' ').slice(0, 160));
      continue;
    }
    console.log('  /models OK，共 ' + models.length + ' 个模型');

    for (const m of sampleModels(models)) {
      const c = await post(p.base + '/chat/completions', p.key, {
        model: m,
        messages: [{ role: 'user', content: '只回答两个字：你好' }],
        max_tokens: 32,
      });
      if (c.status === 200) {
        let txt = '';
        try {
          const j = JSON.parse(c.body);
          const msg = j.choices?.[0]?.message || {};
          txt = msg.content || (msg.reasoning_content ? '[reasoning] ' + msg.reasoning_content.slice(0, 40) : '');
        } catch (e) {
          txt = 'PARSE_FAIL';
        }
        console.log('  [OK]   ' + m.padEnd(26) + String(c.ms).padStart(6) + 'ms  ' + JSON.stringify(txt.slice(0, 60)));
      } else {
        console.log('  [FAIL] ' + m.padEnd(26) + ' [' + c.status + '] ' + c.body.replace(/\s+/g, ' ').slice(0, 140));
      }
    }
  }
  console.log('');
})();
