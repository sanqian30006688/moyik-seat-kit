// Keeping the helper running: a per-user background service that starts at login.
// macOS: a LaunchAgent. Linux: a systemd user unit. Windows: a scheduled task at logon.
// Nothing runs as administrator or root.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { join } from 'node:path';
import { configDir } from './config.mjs';

const LABEL = 'com.moyik.seat';
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The command that starts the helper: this Node, this script, `start`. The PATH of the shell that installed it is kept, so the AI CLIs are found. */
export function startCommand(script = process.argv[1]) {
  return { node: process.execPath, script, path: process.env.PATH ?? '' };
}

export function launchdPlist({ node, script, path }, logFile) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict></plist>
`;
}

export function systemdUnit({ node, script, path }) {
  const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
  return `[Unit]
Description=Moyik seat helper
After=network-online.target

[Service]
ExecStart=${q(node)} ${q(script)} start
Environment=${q(`PATH=${path}`)}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

export function installService() {
  const cmd = startCommand();
  const os = platform();
  if (os === 'darwin') {
    const dir = join(homedir(), 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${LABEL}.plist`);
    writeFileSync(file, launchdPlist(cmd, join(configDir(), 'service.log')));
    const domain = `gui/${userInfo().uid}`;
    run('launchctl', ['bootout', `${domain}/${LABEL}`]);
    const r = run('launchctl', ['bootstrap', domain, file]);
    if (r.status !== 0) throw new Error(`launchctl 没有装上：${r.stderr.trim()}`);
    return `已装为登录后自动运行（${file}）`;
  }
  if (os === 'linux') {
    const dir = join(homedir(), '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'moyik-seat.service'), systemdUnit(cmd));
    run('systemctl', ['--user', 'daemon-reload']);
    const r = run('systemctl', ['--user', 'enable', '--now', 'moyik-seat.service']);
    if (r.status !== 0) throw new Error(`systemctl 没有装上：${r.stderr.trim()}`);
    return '已装为登录后自动运行（systemd 用户服务 moyik-seat）';
  }
  if (os === 'win32') {
    const tr = `"${cmd.node}" "${cmd.script}" start`;
    const r = run('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', 'MoyikSeat', '/TR', tr]);
    if (r.status !== 0) throw new Error(`schtasks 没有装上：${(r.stderr || r.stdout).trim()}`);
    run('schtasks', ['/Run', '/TN', 'MoyikSeat']);
    return '已装为登录后自动运行（任务计划 MoyikSeat）';
  }
  throw new Error(`这个系统（${os}）还不支持自动运行，请手动运行 moyik-seat start`);
}

export function uninstallService() {
  const os = platform();
  if (os === 'darwin') {
    run('launchctl', ['bootout', `gui/${userInfo().uid}/${LABEL}`]);
    const file = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    if (existsSync(file)) rmSync(file);
  } else if (os === 'linux') {
    run('systemctl', ['--user', 'disable', '--now', 'moyik-seat.service']);
    const file = join(homedir(), '.config', 'systemd', 'user', 'moyik-seat.service');
    if (existsSync(file)) rmSync(file);
    run('systemctl', ['--user', 'daemon-reload']);
  } else if (os === 'win32') {
    run('schtasks', ['/Delete', '/F', '/TN', 'MoyikSeat']);
  }
  return '已停止并移除自动运行';
}
