/**
 * AI Hub 网络自检
 *   node tools/net-check.js
 *
 * 检查服务是否在跑、有哪些地址可以访问、防火墙会不会挡。
 */
const os = require('os');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let CFG = {};
try {
  CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch (e) {
  console.log('  ! 读不到 config.json，按默认端口 8899 检查');
}
const PORT = (CFG.server && CFG.server.port) || 8899;
const HOST = (CFG.server && CFG.server.host) || '127.0.0.1';

function probe(host) {
  return new Promise((resolve) => {
    const req = http.get(
      { host, port: PORT, path: '/api/auth-status', timeout: 3500 },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ ok: true, code: res.statusCode, body: d }));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, err: '连接超时' });
    });
    req.on('error', (e) => resolve({ ok: false, err: e.code || e.message }));
  });
}

function interfaces() {
  const out = { lan: [], tailscale: [] };
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (i.address.startsWith('169.254.')) continue; // APIPA，未连接
      if (i.address.startsWith('100.')) out.tailscale.push({ name, ip: i.address });
      else out.lan.push({ name, ip: i.address });
    }
  }
  return out;
}

function firewallOk() {
  try {
    const cmd =
      'powershell -NoProfile -Command "' +
      "(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.Program -like '*node.exe*' -or $_.Program -like '*Node.js*' } | " +
      'Measure-Object).Count"';
    const n = parseInt(String(execSync(cmd, { encoding: 'utf8', timeout: 20000 })).trim(), 10);
    return { known: true, count: isNaN(n) ? 0 : n };
  } catch (e) {
    return { known: false, count: 0 };
  }
}

function tailscaleStatus() {
  try {
    const v = execSync('tailscale ip -4', { encoding: 'utf8', timeout: 10000 }).trim();
    const st = execSync('tailscale status', { encoding: 'utf8', timeout: 10000 }).trim();
    return { installed: true, ip: v, status: st };
  } catch (e) {
    return { installed: false };
  }
}

const line = (s) => '  ' + s;

(async () => {
  console.log('');
  console.log('  AI Hub 网络自检');
  console.log('  ==========================================');

  /* 1. 服务是否在跑 */
  console.log('\n  [1/4] 本地服务');
  const local = await probe('127.0.0.1');
  if (local.ok) {
    let authed = '?';
    try {
      const j = JSON.parse(local.body);
      authed = j.enabled ? (j.authed ? '已登录' : '需要密码（正常）') : '未设密码';
    } catch (e) {}
    console.log(line('✓ 端口 ' + PORT + ' 正常响应 HTTP ' + local.code + '，密码状态：' + authed));
  } else {
    console.log(line('✗ 连不上 127.0.0.1:' + PORT + ' —— ' + local.err));
    console.log(line('  服务没在跑？双击 start.bat 启动一下。'));
  }

  /* 2. 监听地址 */
  console.log('\n  [2/4] 监听范围');
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log(line('✓ 监听 ' + HOST + ' —— 局域网和其它网卡都能访问'));
  } else {
    console.log(line('✗ 监听 ' + HOST + ' —— 只有本机能访问'));
    console.log(line('  想让手机访问，把 config.json 的 server.host 改成 "0.0.0.0" 再重启'));
  }

  /* 3. 防火墙 */
  console.log('\n  [3/4] 防火墙');
  const fw = firewallOk();
  if (!fw.known) {
    console.log(line('? 查询失败（可能没有权限），跳过'));
  } else if (fw.count > 0) {
    console.log(line('✓ 已有 ' + fw.count + ' 条 node.exe 入站放行规则'));
  } else {
    console.log(line('✗ 没有 node.exe 的入站放行规则，外部可能连不上'));
    console.log(line('  用管理员权限运行下面这条命令即可：'));
    console.log(line('  netsh advfirewall firewall add rule name="AI Hub" dir=in action=allow protocol=TCP localport=' + PORT));
  }

  /* 4. 可用地址 */
  console.log('\n  [4/4] 可访问的地址');
  const ips = interfaces();
  const ts = tailscaleStatus();

  if (ips.lan.length) {
    console.log(line('局域网（手机连同一个 WiFi 时用）：'));
    ips.lan.forEach((i) => console.log(line('    http://' + i.ip + ':' + PORT + '   [' + i.name + ']')));
  } else {
    console.log(line('· 没找到局域网地址（可能没连 WiFi）'));
  }

  if (ts.installed) {
    console.log(line('Tailscale（在外面用 4G/5G 时用）：'));
    (ts.ip || '').split('\n').filter(Boolean).forEach((ip) => {
      console.log(line('    http://' + ip.trim() + ':' + PORT));
    });
    const online = (ts.status || '').split('\n').filter((l) => l.trim()).length;
    console.log(line('    在线设备 ' + online + ' 台'));
  } else if (ips.tailscale.length) {
    console.log(line('Tailscale：'));
    ips.tailscale.forEach((i) => console.log(line('    http://' + i.ip + ':' + PORT)));
  } else {
    console.log(line('· 未检测到 Tailscale'));
    console.log(line('  想在外面也能访问，看目录里的 REMOTE-ACCESS.md'));
  }

  console.log('\n  ==========================================');
  if (!local.ok) {
    console.log('  结论：服务没跑起来，先启动它。\n');
  } else if (HOST === '127.0.0.1') {
    console.log('  结论：服务正常，但只有本机能访问。改 server.host 为 0.0.0.0 即可放开。\n');
  } else if (!ts.installed) {
    console.log('  结论：局域网内已经可用，手机连 WiFi 打开上面的地址试试。\n');
  } else {
    console.log('  结论：一切就绪，局域网和 Tailscale 都可以访问。\n');
  }
})();
