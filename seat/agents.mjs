// Waking the owner's own AI on this computer. The helper starts the owner's CLI as a child
// process; the CLI uses whatever sign-in or subscription the owner already set up for it.
// The helper never reads, copies or passes on those credentials, and the AI never sees the
// helper's Moyik sign-in.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { fromClaudeEvent } from './quota.mjs';

const isWin = platform() === 'win32';

/** Claude Code deny rules for secret-bearing files; deny rules win over any allow. */
export const DENY_READ = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*', '**/.ssh/**', '**/.aws/**', '**/.npmrc', '**/.netrc', '**/.git-credentials', '**/credentials*', '**/secrets*']
  .flatMap((p) => [`Read(${p})`, `Grep(${p})`]);

/** Names that usually hold secrets for other services. */
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|_KEY$|KEY_ID$|^AWS_|^GITHUB_|^GH_|^NPM_|^GOOGLE_|^AZURE_|^SUPABASE|^DATABASE_URL$|^STRIPE)/i;
/** The local AI's own sign-in settings, which it needs to run. */
const AGENT_ENV = /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_)/;

/** The environment the local AI is started with: everything except other services' secrets. */
export function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (AGENT_ENV.test(k) || !SECRET_ENV.test(k)) out[k] = v;
  return out;
}

/**
 * The environment the owner's check command runs in. It runs code the AI has just written for a
 * card other people worded, so it gets no secrets at all, not even the local AI's own sign-in.
 */
export function checkEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v;
  return out;
}

/** Is this CLI installed and on PATH? */
export function hasCommand(cmd) {
  const r = spawnSync(isWin ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

export function detectAgent() {
  if (hasCommand('claude')) return 'claude';
  if (hasCommand('codex')) return 'codex';
  return null;
}

/** Every supported AI CLI on this computer, Claude Code first. */
export function detectAgents() {
  return ['claude', 'codex'].filter(hasCommand);
}

/**
 * The command line for one run.
 * mode 'speak': no tools at all, or read-only file tools when the owner named a folder to consult.
 * mode 'card': file tools and edits inside the card's work folder, plus only the commands listed.
 */
export function agentCommand(cfg, { mode, cwd, allowRules = [], outFile, onQuota = () => {} }) {
  if (cfg.agent === 'claude') {
    // stream-json: the answer comes last, and Claude Code also says how full the plan's windows are.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'];
    // Files that usually hold secrets stay unreadable, whatever the prompt says.
    args.push('--disallowedTools', ...DENY_READ);
    // Writing a speech needs no tools: nothing on this computer can end up in a speech.
    if (mode === 'speak') args.push('--tools', '');
    else {
      // No shell, no web: read inside the work folder, write only where the rules allow, refuse everything else.
      args.push('--tools', 'Read,Grep,Glob,Edit,Write', '--permission-mode', 'dontAsk');
      args.push('--allowedTools', ...allowRules);
    }
    if (cfg.model) args.push('--model', cfg.model);
    return { cmd: 'claude', args, cwd, parse: (stdout) => parseClaude(stdout, onQuota) };
  }
  if (cfg.agent === 'codex') {
    if (mode !== 'speak') throw new Error('任务卡目前只支持 Claude Code');
    const args = ['exec', '--skip-git-repo-check', '--sandbox', mode === 'speak' ? 'read-only' : 'workspace-write', '-C', cwd, '--output-last-message', outFile];
    if (cfg.model) args.push('--model', cfg.model);
    args.push('-');
    return { cmd: 'codex', args, cwd, parse: () => readFileSync(outFile, 'utf8') };
  }
  if (cfg.agent === 'custom' && cfg.agentCmd) {
    if (mode !== 'speak') throw new Error('任务卡目前只支持 Claude Code');
    return { cmd: cfg.agentCmd, args: [], cwd, shell: true, parse: (stdout) => stdout };
  }
  throw new Error(`不认识的本机 AI：${cfg.agent}`);
}

/** The final answer from Claude Code's output. Plan-window events on the way are passed to `onQuota`. */
export function parseClaude(stdout, onQuota = () => {}) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  let result = null;
  let quota = null;
  for (const line of lines) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === 'rate_limit_event') quota = fromClaudeEvent(j.rate_limit_info, quota);
    else if (j.type === 'result' || (lines.length === 1 && 'result' in j)) result = j;
  }
  if (quota) onQuota(quota);
  if (!result) return stdout;
  if (result.is_error) throw new Error(String(result.result ?? 'Claude Code 报错'));
  return String(result.result ?? '');
}

/**
 * Runs the owner's AI once with `prompt` on stdin and returns its final answer as text.
 * Killed after `minutes`. Output is kept in memory only.
 */
export async function runAgent(cfg, prompt, { mode = 'speak', cwd, allowRules = [], minutes = cfg.turnMinutes ?? 8, spawnImpl = spawn, onQuota } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'moyik-seat-'));
  const workdir = cwd ?? scratch;
  const outFile = join(scratch, 'answer.txt');
  const plan = agentCommand(cfg, { mode, cwd: workdir, allowRules, outFile, onQuota });
  try {
    const { code, stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawnImpl(plan.cmd, plan.args, { cwd: workdir, shell: plan.shell ?? isWin, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(), windowsHide: true });
      let out = '';
      let err = '';
      const cap = (s, chunk) => (s.length < 2_000_000 ? s + chunk : s);
      child.stdout.on('data', (d) => (out = cap(out, d.toString())));
      child.stderr.on('data', (d) => (err = cap(err, d.toString())));
      const timer = setTimeout(() => child.kill('SIGTERM'), minutes * 60_000);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e.code === 'ENOENT' ? new Error(`找不到 ${plan.cmd}。请先装好并登录它，或用 moyik-seat setup 换一个`) : e);
      });
      child.on('close', (c, signal) => {
        clearTimeout(timer);
        resolve({ code: signal ? `killed (${signal})` : c, stdout: out, stderr: err });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
    if (code !== 0) {
      // A run stopped by the plan's limit still says so on the way out: keep that for the quota.
      if (plan.cmd === 'claude') try { parseClaude(stdout, onQuota); } catch {}
    }
    if (code !== 0) throw new Error(`${plan.cmd} 没有正常结束（${code}）${stderr ? '：' + stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300) : ''}`);
    return plan.parse(stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
