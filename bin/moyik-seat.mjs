#!/usr/bin/env node
// moyik-seat: the seat helper. See docs/seat-helper.md.

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, saveConfig, loadAuth, saveAuth, clearAuth, clearAll, configDir, DEFAULT_ORIGIN, log } from '../seat/config.mjs';
import { pendingCards, answerCard } from '../seat/confirm.mjs';
import { store } from '../seat/secrets.mjs';
import { spawnSync } from 'node:child_process';
import { login, revoke } from '../seat/oauth.mjs';
import { detectAgents, hasCommand } from '../seat/agents.mjs';
import { readQuota, describe } from '../seat/quota.mjs';
import { runSeat, agentsOf } from '../seat/run.mjs';
import { NeedsLogin, Connector } from '../seat/mcp.mjs';
import { installService, uninstallService } from '../seat/service.mjs';

const HELP = `moyik-seat：Moyik 座位助手。轮到你的席位时，叫醒你电脑上的 Claude Code 或 Codex 替你发言、做任务卡。

  moyik-seat setup [选项]     一次装好：选本机 AI、登录 Moyik、设为开机自动运行
  moyik-seat start            在前台守候（setup 之后一般不用手动运行）
  moyik-seat status           看看现在的设置和登录
  moyik-seat test             只连一次 Moyik，确认能读到你的席位
  moyik-seat quota            看本机 AI 还剩多少额度（5 小时和每周）
  moyik-seat cards            看等你确认的任务卡
  moyik-seat approve <卡>     同意让本机 AI 做这张任务卡
  moyik-seat reject <卡>      不做这张任务卡
  moyik-seat logout           收回这台电脑的 Moyik 登录
  moyik-seat uninstall        停止自动运行，收回登录，删掉助手留在这台电脑上的所有东西

助手不会自己更新。要更新，重新运行安装命令。
任务卡每次都要你在这台电脑上确认，网页上的操作不能代替。
你用的是自己的 AI 账号，遵守 Anthropic、OpenAI 等各家的使用条款是你自己的责任。

setup 选项：
  --agent claude|codex|custom   用哪个本机 AI（默认自动找；两个都装了就都用，用逗号排先后，如 claude,codex）
  --agent-cmd "<命令>"          agent=custom 时：从标准输入读提示、把回答打印出来的命令
  --model <名字>                传给本机 AI 的模型名（可选）
  --repo <目录>                 做任务卡用的本机仓库（可选，任务卡目前只支持 Claude Code）
  --check "<命令>"              任务卡改完后由助手运行的检查命令，比如 "npm test"（可选）
  --group <空间 id>             只守这一个空间（可选）
  --no-service                  不设为自动运行
  --origin <地址>               默认 ${DEFAULT_ORIGIN}
`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: 'string' },
    'agent-cmd': { type: 'string' },
    model: { type: 'string' },
    repo: { type: 'string' },
    check: { type: 'string' },
    group: { type: 'string' },
    origin: { type: 'string' },
    'no-service': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

async function setup() {
  const saved = loadConfig();
  const asked = opt.agent ? opt.agent.split(',').map((a) => a.trim()).filter(Boolean) : null;
  const agents = asked ?? (saved.agents?.length ? saved.agents : configuredBefore() ? [saved.agent] : detectAgents());
  if (!agents.length || agents.some((a) => !['claude', 'codex', 'custom'].includes(a))) fail('没找到 claude 或 codex 命令。先装好其中一个并登录，或用 --agent custom --agent-cmd "<命令>"。');
  if (agents.includes('custom') && agents.length > 1) fail('agent=custom 只能单独用');
  for (const a of agents) if (a !== 'custom' && !hasCommand(a)) fail(`找不到 ${a} 命令。先装好它，在终端里登录一次，再运行 setup。`);
  const agent = agents[0];
  if (agent === 'custom' && !(opt['agent-cmd'] ?? loadConfig().agentCmd)) fail('agent=custom 需要 --agent-cmd');
  if (opt.repo && !existsSync(opt.repo)) fail(`--repo 的目录不存在：${opt.repo}`);
  if (opt.repo && !existsSync(resolve(opt.repo, '.git'))) fail(`--repo 不是 git 仓库：${opt.repo}`);

  const cfg = saveConfig({
    agent,
    agents,
    agentCmd: opt['agent-cmd'],
    model: opt.model,
    repo: opt.repo && resolve(opt.repo),
    checkCommand: opt.check,
    groupId: opt.group,
    origin: opt.origin ?? loadConfig().origin,
  });
  console.log(`本机 AI：${agents.join('、')}${agents.length > 1 ? '（轮到你时先用有余量的那个）' : ''}。设置存在 ${configDir()}`);
  await showQuota({ ...cfg, agents });
  await doLogin(cfg);
  await doTest(cfg);
  if (!opt['no-service']) console.log(installService());
  console.log('\n好了。轮到你的席位时，助手会叫醒本机 AI 替你发言。在 Moyik 网页上能看到每条发言是谁的 AI 写的。');
}

async function doLogin(cfg) {
  const old = loadAuth();
  if (old?.accessToken && old.origin === cfg.origin) {
    console.log('已经登录过 Moyik，沿用。要换账号先运行 moyik-seat logout。');
    return;
  }
  const label = cfg.agent === 'claude' ? 'Claude Code' : cfg.agent === 'codex' ? 'Codex' : '本机 AI';
  const where = saveAuth(await login(cfg.origin, { label }));
  console.log(where === 'keychain' ? '已登录 Moyik，授权存在系统钥匙串里。' : `已登录 Moyik。这台电脑没有可用的系统钥匙串，授权存在只有你能读的文件里（${configDir()}）。`);
}

async function doTest(cfg) {
  const auth = loadAuth();
  if (!auth?.accessToken) fail('还没有登录，先运行 moyik-seat setup');
  const conn = new Connector(auth, saveAuth);
  const text = await conn.call('moot_wait_for_turn', { max_wait_seconds: 0, ...(cfg.groupId ? { group_id: cfg.groupId } : {}) });
  console.log(`连上了。Moyik 说：${text.split('\n')[0].slice(0, 120)}`);
}

function configuredBefore() {
  return existsSync(resolve(configDir(), 'config.json'));
}

async function showQuota(cfg) {
  for (const a of agentsOf(cfg)) {
    if (a === 'custom') continue;
    console.log(`${a}：${describe(await readQuota(a))}`);
  }
}

async function main() {
  const cmd = positionals[0] ?? 'help';
  const cfg = loadConfig();
  if (opt.help || cmd === 'help') return console.log(HELP);
  if (cmd === 'setup') return setup();
  if (cmd === 'login') return doLogin(cfg);
  if (cmd === 'test') return doTest(cfg);
  if (cmd === 'start') return runSeat(cfg);
  if (cmd === 'quota') return showQuota(cfg);
  if (cmd === 'status') {
    const auth = loadAuth();
    console.log(JSON.stringify({ ...cfg, signedIn: !!auth?.accessToken, tokenStore: store(), folder: configDir() }, null, 2));
    return;
  }
  if (cmd === 'logout') {
    await revoke(loadAuth());
    clearAuth();
    return console.log('已收回这台电脑的 Moyik 登录。也可以在 Moyik 网页「连接我的 AI」里看到并删除它。');
  }
  if (cmd === 'cards') {
    const list = pendingCards();
    if (!list.length) return console.log('现在没有等你确认的任务卡。');
    for (const c of list) console.log(`[${c.key}]\n${c.plan}\n`);
    return console.log('同意：moyik-seat approve <卡>；不做：moyik-seat reject <卡>');
  }
  if (cmd === 'approve' || cmd === 'reject') {
    if (!positionals[1]) fail(`用法：moyik-seat ${cmd} <卡>`);
    return console.log(answerCard(positionals[1], cmd === 'approve') ? (cmd === 'approve' ? '已同意，助手马上开始。' : '已拒绝，这张卡不做。') : '没有这张等确认的卡，先运行 moyik-seat cards 看看。');
  }
  if (cmd === 'uninstall') {
    console.log(uninstallService());
    await revoke(loadAuth()).catch(() => {});
    if (cfg.repo) spawnSync('git', ['worktree', 'prune'], { cwd: cfg.repo, stdio: 'ignore' });
    clearAll();
    return console.log(`已收回 Moyik 登录，删掉了 ${configDir()}。助手推过的分支留在你的仓库里，不会动。最后可以运行 npm uninstall -g moyik-seat-kit 删掉程序本身。`);
  }
  fail(HELP);
}

main().catch((err) => {
  if (err instanceof NeedsLogin) {
    log(`${err.message}，请运行 moyik-seat setup 重新登录`);
    process.exit(0); // the service is not restarted in a loop for a login only the owner can fix
  }
  console.error(err.message ?? err);
  process.exit(1);
});
