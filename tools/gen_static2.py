# -*- coding: utf-8 -*-
"""生成 docs/index.html 和 docs/style.css（纯静态版）"""
import io
import os
import shutil

# ---------- index.html ----------
html = io.open('public/index.html', encoding='utf-8').read()

OLD_GATE = """<!-- \u8bbf\u95ee\u5bc6\u7801 -->
<div class="login-gate" id="loginGate" hidden>
  <div class="login-card">
    <div class="login-logo">H</div>
    <h2>\u9700\u8981\u8bbf\u95ee\u5bc6\u7801</h2>
    <p>\u8fd9\u4e2a AI Hub \u5f00\u542f\u4e86\u8bbf\u95ee\u4fdd\u62a4\uff0c\u8f93\u5165\u5bc6\u7801\u540e\u7ee7\u7eed\u3002</p>
    <div class="login-row">
      <input type="password" id="loginPw" placeholder="\u8bbf\u95ee\u5bc6\u7801" autocomplete="current-password">
      <button id="loginBtn">\u8fdb\u5165</button>
    </div>
    <div class="login-err" id="loginErr"></div>
    <div class="login-tip">\u5bc6\u7801\u5728\u670d\u52a1\u7aef <code>config.json</code> \u7684 <code>auth.password</code></div>
  </div>
</div>"""

NEW_GATE = """<!-- \u7aef\u70b9\u5bc6\u94a5\u914d\u7f6e -->
<div class="login-gate" id="loginGate" hidden>
  <div class="login-card">
    <div class="login-logo">H</div>
    <h2>\u586b\u5165\u7aef\u70b9\u5bc6\u94a5</h2>
    <p>\u5bc6\u94a5\u53ea\u4fdd\u5b58\u5728\u4f60\u81ea\u5df1\u7684\u6d4f\u89c8\u5668\u91cc\uff0c\u4e0d\u4f1a\u4e0a\u4f20\u5230\u4efb\u4f55\u670d\u52a1\u5668\u3002<br>\u6362\u8bbe\u5907\u6216\u6e05\u7f13\u5b58\u540e\u9700\u91cd\u65b0\u586b\u4e00\u6b21\u3002</p>
    <div class="cfg-rows" id="cfgRows"></div>
    <button class="cfg-save" id="loginBtn">\u8fdb\u5165</button>
    <div class="login-err" id="loginErr"></div>
    <div class="login-tip">\u8fd9\u4e9b\u5bc6\u94a5\u4ec5\u7528\u4e8e\u5728\u6d4f\u89c8\u5668\u91cc\u76f4\u8fde\u5bf9\u5e94\u7684 API \u7aef\u70b9</div>
  </div>
</div>"""

if OLD_GATE in html:
    html = html.replace(OLD_GATE, NEW_GATE, 1)
    print('index.html: \u767b\u5f55\u95e8\u5df2\u6539\u4e3a\u5bc6\u94a5\u914d\u7f6e\u95e8')
else:
    print('index.html: !! \u672a\u5339\u914d\u5230\u767b\u5f55\u95e8\uff0c\u8bf7\u68c0\u67e5')

io.open('docs/index.html', 'w', encoding='utf-8', newline='').write(html)

# ---------- style.css ----------
shutil.copyfile('public/style.css', 'docs/style.css')

EXTRA = """

/* ============ \u7aef\u70b9\u5bc6\u94a5\u914d\u7f6e ============ */
.cfg-rows { text-align: left; margin-bottom: 18px; }
.cfg-row { margin-bottom: 13px; }
.cfg-row label {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: 5px; font-size: 12px;
}
.cfg-row label b { font-weight: 600; color: var(--text); }
.cfg-row label span { color: var(--text-3); font-family: var(--mono); font-size: 10.5px; }
.cfg-row input {
  width: 100%; padding: 9px 11px; font-size: 13px;
  border: 1px solid var(--border-str); border-radius: 9px;
  background: var(--bg-sub); outline: none; font-family: var(--mono);
}
.cfg-row input:focus { border-color: var(--accent); background: var(--bg-elev); }
.cfg-save {
  width: 100%; padding: 10px; border-radius: 10px;
  font-weight: 500; background: var(--accent); color: var(--accent-text);
}
.cfg-save:hover { filter: brightness(1.08); }
"""

io.open('docs/style.css', 'a', encoding='utf-8', newline='').write(EXTRA)

print('style.css: \u5df2\u590d\u5236\u5e76\u8ffd\u52a0\u914d\u7f6e\u9762\u677f\u6837\u5f0f')
print('')
for f in ['docs/index.html', 'docs/style.css', 'docs/app.js']:
    print('  ' + f + '  ' + str(os.path.getsize(f)) + ' bytes')
