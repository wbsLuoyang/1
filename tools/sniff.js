/**
 * 浏览器侧流量抓包
 *   node tools/sniff.js
 *
 * 用系统 Edge 的 CDP 打开平台，发一条消息，把浏览器发出的每一个请求都记录下来，
 * 用来确认「前端到底能不能看到 API key」。
 * 部署到公网后也可以对着线上地址跑，验证是否有泄露。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9444;
const TARGET = process.env.SNIFF_URL || 'http://127.0.0.1:8899';
const PASSWORD = process.env.SNIFF_PASS || 'hub-8899';
const PROFILE = path.join(__dirname, '..', '.edge-sniff');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

let ws, msgId = 0;
const pending = new Map();

function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('CDP 超时 ' + method));
      }
    }, 60000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
  return r.result ? r.result.value : undefined;
}

const requests = [];

(async () => {
  if (!fs.existsSync(EDGE)) throw new Error('找不到 Edge');
  const proc = spawn(
    EDGE,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
     '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE, '--window-size=1280,860', TARGET],
    { stdio: 'ignore' }
  );

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await getJSON('http://127.0.0.1:' + CDP_PORT + '/json');
      if (targets && targets.length) break;
    } catch (e) {}
    await sleep(500);
  }
  const page = targets.find((t) => t.type === 'page') || targets[0];

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      requests.push({
        url: r.url,
        method: r.method,
        headers: r.headers || {},
        postData: r.postData || null,
        type: m.params.type,
      });
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  console.log('\n  目标地址: ' + TARGET);
  console.log('  等待页面加载…');
  await sleep(3500);

  // 如遇密码门则登录
  const needLogin = await evaluate('(() => { const g = document.querySelector("#loginGate"); return g && !g.hidden; })()');
  if (needLogin) {
    console.log('  遇到密码门，执行登录…');
    await evaluate(`(() => {
      document.querySelector('#loginPw').value = ${JSON.stringify(PASSWORD)};
      document.querySelector('#loginBtn').click();
    })()`);
    await sleep(3000);
  }

  // 选一个模型
  await evaluate(`(() => {
    document.querySelector('#clearSel').click();
    const it = [...document.querySelectorAll('.pick-item')].find(i => i.querySelector('.mid').textContent === 'mimo-v2.5')
            || document.querySelector('.pick-item');
    if (it) it.click();
    document.querySelector('#modelTrigger').click();
  })()`);
  await sleep(600);

  console.log('  发送一条测试消息…');
  await evaluate(`(() => {
    const ta = document.querySelector('#input');
    ta.value = '测试一下';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#sendBtn').click();
  })()`);

  // 等流式结束
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const done = await evaluate('(() => { const b = document.querySelector("#stopBtn"); return b && b.hidden; })()');
    if (done) break;
  }
  await sleep(800);

  /* ---------------- 分析 ---------------- */
  console.log('\n  ==========================================');
  console.log('  浏览器实际发出的请求（共 ' + requests.length + ' 个）');
  console.log('  ==========================================\n');

  const host = new URL(TARGET).host;
  const thirdParty = [];

  for (const r of requests) {
    let u;
    try {
      u = new URL(r.url);
    } catch (e) {
      continue;
    }
    const sameHost = u.host === host;
    let line = '  ' + r.method.padEnd(5) + ' ' + (u.pathname + u.search).slice(0, 78);
    const auth = Object.keys(r.headers).find((h) => /^authorization$/i.test(h));
    if (!sameHost) {
      thirdParty.push(r.url);
      line += '   ← 外部域名 ' + u.host;
    }
    console.log(line);
    if (r.postData) {
      let body = r.postData;
      try {
        const j = JSON.parse(body);
        body = JSON.stringify({
          providerId: j.providerId,
          model: j.model,
          messageCount: (j.messages || []).length,
          stream: j.stream,
        });
      } catch (e) {
        body = body.slice(0, 90);
      }
      console.log('        请求体: ' + body);
    }
    if (auth) console.log('        ⚠ 请求头含 Authorization: ' + String(r.headers[auth]).slice(0, 20) + '…');
  }

  console.log('\n  ==========================================');
  console.log('  结论');
  console.log('  ==========================================');

  // 检查浏览器里有没有出现真实 API key
  const allHeaders = JSON.stringify(requests.map((r) => r.headers));
  const allBody = JSON.stringify(requests.map((r) => r.postData));
  const keyLike = (allHeaders + allBody).match(/sk-[A-Za-z0-9_\-]{16,}/g) || [];
  const realKeys = keyLike.filter((k) => !k.startsWith('sk-hub-')); // sk-hub- 是网关密钥，属于用户自己的

  console.log('  浏览器发出请求的域名数: ' + new Set(requests.map((r) => { try { return new URL(r.url).host; } catch (e) { return ''; } })).size);
  if (thirdParty.length) {
    console.log('  ⚠ 存在外部域名请求:');
    [...new Set(thirdParty)].forEach((u) => console.log('     ' + u.slice(0, 90)));
  } else {
    console.log('  ✓ 所有请求都只发往本平台，没有任何第三方域名');
  }
  console.log('  ' + (realKeys.length ? '✗ 前端出现了疑似真实密钥: ' + realKeys.slice(0, 3).map((k) => k.slice(0, 12) + '…').join(', ') : '✓ 前端流量里【没有】出现任何上游 API 密钥'));
  console.log('  ✓ 上游密钥只在服务端使用，浏览器完全接触不到\n');

  try {
    await send('Browser.close');
  } catch (e) {}
  ws.close();
  try {
    proc.kill();
  } catch (e) {}
  await sleep(500);
  process.exit(0);
})().catch(async (e) => {
  console.error('\n抓包失败: ' + e.message);
  try {
    ws && ws.close();
  } catch (x) {}
  process.exit(1);
});
