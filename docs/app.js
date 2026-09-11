/* ==========================================================
   AI Hub · 前端逻辑
   ========================================================== */
(() => {
  'use strict';

  /* ------------------------- 状态 ------------------------- */
  const LS = {
    convs: 'hub.convs.v1',
    sel: 'hub.selected.v1',
    params: 'hub.params.v1',
    theme: 'hub.theme.v1',
    sidebar: 'hub.sidebar.v1',
    token: 'hub.token.v1',
  };

  const state = {
    providers: [],          // [{id,name,ok,error,models:[{id,owner,kind}]}]
    selected: [],           // ["pid::model"]
    convs: [],
    activeId: null,
    streaming: false,
    controllers: [],
    params: { system: '', temp: 0.7, max: '', stream: true },
    round: 0,
    messageSeq: 0,
  };

  const $ = (s) => document.querySelector(s);
  const el = {
    sidebar: $('#sidebar'), collapseBtn: $('#collapseBtn'),
    brandSub: $('#brandSub'), newChatBtn: $('#newChatBtn'),
    convList: $('#convList'), refreshBtn: $('#refreshBtn'),
    themeBtn: $('#themeBtn'), themeLabel: $('#themeLabel'),
    modelTrigger: $('#modelTrigger'), modelLabel: $('#modelLabel'), triggerDot: $('#triggerDot'),
    pickerPanel: $('#pickerPanel'), modelSearch: $('#modelSearch'), chatOnly: $('#chatOnly'),
    pickerList: $('#pickerList'), pickerHint: $('#pickerHint'), clearSel: $('#clearSel'),
    compareChip: $('#compareChip'), compareChipText: $('#compareChipText'),
    paramBtn: $('#paramBtn'), paramPop: $('#paramPop'),
    exportBtn: $('#exportBtn'),
    pSystem: $('#pSystem'), pTemp: $('#pTemp'), vTemp: $('#vTemp'), pMax: $('#pMax'), pStream: $('#pStream'),
    chatScroll: $('#chatScroll'), chatInner: $('#chatInner'),
    input: $('#input'), sendBtn: $('#sendBtn'), stopBtn: $('#stopBtn'), statusLine: $('#statusLine'),
    toastWrap: $('#toastWrap'),
    loginGate: $('#loginGate'), loginBtn: $('#loginBtn'), loginErr: $('#loginErr'), cfgRows: $('#cfgRows'),
  };

  /* ------------------------- 工具 ------------------------- */
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ---------------- 端点配置（纯前端直连，无后端） ----------------
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
  }

  function toast(msg, kind = '') {
    const d = document.createElement('div');
    d.className = 'toast ' + kind;
    d.textContent = msg;
    el.toastWrap.appendChild(d);
    setTimeout(() => {
      d.style.transition = 'opacity .3s, transform .3s';
      d.style.opacity = '0';
      d.style.transform = 'translateX(20px)';
      setTimeout(() => d.remove(), 320);
    }, kind === 'err' ? 7000 : 3200);
  }

  /* ------------------------- Markdown ------------------------- */
  const mdCache = new Map();
  function mdToHtml(src) {
    const key = String(src);
    if (mdCache.has(key)) return mdCache.get(key);
    const html = renderMd(key);
    if (mdCache.size > 400) mdCache.clear();
    mdCache.set(key, html);
    return html;
  }

  function renderMd(src) {
    const codes = [];
    const inlines = [];
    let s = String(src).replace(/\r\n?/g, '\n');

    // 1) 提取围栏代码块
    s = s.replace(/^[ \t]*```([^\n`]*)\n([\s\S]*?)(?:^[ \t]*```[ \t]*$|$)/gm, (m, lang, code) => {
      const i = codes.length;
      codes.push({ lang: (lang || '').trim(), code: code.replace(/\n$/, '') });
      return '\u0000C' + i + '\u0000';
    });

    // 2) 转义
    s = esc(s);

    // 3) 提取行内代码
    s = s.replace(/`([^`\n]+)`/g, (m, c) => {
      const i = inlines.length;
      inlines.push(c);
      return '\u0000I' + i + '\u0000';
    });

    // 4) 块级解析
    const lines = s.split('\n');
    const out = [];
    let i = 0;
    const isBlockStart = (l) =>
      /^\u0000C\d+\u0000\s*$/.test(l.trim()) ||
      /^#{1,6}\s+/.test(l) ||
      /^\s*([-*_])\s*(\1\s*){2,}$/.test(l) ||
      /^\s*&gt;\s?/.test(l) ||
      /^\s*([-*+]|\d+[.)])\s+/.test(l);

    while (i < lines.length) {
      const line = lines[i];

      // 代码块
      if (/^\u0000C\d+\u0000\s*$/.test(line.trim())) {
        const idx = +line.trim().replace(/\u0000C(\d+)\u0000/, '$1');
        out.push(codeBlockHtml(codes[idx]));
        i++;
        continue;
      }
      // 空行
      if (!line.trim()) { i++; continue; }
      // 标题
      let m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        const lv = m[1].length;
        out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
        i++;
        continue;
      }
      // 分隔线
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out.push('<hr>'); i++; continue; }
      // 引用
      if (/^\s*&gt;\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*&gt;\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + buf.map((b) => (b.trim() ? `<p>${inline(b)}</p>` : '')).join('') + '</blockquote>');
        continue;
      }
      // 表格
      if (line.includes('|') && lines[i + 1] && /^[\s|:-]*-[\s|:-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-') && lines[i + 1].includes('|') === line.includes('|')) {
        const splitRow = (r) => {
          let t = r.trim();
          if (t.startsWith('|')) t = t.slice(1);
          if (t.endsWith('|')) t = t.slice(0, -1);
          return t.split('|').map((c) => c.trim());
        };
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push(
          '<table><thead><tr>' +
            head.map((h) => `<th>${inline(h)}</th>`).join('') +
            '</tr></thead><tbody>' +
            rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
            '</tbody></table>'
        );
        continue;
      }
      // 列表
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
          i++;
          // 收拢后续的续行（非块级起始）
          while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
            items[items.length - 1] += '\n' + lines[i];
            i++;
          }
        }
        out.push(
          `<${ordered ? 'ol' : 'ul'}>` +
            items.map((t) => `<li>${inline(t).replace(/\n/g, '<br>')}</li>`).join('') +
            `</${ordered ? 'ol' : 'ul'}>`
        );
        continue;
      }
      // 段落
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push('<p>' + buf.map((b) => inline(b)).join('<br>') + '</p>');
    }

    let html = out.join('');

    // 5) 还原行内代码
    html = html.replace(/\u0000I(\d+)\u0000/g, (m, n) => `<code class="inline">${inlines[+n]}</code>`);
    return html;
  }

  function codeBlockHtml(block) {
    const lang = (block.lang || '').replace(/[^a-zA-Z0-9+#.-]/g, '').slice(0, 20) || 'text';
    return (
      '<div class="code-block"><div class="code-head"><span>' + lang + '</span>' +
      '<button class="copy-code" data-code="' + encodeURIComponent(block.code) + '">复制</button></div>' +
      '<pre><code>' + esc(block.code) + '</code></pre></div>'
    );
  }

  function inline(t) {
    let s = t;
    // 图片
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, alt, url) =>
      /^(https?:\/\/|\/)/i.test(url) ? `<img src="${url}" alt="${alt}">` : m
    );
    // 链接
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, txt, url) =>
      /^(https?:\/\/|\/|mailto:)/i.test(url)
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`
        : m
    );
    // 裸链接
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g, (m, p1, url) =>
      p1 + `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
    );
    // 粗体
    s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^\n]+?)__/g, '<strong>$1</strong>');
    // 删除线
    s = s.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
    // 斜体
    s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>');
    return s;
  }

  /* ------------------------- 主题 / 侧栏 ------------------------- */
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    el.themeLabel.textContent = t === 'dark' ? '浅色' : '深色';
    localStorage.setItem(LS.theme, t);
  }
  el.themeBtn.onclick = () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

  el.collapseBtn.onclick = () => {
    el.sidebar.classList.toggle('collapsed');
    localStorage.setItem(LS.sidebar, el.sidebar.classList.contains('collapsed') ? '1' : '0');
  };

  /* ------------------------- 会话持久化 ------------------------- */
  function saveConvs() {
    try {
      localStorage.setItem(LS.convs, JSON.stringify(state.convs.slice(0, 80)));
    } catch (e) {
      toast('本地存储写入失败：' + e.message, 'err');
    }
  }
  function loadConvs() {
    try {
      state.convs = JSON.parse(localStorage.getItem(LS.convs) || '[]');
    } catch (e) {
      state.convs = [];
    }
    if (!state.convs.length) newConv();
    else state.activeId = state.convs[0].id;
  }
  const activeConv = () => state.convs.find((c) => c.id === state.activeId);

  function newConv() {
    const c = { id: uid(), title: '新对话', createdAt: Date.now(), messages: [] };
    state.convs.unshift(c);
    state.activeId = c.id;
    saveConvs();
    renderConvs();
    renderChat();
    el.input.focus();
    return c;
  }

  function renderConvs() {
    el.convList.innerHTML = '';
    for (const c of state.convs) {
      const d = document.createElement('div');
      d.className = 'conv-item' + (c.id === state.activeId ? ' active' : '');
      d.innerHTML = `<span class="title"></span>
        <button class="del" title="删除">
          <svg viewBox="0 0 24 24" style="width:13px;height:13px"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
        </button>`;
      d.querySelector('.title').textContent = c.title;
      d.onclick = () => {
        state.activeId = c.id;
        renderConvs();
        renderChat();
      };
      d.querySelector('.del').onclick = (e) => {
        e.stopPropagation();
        state.convs = state.convs.filter((x) => x.id !== c.id);
        if (!state.convs.length) newConv();
        else if (state.activeId === c.id) state.activeId = state.convs[0].id;
        saveConvs();
        renderConvs();
        renderChat();
      };
      el.convList.appendChild(d);
    }
  }

  /* ------------------------- 模型选择 ------------------------- */
  const selKey = (p, m) => p + '::' + m;
  const parseKey = (k) => {
    const i = k.indexOf('::');
    return { providerId: k.slice(0, i), model: k.slice(i + 2) };
  };

  function providerOf(id) {
    return state.providers.find((p) => p.id === id);
  }

  async function loadProviders(refresh) {
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
      const total = state.providers.reduce((n, p) => n + (p.ok ? p.models.length : 0), 0);
      const okCount = state.providers.filter((p) => p.ok).length;
      el.brandSub.textContent = `${okCount}/${state.providers.length} 端点 · ${total} 模型`;

      // 剪掉失效的已选项
      const valid = new Set();
      for (const p of state.providers) for (const m of p.models) valid.add(selKey(p.id, m.id));
      state.selected = state.selected.filter((k) => valid.has(k));
      if (!state.selected.length) {
        // 默认选一个可用的轻量模型
        for (const p of state.providers) {
          const cand = p.models.find((m) => m.kind === 'chat' && /flash|mini|lite/i.test(m.id)) ||
                       p.models.find((m) => m.kind === 'chat');
          if (cand) { state.selected = [selKey(p.id, cand.id)]; break; }
        }
      }
      persistSel();
      renderPicker();
      renderTrigger();
      renderChat();
    } catch (e) {
      toast('加载模型列表失败：' + e.message, 'err');
      el.brandSub.textContent = '加载失败';
    }
  }

  function persistSel() {
    localStorage.setItem(LS.sel, JSON.stringify(state.selected));
  }

  function renderTrigger() {
    const n = state.selected.length;
    if (!n) {
      el.modelLabel.textContent = '选择模型';
      el.triggerDot.className = 'dot';
      el.compareChip.hidden = true;
      return;
    }
    el.triggerDot.className = 'dot ok';
    if (n === 1) {
      const { providerId, model } = parseKey(state.selected[0]);
      el.modelLabel.textContent = model + '  ·  ' + (providerOf(providerId)?.name || providerId);
      el.compareChip.hidden = true;
    } else {
      el.modelLabel.textContent = `已选 ${n} 个模型 · 对比模式`;
      el.compareChip.hidden = false;
      el.compareChipText.textContent = '对比 ' + n;
    }
  }

  function renderPicker() {
    const q = el.modelSearch.value.trim().toLowerCase();
    const chatOnly = el.chatOnly.checked;
    const selSet = new Set(state.selected);
    el.pickerList.innerHTML = '';
    let shown = 0;

    for (const p of state.providers) {
      let models = p.models || [];
      if (chatOnly) models = models.filter((m) => m.kind === 'chat');
      if (q) models = models.filter((m) => m.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
      if (!models.length && !q) {
        // 端点不可用时也要显示状态
        if (!p.ok || chatOnly) continue;
      }
      if (!models.length) continue;

      const head = document.createElement('div');
      head.className = 'pick-group-head';
      head.innerHTML = esc(p.name) +
        `<span class="badge ${p.ok ? 'good' : 'bad'}">${p.ok ? models.length + ' 个' : '不可用'}</span>`;
      el.pickerList.appendChild(head);

      for (const m of models) {
        shown++;
        const k = selKey(p.id, m.id);
        const it = document.createElement('div');
        it.className = 'pick-item' + (selSet.has(k) ? ' sel' : '');
        it.innerHTML = `<span class="box"></span><span class="mid">${esc(m.id)}</span>` +
          (m.kind !== 'chat' ? `<span class="tag">${m.kind === 'image' ? '图像' : '语音'}</span>` : '');
        it.onclick = () => {
          const idx = state.selected.indexOf(k);
          if (idx >= 0) state.selected.splice(idx, 1);
          else state.selected.push(k);
          persistSel();
          it.classList.toggle('sel');
          renderTrigger();
          updateHint();
        };
        el.pickerList.appendChild(it);
      }
    }

    if (!shown) {
      el.pickerList.innerHTML = '<div style="padding:22px;text-align:center;color:var(--text-3);font-size:12.5px">没有匹配的模型</div>';
    }
    updateHint();
  }

  function updateHint() {
    const n = state.selected.length;
    el.pickerHint.textContent = n > 1
      ? `已选 ${n} 个 —— 发送后并排对比`
      : '可多选，选中多个即开启对比模式';
  }

  el.modelTrigger.onclick = (e) => {
    e.stopPropagation();
    el.pickerPanel.hidden = !el.pickerPanel.hidden;
    if (!el.pickerPanel.hidden) el.modelSearch.focus();
  };
  el.modelSearch.oninput = renderPicker;
  el.chatOnly.onchange = renderPicker;
  el.clearSel.onclick = (e) => {
    e.stopPropagation();
    state.selected = [];
    persistSel();
    renderPicker();
    renderTrigger();
  };

  el.paramBtn.onclick = (e) => {
    e.stopPropagation();
    el.paramPop.hidden = !el.paramPop.hidden;
  };
  document.addEventListener('click', (e) => {
    if (!el.pickerPanel.hidden && !e.target.closest('.picker-wrap')) el.pickerPanel.hidden = true;
    if (!el.paramPop.hidden && !e.target.closest('.param-pop') && !e.target.closest('#paramBtn'))
      el.paramPop.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      el.pickerPanel.hidden = true;
      el.paramPop.hidden = true;
    }
  });

  el.refreshBtn.onclick = async () => {
    el.refreshBtn.disabled = true;
    toast('正在重新拉取所有端点的模型…');
    await loadProviders(true);
    el.refreshBtn.disabled = false;
    toast('模型列表已刷新', 'ok');
  };

  /* ------------------------- 参数 ------------------------- */
  function loadParams() {
    try {
      const p = JSON.parse(localStorage.getItem(LS.params) || '{}');
      Object.assign(state.params, p);
    } catch (e) {}
    el.pSystem.value = state.params.system || '';
    el.pTemp.value = state.params.temp ?? 0.7;
    el.vTemp.textContent = el.pTemp.value;
    el.pMax.value = state.params.max || '';
    el.pStream.checked = state.params.stream !== false;
  }
  function saveParams() {
    state.params = {
      system: el.pSystem.value,
      temp: parseFloat(el.pTemp.value),
      max: el.pMax.value,
      stream: el.pStream.checked,
    };
    localStorage.setItem(LS.params, JSON.stringify(state.params));
  }
  el.pTemp.oninput = () => { el.vTemp.textContent = el.pTemp.value; saveParams(); };
  el.pSystem.oninput = saveParams;
  el.pMax.oninput = saveParams;
  el.pStream.onchange = saveParams;

  /* ------------------------- 渲染聊天 ------------------------- */
  function renderChat() {
    const conv = activeConv();
    const wrap = el.chatInner;
    wrap.innerHTML = '';
    if (!conv || !conv.messages.length) {
      wrap.classList.remove('wide');
      const total = state.providers.reduce((n, p) => n + (p.ok ? p.models.length : 0), 0);
      const chatN = state.providers.reduce((n, p) => n + (p.ok ? p.models.filter((m) => m.kind === 'chat').length : 0), 0);
      wrap.innerHTML = `<div class="welcome">
        <h1>聚合了 ${state.providers.length} 个端点</h1>
        <p>选择一个或多个模型即可开始。选中多个模型会并排对比回答。</p>
        <div class="stat-row">
          <div class="stat"><b>${state.providers.filter((p) => p.ok).length}</b><span>在线端点</span></div>
          <div class="stat"><b>${total}</b><span>全部模型</span></div>
          <div class="stat"><b>${chatN}</b><span>对话模型</span></div>
        </div>
      </div>`;
      return;
    }
    wrap.classList.toggle('wide', conv.messages.some((m) => m.role === 'assistant' && m.round != null && conv.messages.filter((x) => x.round === m.round).length > 1));

    let i = 0;
    const ms = conv.messages;
    while (i < ms.length) {
      const m = ms[i];
      if (m.role === 'user') {
        const d = document.createElement('div');
        d.className = 'msg user';
        d.innerHTML = `<div class="bubble-user">${esc(m.content)}</div>`;
        wrap.appendChild(d);
        i++;
        continue;
      }
      // assistant 分组
      const group = [m];
      let j = i + 1;
      while (j < ms.length && ms[j].role === 'assistant' && ms[j].round === m.round) {
        group.push(ms[j]);
        j++;
      }
      wrap.appendChild(buildAiGroup(group));
      i = j;
    }
    scrollToBottom();
  }

  function buildAiGroup(group) {
    const multi = group.length > 1;
    const container = document.createElement('div');
    container.className = 'msg ai' + (multi ? ' multi' : '');
    const grid = document.createElement('div');
    grid.className = 'compare-grid';
    if (multi) grid.style.gridTemplateColumns = `repeat(${Math.min(group.length, 4)}, minmax(0,1fr))`;

    for (const m of group) {
      const col = document.createElement('div');
      col.className = multi ? 'cmp-col' : 'bubble-ai';
      col.dataset.mid = m.id;
      if (multi) col.innerHTML = cmpHeadHtml(m);
      col.appendChild(buildAiBody(m));
      grid.appendChild(col);
    }
    container.appendChild(grid);
    return container;
  }

  function cmpHeadHtml(m) {
    const dot = m.error ? 'err' : m.done ? 'ok' : '';
    const meta = m.error ? '失败' : m.ms ? (m.ms / 1000).toFixed(1) + 's' : '…';
    return `<div class="cmp-head"><span class="cdot ${dot}"></span>
      <span class="cname">${esc(m.model)}</span>
      <span class="cmeta">${meta}</span></div>`;
  }

  function buildAiBody(m) {
    const body = document.createElement('div');
    if (m.multi) body.className = 'cmp-body';
    else body.className = 'ai-body';
    body.dataset.body = m.id;
    body.innerHTML = bodyHtml(m);
    return body;
  }

  function bodyHtml(m) {
    let h = '';
    if (!m.multi && m.role === 'assistant') {
      const pname = providerOf(m.providerId)?.name || m.providerId || '';
      h += `<div class="ai-head"><span class="mname">${esc(m.model)}</span><span>·</span><span>${esc(pname)}</span>${
        m.ms ? `<span>·</span><span>${(m.ms / 1000).toFixed(1)}s</span>` : ''
      }</div>`;
    }
    if (m.reasoning) {
      h += `<details class="think"><summary>思考过程（${m.reasoning.length} 字）</summary>
        <div class="think-body">${esc(m.reasoning)}</div></details>`;
    }
    if (m.error) {
      h += `<div class="err-box"><span class="err-title">请求失败</span>${esc(m.error)}</div>`;
    }
    if (m.content) {
      h += `<div class="ai-body-inner ${m.multi ? 'cmp-md' : ''}">${mdToHtml(m.content)}</div>`;
    }
    if (!m.error && !m.content && !m.reasoning) h += '<span class="cursor"></span>';
    else if (!m.done && !m.error) h += '<span class="cursor"></span>';

    if (m.done && !m.error && m.content) {
      h += `<div class="msg-actions">
        <button class="act-btn" data-act="copy" data-id="${m.id}">
          <svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>复制</button>
        <button class="act-btn" data-act="regen" data-id="${m.id}">
          <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-3-6.7M21 3v6h-6"/></svg>重答</button>
      </div>`;
    }
    return h;
  }

  function updateAiBody(msg) {
    const node = el.chatInner.querySelector(`[data-body="${msg.id}"]`);
    if (!node) return;
    if (node.classList.contains('cmp-body')) {
      const col = node.closest('.cmp-col');
      if (col) {
        const head = col.querySelector('.cmp-head');
        if (head) head.outerHTML = cmpHeadHtml({ ...msg, multi: true });
      }
    }
    const atBottom = el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight < 140;
    node.innerHTML = bodyHtml(msg);
    if (atBottom) scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
    });
  }

  /* ------------------------- 复制 / 重答 ------------------------- */
  el.chatInner.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('.copy-code');
    if (copyBtn) {
      const code = decodeURIComponent(copyBtn.dataset.code || '');
      await copyText(code);
      copyBtn.textContent = '已复制';
      setTimeout(() => (copyBtn.textContent = '复制'), 1400);
      return;
    }
    const act = e.target.closest('.act-btn');
    if (!act) return;
    const conv = activeConv();
    const msg = conv?.messages.find((m) => m.id === act.dataset.id);
    if (!msg) return;
    if (act.dataset.act === 'copy') {
      await copyText(msg.content || '');
      act.lastChild.textContent = '已复制';
      setTimeout(() => (act.lastChild.textContent = '复制'), 1400);
    } else if (act.dataset.act === 'regen') {
      regenerate(msg);
    }
  });

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  /* ------------------------- 发送 ------------------------- */
  function setSending(on) {
    state.streaming = on;
    el.sendBtn.hidden = on;
    el.stopBtn.hidden = !on;
    el.statusLine.textContent = on ? '生成中…' : '就绪';
  }

  function buildContext(conv, uptoIndex, modelKey) {
    // 只保留：全部 user 消息 + 该模型自己的 assistant 回复
    const msgs = [];
    for (let i = 0; i < uptoIndex; i++) {
      const m = conv.messages[i];
      if (m.role === 'user') msgs.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant' && m.modelKey === modelKey && m.content && !m.error) {
        msgs.push({ role: 'assistant', content: m.content });
      }
    }
    return msgs;
  }

  async function send() {
    const text = el.input.value.trim();
    if (!text || state.streaming) return;
    if (!state.selected.length) {
      toast('请先选择至少一个模型', 'err');
      el.pickerPanel.hidden = false;
      return;
    }
    const conv = activeConv();
    conv.messages.push({ id: uid(), role: 'user', content: text, at: Date.now() });
    if (conv.title === '新对话') {
      conv.title = text.slice(0, 24) + (text.length > 24 ? '…' : '');
      renderConvs();
    }
    el.input.value = '';
    autoGrow();
    saveConvs();
    renderChat();
    await runRound(conv);

    // 等待所有模型返回完毕
    while (state.streaming) await new Promise((r) => setTimeout(r, 120));
  }

  async function runRound(conv) {
    const round = ++state.round;
    const targets = state.selected.map(parseKey);
    // 占位消息
    const placeholders = targets.map((t) => {
      const m = {
        id: uid(),
        role: 'assistant',
        model: t.model,
        modelKey: selKey(t.providerId, t.model),
        providerId: t.providerId,
        content: '',
        reasoning: '',
        round,
        multi: targets.length > 1,
        done: false,
        error: null,
        ms: 0,
      };
      conv.messages.push(m);
      return m;
    });
    saveConvs();
    renderChat();
    setSending(true);

    const ctxIndex = conv.messages.length - placeholders.length; // user 消息的位置+1
    const paramSnap = { ...state.params };

    await Promise.all(
      placeholders.map(async (ph) => {
        const context = buildContext(conv, ctxIndex, ph.modelKey);
        await runOne(ph, context, paramSnap, conv);
      })
    );

    saveConvs();
    setSending(false);
    renderConvs();
  }

  async function runOne(ph, context, params, conv) {
    const started = Date.now();
    const ctl = new AbortController();
    state.controllers.push(ctl);
    let lastPaint = 0;
    const paint = (force) => {
      const now = Date.now();
      if (force || now - lastPaint > 70) {
        lastPaint = now;
        updateAiBody(ph);
      }
    };
    ph.painting = paint;

    const prov = providerById(ph.providerId);
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
      const ctype = res.headers.get('content-type') || '';
      if (!res.ok || ctype.includes('application/json')) {
        const j = await res.json().catch(() => null);
        const msg = j?.error?.message || ('HTTP ' + res.status);
        const detail = j?.error?.detail ? '\n' + String(j.error.detail).slice(0, 600) : '';
        throw new Error(msg + detail);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      let buf = '';
      let firstToken = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let j;
          try {
            j = JSON.parse(data);
          } catch (e) {
            continue;
          }
          if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
          const d = j.choices?.[0]?.delta;
          if (!d) continue;
          if (!firstToken) { firstToken = Date.now(); ph.ttfb = firstToken - started; }
          if (d.reasoning_content) { ph.reasoning += d.reasoning_content; paint(); }
          if (d.content) { ph.content += d.content; paint(); }
        }
      }
      ph.done = true;
    } catch (e) {
      if (e.name === 'AbortError') {
        ph.content += ph.content ? '\n\n_(已手动停止)_' : '_(已停止)_';
        ph.done = true;
      } else {
        ph.error = e.message || String(e);
        ph.done = true;
      }
    } finally {
      ph.ms = Date.now() - started;
      state.controllers = state.controllers.filter((c) => c !== ctl);
      updateAiBody(ph);
    }
  }

  async function regenerate(msg) {
    if (state.streaming) return;
    const conv = activeConv();
    if (!conv) return;
    const idx = conv.messages.indexOf(msg);
    // 找到对应的 user 消息位置
    let userIdx = idx - 1;
    while (userIdx >= 0 && conv.messages[userIdx].role !== 'user') userIdx--;
    if (userIdx < 0) return;

    // 移除同一轮的所有 assistant 回复
    const round = msg.round;
    conv.messages = conv.messages.filter((m) => !(m.role === 'assistant' && m.round === round));
    saveConvs();

    const targets = [{ providerId: msg.providerId, model: msg.model }];
    const saved = state.selected;
    state.selected = [selKey(msg.providerId, msg.model)];
    await runRound(conv);
    state.selected = saved;
    persistSel();
    renderTrigger();
  }

  el.stopBtn.onclick = () => {
    state.controllers.forEach((c) => c.abort());
    state.controllers = [];
    setSending(false);
  };

  el.sendBtn.onclick = send;

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 220) + 'px';
  }
  el.input.addEventListener('input', autoGrow);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  /* ------------------------- 导出 ------------------------- */
  el.exportBtn.onclick = () => {
    const conv = activeConv();
    if (!conv || !conv.messages.length) {
      toast('当前对话为空', 'err');
      return;
    }
    let md = `# ${conv.title}\n\n> 导出时间：${new Date().toLocaleString()}\n\n---\n\n`;
    for (const m of conv.messages) {
      if (m.role === 'user') md += `## 🧑 我\n\n${m.content}\n\n`;
      else {
        md += `## 🤖 ${m.model}（${providerOf(m.providerId)?.name || m.providerId}）\n\n`;
        if (m.reasoning) md += `<details><summary>思考过程</summary>\n\n${m.reasoning}\n\n</details>\n\n`;
        if (m.error) md += `**错误：** ${m.error}\n\n`;
        if (m.content) md += `${m.content}\n\n`;
      }
    }
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = conv.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) + '.md';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出', 'ok');
  };

  el.newChatBtn.onclick = () => newConv();
  el.compareChip.onclick = () => {
    el.pickerPanel.hidden = false;
    el.modelSearch.focus();
  };

  /* ------------------------- 端点密钥配置 ------------------------- */
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
  });

  /* ------------------------- 启动 ------------------------- */
  async function boot() {
    applyTheme(localStorage.getItem(LS.theme) || 'light');
    if (localStorage.getItem(LS.sidebar) === '1') el.sidebar.classList.add('collapsed');
    try {
      state.selected = JSON.parse(localStorage.getItem(LS.sel) || '[]');
    } catch (e) {
      state.selected = [];
    }
    loadParams();
    loadConvs();
    renderConvs();
    renderChat();
    autoGrow();
    if (needConfig()) {
      renderCfgRows();
      el.loginGate.hidden = false;
      el.brandSub.textContent = '等待填入密钥';
      return;
    }
    loadProviders(false);
  }
  boot();
})();
