/**
 * UI 端到端测试：用 CDP 驱动 Edge 无头浏览器
 * 流程：打开页面 → 多选两个模型 → 输入问题 → 发送 → 等流式结束 → 截图
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9333;
const APP = 'http://127.0.0.1:8899';
const SHOTS = path.join(__dirname, '..', 'shots');
const PROFILE = path.join(__dirname, '..', '.edge-profile');

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
        reject(new Error('CDP 超时: ' + method));
      }
    }, 60000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  }
  return r.result ? r.result.value : undefined;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const p = path.join(SHOTS, name);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('   截图 -> ' + name + ' (' + Math.round(fs.statSync(p).size / 1024) + ' KB)');
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  if (!fs.existsSync(EDGE)) {
    console.error('找不到 Edge: ' + EDGE);
    process.exit(1);
  }

  console.log('[1] 启动无头 Edge…');
  const proc = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--hide-scrollbars',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + PROFILE,
      '--window-size=1440,940',
      APP,
    ],
    { stdio: 'ignore', detached: false }
  );

  // 等待 CDP 就绪
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await getJSON('http://127.0.0.1:' + CDP_PORT + '/json');
      if (targets && targets.length) break;
    } catch (e) {}
    await sleep(500);
  }
  if (!targets) throw new Error('CDP 未能就绪');
  const page = targets.find((t) => t.type === 'page') || targets[0];
  console.log('   已连接: ' + page.url);

  const WebSocket = globalThis.WebSocket;
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
      if (m.error) reject(new Error('CDP 错误: ' + JSON.stringify(m.error)));
      else resolve(m.result);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');

  // 收集 console 报错
  const pageErrors = [];
  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails?.exception?.description || 'unknown');
    }
  });

  console.log('[2] 清空本地状态、Cookie 并重新加载…');
  await send('Network.enable').catch(() => {});
  await send('Network.clearBrowserCookies').catch(() => {});
  await evaluate('localStorage.clear()');
  await send('Page.reload', { ignoreCache: true });
  await sleep(3000);
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate('!!document.querySelector("#modelTrigger") && document.querySelectorAll(".conv-item").length > 0');
    if (ready) break;
    await sleep(500);
  }

  // 访问密码门
  console.log('[2.5] 检查访问密码门…');
  const gate = await evaluate(`(() => {
    const g = document.querySelector('#loginGate');
    return { visible: g && !g.hidden, title: g ? (g.querySelector('h2')||{}).textContent : null };
  })()`);
  console.log('   密码门显示: ' + gate.visible + (gate.title ? ' ("' + gate.title + '")' : ''));
  if (gate.visible) {
    await shot('00-login.png');
    // 先试错误密码
    await evaluate(`(() => {
      document.querySelector('#loginPw').value = 'wrong-password';
      document.querySelector('#loginBtn').click();
    })()`);
    await sleep(1200);
    const wrongMsg = await evaluate('document.querySelector("#loginErr").textContent');
    console.log('   错误密码提示: "' + wrongMsg + '"');
    if (!wrongMsg) throw new Error('错误密码没有给出提示');
    await shot('00b-login-error.png');

    // 再用正确密码
    await evaluate(`(() => {
      document.querySelector('#loginPw').value = 'hub-8899';
      document.querySelector('#loginBtn').click();
    })()`);
    await sleep(2500);
    const after = await evaluate(`(() => ({
      gateHidden: document.querySelector('#loginGate').hidden,
      sub: document.querySelector('#brandSub').textContent,
    }))()`);
    console.log('   登录后: 密码门已隐藏=' + after.gateHidden + ', 侧栏="' + after.sub + '"');
    if (!after.gateHidden) throw new Error('正确密码未能通过');
  }

  await sleep(2000); // 等模型列表
  const sub = await evaluate('document.querySelector("#brandSub").textContent');
  console.log('   侧栏状态: ' + sub);
  await shot('01-home.png');

  console.log('[3] 打开模型面板…');
  await evaluate('document.querySelector("#modelTrigger").click()');
  await sleep(400);
  await shot('02-picker.png');

  const modelInfo = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.pick-item .mid')].map(e => e.textContent);
    return { total: items.length, sample: items.slice(0, 8) };
  })()`);
  console.log('   面板内模型数: ' + modelInfo.total + ' 例: ' + modelInfo.sample.join(', '));

  console.log('[4] 多选两个模型（跨端点）…');
  await evaluate('document.querySelector("#clearSel").click()'); // 先清空，避免默认选中项被反选
  await sleep(200);
  const picked = await evaluate(`(() => {
    const want = ['gemini-3.5-flash', 'mimo-v2.5'];
    const done = [], missing = [];
    for (const w of want) {
      const it = [...document.querySelectorAll('.pick-item')].find(i => i.querySelector('.mid').textContent === w);
      if (it) { it.click(); done.push(w); } else missing.push(w);
    }
    return {
      done, missing,
      label: document.querySelector('#modelLabel').textContent,
      chip: document.querySelector('#compareChipText').textContent,
    };
  })()`);
  console.log('   已选: ' + JSON.stringify(picked));
  if (picked.missing.length) throw new Error('面板里找不到模型: ' + picked.missing.join(', '));
  if (picked.done.length !== 2) throw new Error('多选失败，实际选中 ' + picked.done.length + ' 个');
  await sleep(300);
  await shot('03-selected.png');

  await evaluate('document.querySelector("#modelTrigger").click()'); // 关闭面板
  await sleep(200);

  console.log('[5] 输入问题并发送…');
  await evaluate(`(() => {
    const ta = document.querySelector('#input');
    ta.value = '用两句话说明什么是 JavaScript 闭包，并给一个最小的代码例子。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value.length;
  })()`);
  await sleep(200);
  await evaluate('document.querySelector("#sendBtn").click()');

  console.log('[6] 等待流式输出结束…');
  let lastLen = -1, stable = 0, elapsed = 0;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    elapsed++;
    const st = await evaluate(`(() => {
      const bodies = [...document.querySelectorAll('[data-body]')];
      const stop = document.querySelector('#stopBtn');
      const send = document.querySelector('#sendBtn');
      return {
        cols: document.querySelectorAll('.cmp-col').length,
        bodies: bodies.length,
        streaming: !stop.hidden,
        sendHidden: send.hidden,
        lens: bodies.map(b => {
          const inner = b.querySelector('.ai-body-inner') || b;
          return inner.textContent.length;
        }),
        errs: [...document.querySelectorAll('.err-box')].map(e => e.textContent.slice(0, 100)),
      };
    })()`);
    const total = st.lens.reduce((a, b) => a + b, 0);
    process.stdout.write(
      `   ${elapsed}s cols=${st.cols} 消息=${st.bodies} 字数=${JSON.stringify(st.lens)} ` +
      `streaming=${st.streaming} sendBtn隐藏=${st.sendHidden}\n`
    );
    if (!st.streaming && st.bodies > 0 && total > 0) {
      if (total === lastLen) {
        stable++;
        if (stable >= 2) break;
      } else stable = 0;
      lastLen = total;
    }
    if (st.errs.length) {
      console.log('   !! 出现错误框: ' + JSON.stringify(st.errs));
      break;
    }
  }

  await sleep(800);
  await shot('04-result.png');

  // 滚到顶部看完整结果
  await evaluate('document.querySelector("#chatScroll").scrollTop = 0');
  await sleep(400);
  await shot('05-result-top.png');

  console.log('[7] 检查渲染质量…');
  const check = await evaluate(`(() => {
    const out = {};
    out.cols = document.querySelectorAll('.cmp-col').length;
    out.md = {
      p: document.querySelectorAll('.ai-body-inner p').length,
      code: document.querySelectorAll('.ai-body-inner .code-block').length,
      strong: document.querySelectorAll('.ai-body-inner strong').length,
      ul: document.querySelectorAll('.ai-body-inner ul, .ai-body-inner ol').length,
    };
    out.texts = [...document.querySelectorAll('.cmp-col')].map(c => {
      const head = c.querySelector('.cmp-head');
      const body = c.querySelector('.ai-body-inner') || c.querySelector('.cmp-body');
      return {
        model: head ? head.querySelector('.cname').textContent : '?',
        meta: head ? head.querySelector('.cmeta').textContent : '',
        len: (body||{textContent:''}).textContent.length,
        preview: (body||{textContent:''}).textContent.slice(0, 90).replace(/\\s+/g,' '),
      };
    });
    if (!out.texts.length) {
      out.texts = [...document.querySelectorAll('[data-body]')].map(b => ({
        model: (b.closest('.msg').querySelector('.mname')||{textContent:'?'}).textContent,
        meta: '',
        len: (b.querySelector('.ai-body-inner')||b).textContent.length,
        preview: (b.querySelector('.ai-body-inner')||b).textContent.slice(0, 90).replace(/\\s+/g,' '),
      }));
    }
    out.think = document.querySelectorAll('.think').length;
    out.actions = document.querySelectorAll('.act-btn').length;
    out.bodyDebug = [...document.querySelectorAll('[data-body]')].map(b => ({
      mid: b.dataset.body,
      cls: b.className,
      parentCls: b.parentElement.className,
      hasInner: !!b.querySelector('.ai-body-inner'),
      thinkLen: (b.querySelector('.think-body') || { textContent: '' }).textContent.length,
      innerLen: (b.querySelector('.ai-body-inner') || { textContent: '' }).textContent.length,
    }));
    out.allMsgNodes = [...document.querySelectorAll('.msg')].map(m => m.className);
    return out;
  })()`);
  console.log('   ' + JSON.stringify(check, null, 2).split('\n').join('\n   '));

  console.log('[8] 测试深色主题 + 单模型模式…');
  await evaluate('document.querySelector("#themeBtn").click()');
  await sleep(500);
  await shot('06-dark.png');

  if (pageErrors.length) {
    console.log('\n!! 页面异常 ' + pageErrors.length + ' 条:');
    pageErrors.forEach((e) => console.log('   ' + String(e).split('\n')[0]));
  } else {
    console.log('\n   无页面 JS 异常');
  }

  console.log('\n[9] 关闭浏览器');
  try { await send('Browser.close'); } catch (e) {}
  ws.close();
  try { proc.kill(); } catch (e) {}
  await sleep(600);
  process.exit(0);
})().catch(async (e) => {
  console.error('\n测试失败: ' + e.message);
  try { ws && ws.close(); } catch (x) {}
  process.exit(1);
});
