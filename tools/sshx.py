#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
远程主机操作工具（凭据只从环境变量读，不写入任何文件）

用法：
  HUB_SSH_HOST=x HUB_SSH_PORT=y HUB_SSH_USER=z HUB_SSH_PASS=w \
    python tools/sshx.py exec "uname -a"

  ... python tools/sshx.py put   <本地文件> <远程路径>
  ... python tools/sshx.py putdir <本地目录> <远程目录>
  ... python tools/sshx.py ls    <远程目录>
"""
import os
import sys
import stat
import posixpath

import paramiko

HOST = os.environ.get("HUB_SSH_HOST", "")
PORT = int(os.environ.get("HUB_SSH_PORT", "22"))
USER = os.environ.get("HUB_SSH_USER", "root")
PASS = os.environ.get("HUB_SSH_PASS", "")

EXCLUDE_DIRS = {"node_modules", ".git", "shots", ".edge-profile", ".deploytest", "__pycache__"}
# config.json 含真实密钥，不随代码上传；models.cache.json 由服务器自行生成
EXCLUDE_FILES = {"server.log", "ui.log", "scan.log", ".DS_Store", "config.json", "models.cache.json"}


def connect():
    if not HOST or not PASS:
        print("[错误] 缺少 HUB_SSH_HOST / HUB_SSH_PASS 环境变量", file=sys.stderr)
        sys.exit(2)
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        HOST, port=PORT, username=USER, password=PASS,
        timeout=25, banner_timeout=40, auth_timeout=40,
        look_for_keys=False, allow_agent=False,
    )
    return c


def run(c, cmd, timeout=600):
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def do_exec(c, cmd):
    code, out, err = run(c, cmd)
    if out:
        sys.stdout.write(out)
    if err:
        sys.stdout.write("\n--- stderr ---\n" + err)
    print("\n[exit] %d" % code)
    return code


def ensure_remote_dir(sftp, path):
    parts, cur = path.strip("/").split("/"), ""
    for p in parts:
        cur += "/" + p
        try:
            sftp.stat(cur)
        except IOError:
            sftp.mkdir(cur)


def do_put(c, local, remote):
    sftp = c.open_sftp()
    ensure_remote_dir(sftp, posixpath.dirname(remote))
    sftp.put(local, remote)
    size = sftp.stat(remote).st_size
    print("[上传] %s -> %s (%d bytes)" % (local, remote, size))
    sftp.close()


def do_putdir(c, localdir, remotedir):
    if not os.path.isdir(localdir):
        print("[错误] 本地目录不存在: %s" % localdir, file=sys.stderr)
        print("       提示：Git Bash 下要传 Windows 路径，用 $(pwd -W) 而不是 $(pwd)", file=sys.stderr)
        sys.exit(3)
    sftp = c.open_sftp()
    count = 0
    total = 0
    ensure_remote_dir(sftp, remotedir)
    for root, dirs, files in os.walk(localdir):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        rel = os.path.relpath(root, localdir).replace("\\", "/")
        rdir = remotedir if rel == "." else posixpath.join(remotedir, rel)
        ensure_remote_dir(sftp, rdir)
        for f in files:
            if f in EXCLUDE_FILES:
                continue
            lp = os.path.join(root, f)
            rp = posixpath.join(rdir, f)
            sftp.put(lp, rp)
            count += 1
            total += os.path.getsize(lp)
    sftp.close()
    if count == 0:
        print("[错误] 一个文件都没上传，请检查路径：%s" % localdir, file=sys.stderr)
        sys.exit(3)
    print("[上传] %d 个文件，共 %.1f KB -> %s" % (count, total / 1024.0, remotedir))


def do_ls(c, path):
    sftp = c.open_sftp()
    for a in sorted(sftp.listdir_attr(path), key=lambda x: x.filename):
        kind = "d" if stat.S_ISDIR(a.st_mode) else "-"
        print("  %s %10d  %s" % (kind, a.st_size, a.filename))
    sftp.close()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    action = sys.argv[1]
    c = connect()
    try:
        if action == "exec":
            sys.exit(do_exec(c, sys.argv[2]))
        elif action == "put":
            do_put(c, sys.argv[2], sys.argv[3])
        elif action == "putdir":
            do_putdir(c, sys.argv[2], sys.argv[3])
        elif action == "ls":
            do_ls(c, sys.argv[2])
        else:
            print("未知操作: %s" % action)
            sys.exit(1)
    finally:
        c.close()


if __name__ == "__main__":
    main()
