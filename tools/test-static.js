/**
 * 纯静态版端到端验证
 *   node tools/test-static.js
 *
 * 用 Edge 无头浏览器打开 docs/ 静态站点，走一遍：
 *   配置密钥 -> 拉模型列表(浏览器直连) -> 发消息 -> 验证流式
 * 前置：需要先跑一个静态服务器，例如
 *   python -m http.server 8900 --directory docs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9455;
const SITE = process.env.SITE_URL || 'http://127.0.0.1:8900';
const SHOTS = path.join(__dirname, '..', 'shots');
const PROFILE = path.join(__dirname, '..', '.edge-static');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

let ws, msgId = 0;
const pending = new Map();

function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, 90000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
  return r.result ? r.result.value : undefined;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
  console.log('   截图 -> ' + name);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  // 从本地 config.json 取密钥，绝不在脚本里硬编码
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const keys = {};
  for (const p of cfg.providers) keys[p.id] = p.key;

  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
    '--hide-scrollbars', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + PROFILE, '--window-size=1440,940', SITE,
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJSON('http://127.0.0.1:' + CDP_PORT + '/json'); if (targets && targets.length) break; } catch (e) {}
    await sleep(500);
  }
  if (!targets) throw new Error('CDP 未就绪');
  const page = targets.find((t) => t.type === 'page') || targets[0];

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  const errors = [];
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || 'unknown');
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');

  console.log('\n  站点: ' + SITE);
  console.log('[1] 清空本地状态并重载');
  await evaluate('localStorage.clear()');
  await send('Page.reload', { ignoreCache: true });
  await sleep(3500);

  console.log('[2] 检查密钥配置门');
  const gate = await evaluate(`(() => {
    const g = document.querySelector('#loginGate');
    return {
      visible: g && !g.hidden,
      title: (g.querySelector('h2') || {}).textContent,
      rows: document.querySelectorAll('#cfgRows input[data-pid]').length,
    };
  })()`);
  console.log('   配置门显示=' + gate.visible + '  标题="' + gate.title + '"  输入框=' + gate.rows + ' 个');
  if (!gate.visible || gate.rows === 0) throw new Error('配置门没正常出现');
  await shot('10-static-config.png');

  console.log('[3] 填入密钥（从 config.json 读取）');
  const filled = await evaluate(`(() => {
    const map = ${JSON.stringify(keys)};
    let n = 0;
    document.querySelectorAll('#cfgRows input[data-pid]').forEach((inp) => {
      const k = map[inp.getAttribute('data-pid')];
      if (k) { inp.value = k; n++; }
    });
    return n;
  })()`);
  console.log('   填入 ' + filled + ' 个端点的密钥');
  await evaluate('document.querySelector("#loginBtn").click()');

  console.log('[4] 等待模型列表（浏览器直连端点）');
  let modelInfo = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    modelInfo = await evaluate(`(() => {
      const sub = document.querySelector('#brandSub').textContent;
      const items = [...document.querySelectorAll('.pick-item .mid')].map(e => e.textContent);
      return { sub, count: items.length, sample: items.slice(0, 5) };
    })()`);
    if (modelInfo.count > 0) break;
  }
  console.log('   侧栏: ' + modelInfo.sub);
  console.log('   可选模型: ' + modelInfo.count + ' 个  例: ' + modelInfo.sample.join(', '));
  if (!modelInfo.count) throw new Error('没有拉到任何模型（直连失败？）');
  await shot('11-static-home.png');

  console.log('[5] 选模型并发送');
  await evaluate(`(() => {
    document.querySelector('#clearSel').click();
    const it = [...document.querySelectorAll('.pick-item')].find(i => /flash|mini|lite/i.test(i.querySelector('.mid').textContent))
            || document.querySelector('.pick-item');
    if (it) it.click();
    document.querySelector('#modelTrigger').click();
  })()`);
  await sleep(500);
  await evaluate(`(() => {
    const ta = document.querySelector('#input');
    ta.value = '用一句话说明什么是闭包';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#sendBtn').click();
  })()`);

  console.log('[6] 等待流式输出');
  let lastLen = -1, stable = 0, finalText = '', errText = '';
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const st = await evaluate(`(() => {
      const b = document.querySelector('[data-body]');
      const inner = b ? (b.querySelector('.ai-body-inner') || b) : null;
      const err = document.querySelector('.err-box');
      const stop = document.querySelector('#stopBtn');
      return {
        len: inner ? inner.textContent.length : 0,
        streaming: stop ? !stop.hidden : false,
        err: err ? err.textContent.slice(0, 120) : '',
      };
    })()`);
    process.stdout.write('   ' + (i + 1) + 's 字数=' + st.len + ' streaming=' + st.streaming + (st.err ? '  错误:' + st.err : '') + '\n');
    if (st.err) { errText = st.err; break; }
    if (!st.streaming && st.len > 0) {
      if (st.len === lastLen) { if (++stable >= 2) break; } else stable = 0;
      lastLen = st.len;
    }
  }

  const result = await evaluate(`(() => {
    const b = document.querySelector('[data-body]');
    const inner = b ? (b.querySelector('.ai-body-inner') || b) : null;
    return {
      len: inner ? inner.textContent.length : 0,
      preview: inner ? inner.textContent.slice(0, 100).replace(/\\s+/g, ' ') : '',
      code: document.querySelectorAll('.ai-body-inner .code-block').length,
    };
  })()`);
  console.log('');
  console.log('   回答长度: ' + result.len + ' 字，代码块 ' + result.code + ' 个');
  console.log('   内容: ' + result.preview);
  await shot('12-static-result.png');

  console.log('');
  console.log('  ==========================================');
  const ok = result.len > 0 && !errText;
  console.log(ok ? '  ✓ 纯静态版直连跑通，无需任何后端' : '  ✗ 失败' + (errText ? ': ' + errText : ''));
  if (errors.length) {
    console.log('  页面异常 ' + errors.length + ' 条:');
    errors.slice(0, 5).forEach((e) => console.log('     ' + String(e).split('\n')[0]));
  }
  console.log('  ==========================================\n');

  try { await send('Browser.close'); } catch (e) {}
  ws.close();
  try { proc.kill(); } catch (e) {}
  await sleep(500);
  process.exit(ok ? 0 : 1);
})().catch(async (e) => {
  console.error('\n失败: ' + e.message);
  try { ws && ws.close(); } catch (x) {}
  process.exit(1);
});
