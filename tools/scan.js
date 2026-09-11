/**
 * 全端点模型可用性扫描
 *
 * 密钥一律从 config.json 读取，绝不写死在代码里。
 * 用法：node tools/scan.js
 * 产物：tools/scan.json（只含模型名与耗时，不含任何密钥，可安全提交）
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

const PROVIDERS = (CFG.providers || []).filter((p) => p.enabled !== false);
if (!PROVIDERS.length) {
  console.error('config.json 里没有启用任何端点');
  process.exit(1);
}

const IMG_RE = /image|dall-?e|flux|midjourney|sd-xl|stable-diffusion/i;
const NONCHAT_RE = /asr|tts|whisper|embed|rerank|moderation|voiceclone|voicedesign/i;

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
          Accept: body.stream ? 'text/event-stream' : 'application/json',
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

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length || 1) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

(async () => {
  const report = { scannedAt: new Date().toISOString(), providers: {} };

  for (const p of PROVIDERS) {
    console.log('\n################ ' + p.id + '  (' + p.name + ') ################');
    const lr = await get(p.base + '/models', p.key);
    let ids = [];
    try {
      ids = (JSON.parse(lr.body).data || []).map((m) => m.id);
    } catch (e) {
      console.log('  /models 解析失败: ' + lr.body.slice(0, 150));
      report.providers[p.id] = { reachable: false, error: lr.body.slice(0, 200) };
      continue;
    }
    console.log('  /models OK，共 ' + ids.length + ' 个模型');

    const candidates = ids.filter((id) => !IMG_RE.test(id) && !NONCHAT_RE.test(id));
    const skipped = ids.filter((id) => IMG_RE.test(id) || NONCHAT_RE.test(id));

    const results = await pool(candidates, 6, async (id) => {
      const r = await post(p.base + '/chat/completions', p.key, {
        model: id,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
      });
      let verdict = 'FAIL';
      let note = r.body.replace(/\s+/g, ' ').slice(0, 120);
      if (r.status === 200) {
        try {
          const j = JSON.parse(r.body);
          if (j.choices) {
            verdict = 'OK';
            note = 'model=' + j.model;
          }
        } catch (e) {}
      }
      return { id, verdict, note, ms: r.ms };
    });

    results.sort((a, b) => (a.verdict === b.verdict ? a.id.localeCompare(b.id) : a.verdict === 'OK' ? -1 : 1));
    for (const r of results) {
      console.log('  [' + r.verdict + '] ' + r.id.padEnd(26) + String(r.ms).padStart(6) + 'ms  ' + r.note);
    }

    const firstOk = results.find((r) => r.verdict === 'OK');
    let streamInfo = null;
    if (firstOk) {
      const s = await post(p.base + '/chat/completions', p.key, {
        model: firstOk.id,
        messages: [{ role: 'user', content: '从1数到5' }],
        stream: true,
      });
      const lines = s.body.split('\n').filter((l) => l.trim().startsWith('data:'));
      streamInfo = { model: firstOk.id, status: s.status, sse_lines: lines.length, hasDone: s.body.includes('[DONE]'), ms: s.ms };
      console.log('  >> 流式: ' + JSON.stringify(streamInfo));
    }

    report.providers[p.id] = {
      reachable: true,
      base: p.base,
      chat_ok: results.filter((r) => r.verdict === 'OK').map((r) => r.id),
      chat_fail: results.filter((r) => r.verdict !== 'OK').map((r) => ({ id: r.id, note: r.note })),
      non_chat: skipped,
      all: ids,
      stream: streamInfo,
    };
  }

  const out = path.join(__dirname, 'scan.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log('\n===== 汇总 =====');
  for (const [k, v] of Object.entries(report.providers)) {
    console.log('  ' + k + ': ' + (v.reachable ? 'OK，chat 可用 ' + v.chat_ok.length + ' 个' : '不可达'));
  }
  console.log('已写入 tools/scan.json');
})();
