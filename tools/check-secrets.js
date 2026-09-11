/**
 * 密钥泄露自检
 *   node tools/check-secrets.js
 *
 * 在把代码推到 GitHub 之前跑一遍，确保没有任何密钥会被公开。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.edge-profile', '.edge-sniff', 'shots', '.deploytest', '__pycache__']);

/** 常见密钥形态 */
const PATTERNS = [
  { name: 'OpenAI 风格 sk- 密钥', re: /\bsk-[A-Za-z0-9_\-]{16,}\b/g },
  { name: 'Bearer 硬编码', re: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/g },
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: '私钥文件头', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
];

/** 占位符/示例文本，不算泄露 */
const PLACEHOLDER = /(sk-你的|sk-xxx|sk-yyy|your[-_]?key|example|placeholder|改成你|xxxx|<.*?>)/i;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (st.size < 3 * 1024 * 1024) out.push(p);
  }
  return out;
}

/** 解析 .gitignore（支持通配符） */
function loadIgnore() {
  const pats = [];
  try {
    for (let line of fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n')) {
      line = line.trim();
      if (line && !line.startsWith('#')) pats.push(line.replace(/\/$/, ''));
    }
  } catch (e) {}
  return pats;
}

function ignored(rel, pats, name) {
  const wild = (p, s) => {
    const rx = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
    return rx.test(s);
  };
  return pats.some((p) => wild(p, rel) || wild(p, name));
}

const pats = loadIgnore();
const files = walk(ROOT);

console.log('');
console.log('  密钥泄露自检');
console.log('  ==========================================');
console.log('  扫描文件数: ' + files.length);
console.log('');

const findings = [];

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    continue;
  }
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const isIgnored = ignored(rel, pats, path.basename(file));

  for (const { name, re } of PATTERNS) {
    const rx = new RegExp(re.source, re.flags);
    let m;
    while ((m = rx.exec(text)) !== null) {
      const hit = m[0];
      if (PLACEHOLDER.test(hit)) continue;
      // 前 12 字符足以定位，不打印完整密钥
      findings.push({ file: rel, kind: name, sample: hit.slice(0, 12) + '…' + hit.slice(-4), ignored: isIgnored });
    }
  }
}

// config.json 专项检查
const cfgPath = path.join(ROOT, 'config.json');
let cfgExists = fs.existsSync(cfgPath);
let cfgIgnored = ignored('config.json', pats, 'config.json');

console.log('  [配置] config.json');
if (!cfgExists) {
  console.log('    不存在（云端部署靠环境变量时正常）');
} else if (cfgIgnored) {
  console.log('    ✓ 已被 .gitignore 挡住，不会推送');
} else {
  console.log('    ✗ 存在且【没有】被 .gitignore 挡住 —— 推上去就公开了！');
}
console.log('');

console.log('  [代码] 硬编码密钥扫描');
if (!findings.length) {
  console.log('    ✓ 没有发现任何硬编码密钥');
} else {
  const dangerous = findings.filter((f) => !f.ignored);
  const safe = findings.filter((f) => f.ignored);
  for (const f of dangerous) {
    console.log('    ✗ ' + f.file + '  (' + f.kind + ')  ' + f.sample);
  }
  for (const f of safe) {
    console.log('    · ' + f.file + '  (' + f.kind + ')  ' + f.sample + '  [已被 gitignore 忽略]');
  }
  console.log('');
  if (dangerous.length) {
    console.log('    会随代码公开的密钥 ' + dangerous.length + ' 处 —— 必须改成从 config.json 或环境变量读取');
  } else {
    console.log('    所有命中项都在 gitignore 范围内');
  }
}

console.log('');
console.log('  ==========================================');
const bad = findings.some((f) => !f.ignored) || (cfgExists && !cfgIgnored);
if (bad) {
  console.log('  结论：存在会公开的密钥，先处理再推送。');
  process.exit(1);
} else {
  console.log('  结论：可以安全推送到公开仓库。');
}
console.log('');
