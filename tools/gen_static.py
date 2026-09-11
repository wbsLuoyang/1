# -*- coding: utf-8 -*-
"""从 public/app.js 生成纯静态版 docs/app.js（浏览器直连端点，无后端）"""
import io
import os
import re

src = io.open('public/app.js', encoding='utf-8').read()
done = []


def rep(name, old, new):
    global src
    if old in src:
        src = src.replace(old, new, 1)
        done.append(name)
    else:
        print('  !! 未匹配: ' + name)


# ---------- A. apiFetch -> 纯前端配置层 ----------
old_a = """  /* 统一请求入口：自动带上访问凭证。
     Serverless 环境（EdgeOne 等）没有可靠的进程内会话，用 Header 传 token 最稳。 */
  const apiFetch = (url, opts) => {
    const o = Object.assign({}, opts || {});
    const headers = Object.assign({}, o.headers || {});
    const token = localStorage.getItem(LS.token);
    if (token) headers['X-Hub-Token'] = token;
    o.headers = headers;
    return fetch(url, o);
  };"""

new_a = """  /* ---------------- 端点配置（纯前端直连，无后端） ----------------
     密钥只存在浏览器 localStorage，不会上传到任何地方。
     页面本身不含密钥，换设备打开需重新填一次。 */
  const LS_CFG = 'hub.providers.v2';
  const DEFAULT_PROVIDERS = [
    { id: 'labapi', name: 'LabAPI', base: 'https://api.labapi.work/v1', key: '' },
    { id: 'mimo', name: 'MiMo', base: 'https://api.xiaomimimo.com/v1', key: '' },
  ];
  function getConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_CFG) || 'null');
      if (Array.isArray(saved) && saved.length) return { providers: saved };
    } catch (e) {}
    return { providers: DEFAULT_PROVIDERS.map(function (p) { return Object.assign({}, p); }) };
  }
  function saveConfig(providers) {
    localStorage.setItem(LS_CFG, JSON.stringify(providers));
  }
  function providerById(id) {
    return getConfig().providers.filter(function (p) { return p.id === id; })[0];
  }
  function classifyKind(id) {
    if (/asr|tts|whisper|embed|rerank|moderation|voiceclone|voicedesign/i.test(id)) return 'audio';
    if (/image|dall-?e|flux|midjourney|sd-xl/i.test(id)) return 'image';
    return 'chat';
  }
  async function fetchModelsOf(p) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(function () { ctl.abort(); }, 25000);
      let r;
      try {
        r = await fetch(p.base + '/models', {
          headers: { Authorization: 'Bearer ' + p.key },
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) return { ok: false, error: 'HTTP ' + r.status, models: [] };
      const j = await r.json();
      const list = Array.isArray(j) ? j : j.data || [];
      const models = list
        .map(function (m) {
          const id = typeof m === 'string' ? m : m.id;
          return { id: id, kind: classifyKind(id) };
        })
        .filter(function (m) { return m.id; });
      return { ok: true, models: models };
    } catch (e) {
      return { ok: false, error: (e && e.name === 'AbortError') ? '请求超时' : String((e && e.message) || e), models: [] };
    }
  }"""
rep('A 配置层', old_a, new_a)


# ---------- B. loadProviders ----------
old_b = """  async function loadProviders(refresh) {
    try {
      const r = await apiFetch(refresh ? 'api/refresh' : 'api/providers', { method: refresh ? 'POST' : 'GET' });
      if (r.status === 401) {
        el.brandSub.textContent = '需要密码';
        el.loginGate.hidden = false;
        el.loginPw.focus();
        return;
      }
      const j = await r.json();
      state.providers = j.providers || [];
      const total = state.providers.reduce((n, p) => n + (p.ok ? p.models.length : 0), 0);"""

new_b = """  async function loadProviders(refresh) {
    try {
      const provs = getConfig().providers;
      el.brandSub.textContent = '正在连接端点…';
      state.providers = await Promise.all(
        provs.map(async function (p) {
          if (!p.key) return { id: p.id, name: p.name, ok: false, error: '未填密钥', models: [] };
          const r = await fetchModelsOf(p);
          return { id: p.id, name: p.name, ok: r.ok, error: r.error, models: r.models };
        })
      );
      const total = state.providers.reduce((n, p) => n + (p.ok ? p.models.length : 0), 0);"""
rep('B loadProviders', old_b, new_b)


# ---------- C. runOne ----------
old_c = """    const payload = {
      providerId: ph.providerId,
      model: ph.model,
      messages: context,
      stream: params.stream !== false,
      system: params.system,
      temperature: params.temp,
      max_tokens: params.max === '' ? undefined : params.max,
    };

    try {
      const res = await apiFetch('api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });

      if (res.status === 401) {
        el.loginGate.hidden = false;
        el.loginPw.focus();
        throw new Error('访问密码已失效，请重新登录');
      }
"""

new_c = """    const prov = providerById(ph.providerId);
    if (!prov || !prov.key) {
      ph.error = '端点 ' + ph.providerId + ' 还没填密钥';
      ph.done = true;
      ph.ms = Date.now() - started;
      updateAiBody(ph);
      return;
    }

    const finalMessages = (params.system && String(params.system).trim())
      ? [{ role: 'system', content: params.system }].concat(context)
      : context;
    const payload = {
      model: ph.model,
      messages: finalMessages,
      stream: params.stream !== false,
    };
    if (params.temp !== undefined && params.temp !== null && params.temp !== '') payload.temperature = Number(params.temp);
    if (params.max !== '' && params.max !== null && params.max !== undefined) payload.max_tokens = Number(params.max);

    try {
      const res = await fetch(prov.base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + prov.key },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
"""
rep('C runOne', old_c, new_c)


# ---------- D. 密码 -> 密钥配置 ----------
old_d = """  /* ------------------------- 访问密码 ------------------------- */
  async function doLogin() {
    const pw = el.loginPw.value;
    if (!pw) {
      el.loginErr.textContent = '请输入密码';
      return;
    }
    el.loginBtn.disabled = true;
    el.loginErr.textContent = '';
    try {
      const r = await apiFetch('api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.token) localStorage.setItem(LS.token, j.token);
        el.loginGate.hidden = true;
        el.loginPw.value = '';
        el.brandSub.textContent = '正在载入…';
        await loadProviders(false);
      } else {
        const j = await r.json().catch(() => null);
        el.loginErr.textContent = (j && j.error && j.error.message) || '登录失败 HTTP ' + r.status;
        el.loginPw.select();
      }
    } catch (e) {
      el.loginErr.textContent = '请求失败：' + e.message;
    } finally {
      el.loginBtn.disabled = false;
    }
  }
  el.loginBtn.onclick = doLogin;
  el.loginPw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });

  async function checkAuth() {
    try {
      const r = await apiFetch('api/auth-status');
      const j = await r.json();
      if (j.enabled && !j.authed) {
        el.loginGate.hidden = false;
        el.loginPw.focus();
        return false;
      }
      return true;
    } catch (e) {
      return true; // 探测失败不阻塞，交给后续请求报错
    }
  }"""

new_d = """  /* ------------------------- 端点密钥配置 ------------------------- */
  const BASE_SHORT = /^https?:[/][/]/;

  function renderCfgRows() {
    const provs = getConfig().providers;
    el.cfgRows.innerHTML = '';
    provs.forEach(function (p) {
      const row = document.createElement('div');
      row.className = 'cfg-row';

      const label = document.createElement('label');
      const b = document.createElement('b');
      b.textContent = p.name;
      const span = document.createElement('span');
      span.textContent = p.base.replace(BASE_SHORT, '');
      label.appendChild(b);
      label.appendChild(span);

      const inp = document.createElement('input');
      inp.type = 'password';
      inp.setAttribute('data-pid', p.id);
      inp.placeholder = '粘贴 API Key';
      inp.value = p.key || '';

      row.appendChild(label);
      row.appendChild(inp);
      el.cfgRows.appendChild(row);
    });
    const first = el.cfgRows.querySelector('input[data-pid]');
    if (first) first.focus();
  }

  function saveKeys() {
    const provs = getConfig().providers.map(function (p) { return Object.assign({}, p); });
    let filled = 0;
    el.cfgRows.querySelectorAll('input[data-pid]').forEach(function (inp) {
      const pid = inp.getAttribute('data-pid');
      const p = provs.filter(function (x) { return x.id === pid; })[0];
      if (p) {
        p.key = inp.value.trim();
        if (p.key) filled++;
      }
    });
    if (!filled) {
      el.loginErr.textContent = '至少填一个端点的密钥';
      return;
    }
    saveConfig(provs);
    el.loginErr.textContent = '';
    el.loginGate.hidden = true;
    loadProviders(false);
  }

  function needConfig() {
    return !getConfig().providers.some(function (p) { return p.key; });
  }

  el.loginBtn.onclick = saveKeys;
  el.cfgRows.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') saveKeys();
  });"""
rep('D 密钥配置', old_d, new_d)


# ---------- E. boot ----------
old_e = """    autoGrow();
    if (!(await checkAuth())) return;
    loadProviders(false);
  }"""
new_e = """    autoGrow();
    if (needConfig()) {
      renderCfgRows();
      el.loginGate.hidden = false;
      el.brandSub.textContent = '等待填入密钥';
      return;
    }
    loadProviders(false);
  }"""
rep('E boot', old_e, new_e)


# ---------- F. el 引用 ----------
old_f = "    loginGate: $('#loginGate'), loginPw: $('#loginPw'), loginBtn: $('#loginBtn'), loginErr: $('#loginErr'),"
new_f = "    loginGate: $('#loginGate'), loginBtn: $('#loginBtn'), loginErr: $('#loginErr'), cfgRows: $('#cfgRows'),"
rep('F el 引用', old_f, new_f)


io.open('docs/app.js', 'w', encoding='utf-8', newline='').write(src)

print('')
print('成功替换 ' + str(len(done)) + ' 处: ' + ', '.join(done))
leftover = sorted(set(re.findall(r'apiFetch|loginPw|LS\\.token|checkAuth', src)))
print('残留旧引用: ' + (str(leftover) if leftover else '无'))
print('docs/app.js 大小: ' + str(os.path.getsize('docs/app.js')) + ' bytes')
