// The owner's own yes, on this computer, before a task card runs. A click on the website does not
// count. In a terminal the helper asks directly; as a background service it leaves the card in
// ~/.moyik-seat/pending/, shows a system notification, and waits for `moyik-seat approve`.

import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import { configDir } from './config.mjs';

const dir = () => join(configDir(), 'pending');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const cardKey = (card) => String(card.repo?.branch ?? card.id).replace(/^moyik\/card-/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

function notify(title, body) {
  const os = platform();
  const run = (cmd, args) => {
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
    } catch {}
  };
  if (os === 'darwin') run('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
  else if (os === 'linux') run('notify-send', [title, body]);
  else if (os === 'win32') run('msg', ['*', `${title}: ${body}`]);
}

/** Asks the owner. Resolves true only on an explicit yes; no answer by `minutes` is a no. */
export async function askOwner(card, plan, { minutes = 30, interactive = process.stdin.isTTY, log = console.log } = {}) {
  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await Promise.race([rl.question(`\n${plan}\n\n要让本机 AI 做这张卡吗？输入 y 同意，其他任何输入都是不做：`), sleep(minutes * 60_000).then(() => '')]);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  }
  const key = cardKey(card);
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const base = join(dir(), key);
  rmSync(`${base}.ok`, { force: true });
  rmSync(`${base}.no`, { force: true });
  writeFileSync(`${base}.txt`, plan + '\n', { mode: 0o600 });
  notify('Moyik：有一张任务卡等你确认', `运行 moyik-seat approve ${key} 同意`);
  log(`任务卡等你确认：运行 moyik-seat cards 查看，moyik-seat approve ${key} 同意，moyik-seat reject ${key} 不做`);
  const until = Date.now() + minutes * 60_000;
  try {
    while (Date.now() < until) {
      if (existsSync(`${base}.ok`)) return true;
      if (existsSync(`${base}.no`)) return false;
      await sleep(3000);
    }
    return false;
  } finally {
    for (const ext of ['txt', 'ok', 'no']) rmSync(`${base}.${ext}`, { force: true });
  }
}

export function pendingCards() {
  if (!existsSync(dir())) return [];
  return readdirSync(dir())
    .filter((f) => f.endsWith('.txt'))
    .map((f) => ({ key: f.slice(0, -4), plan: readFileSync(join(dir(), f), 'utf8').trim() }));
}

export function answerCard(key, yes) {
  const safe = String(key).replace(/[^A-Za-z0-9_-]/g, '_');
  if (!existsSync(join(dir(), `${safe}.txt`))) return false;
  writeFileSync(join(dir(), `${safe}.${yes ? 'ok' : 'no'}`), '', { mode: 0o600 });
  return true;
}
