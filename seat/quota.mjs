// How much of the owner's own AI plan is left on this computer: the 5-hour and weekly windows of
// Claude Code and Codex, read through each CLI's own local interface. The helper asks the CLI;
// the CLI answers from the sign-in it already has. The helper never reads, copies or sends that
// sign-in, an account id, an email or a plan name. What leaves this computer is only: which local
// AI, how full each window is, and when it resets.

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { childEnv } from './agents.mjs';

const isWin = platform() === 'win32';

/** At or above this share of a window used, the AI is "running low". */
export const LOW_AT = 80;
/** At or above this, the window is spent. */
export const OUT_AT = 100;

/**
 * @typedef {object} QuotaWindow
 * @property {'five_hour'|'weekly'|'other'} kind
 * @property {number} used        Share of the window used, 0-100, whole number.
 * @property {string|null} resetsAt  ISO time the window resets.
 */

/**
 * @typedef {object} Quota
 * @property {string} agent       'claude' | 'codex'
 * @property {'ok'|'low'|'out'|'unknown'} state
 * @property {QuotaWindow[]} windows
 * @property {boolean} plan       false when the AI runs on an API key (no plan windows apply)
 * @property {string} checkedAt
 */

const pct = (n) => Math.max(0, Math.min(100, Math.round(Number(n))));
const isoFromSeconds = (s) => (Number.isFinite(Number(s)) && Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);
const isoFrom = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isoFromSeconds(v);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** ok / low / out from the windows. A window already past its reset time no longer counts. */
export function stateOf(windows, now = Date.now()) {
  const live = windows.filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > now);
  if (live.length === 0) return windows.length ? 'ok' : 'unknown';
  const worst = Math.max(...live.map((w) => w.used));
  return worst >= OUT_AT ? 'out' : worst >= LOW_AT ? 'low' : 'ok';
}

function quota(agent, windows, { plan = true, forceOut = false } = {}) {
  const kept = windows.filter((w) => Number.isFinite(w.used)).slice(0, 6);
  const state = forceOut ? 'out' : plan ? stateOf(kept) : 'unknown';
  return { agent, state, windows: kept, plan, checkedAt: new Date().toISOString() };
}

/** Claude Code's structured /usage answer (get_usage). Two shapes exist; both are read. */
export function fromClaudeUsage(res) {
  if (!res || typeof res !== 'object') return null;
  if (res.rate_limits_available === false || res.rate_limits == null) return quota('claude', [], { plan: false });
  const rl = res.rate_limits;
  const windows = [];
  if (Array.isArray(rl.limits)) {
    for (const row of rl.limits) {
      const kind = String(row.kind ?? '');
      // Only the plan-wide meters: per-model rows would repeat the same window.
      const k = kind === 'session' ? 'five_hour' : kind === 'weekly_all' ? 'weekly' : null;
      if (k && Number.isFinite(Number(row.percent))) windows.push({ kind: k, used: pct(row.percent), resetsAt: isoFrom(row.resets_at) });
    }
  } else {
    for (const [key, kind] of [['five_hour', 'five_hour'], ['seven_day', 'weekly']]) {
      const w = rl[key];
      if (w && w.utilization != null) windows.push({ kind, used: pct(w.utilization), resetsAt: isoFrom(w.resets_at) });
    }
  }
  return quota('claude', windows);
}

/** One rate_limit_event from a Claude Code run (utilization is a fraction, resetsAt in seconds). */
export function fromClaudeEvent(info, prev = null) {
  if (!info || typeof info !== 'object') return prev;
  const kind = info.rateLimitType === 'five_hour' ? 'five_hour' : info.rateLimitType === 'seven_day' ? 'weekly' : null;
  const windows = (prev?.windows ?? []).filter((w) => w.kind !== kind);
  if (kind && Number.isFinite(Number(info.utilization))) windows.push({ kind, used: pct(Number(info.utilization) * 100), resetsAt: isoFromSeconds(info.resetsAt) });
  return quota('claude', windows, { forceOut: info.status === 'rejected' });
}

/** Codex's account/rateLimits/read answer. Only the windows are kept: never the account id or plan. */
export function fromCodexLimits(res) {
  const snap = res?.rateLimitsByLimitId?.codex ?? res?.rateLimits;
  if (!snap) return null;
  const windows = [];
  for (const w of [snap.primary, snap.secondary]) {
    if (!w || !Number.isFinite(Number(w.usedPercent))) continue;
    const mins = Number(w.windowDurationMins);
    const kind = mins === 300 ? 'five_hour' : mins === 10080 ? 'weekly' : 'other';
    windows.push({ kind, used: pct(w.usedPercent), resetsAt: isoFromSeconds(w.resetsAt) });
  }
  return quota('codex', windows, { forceOut: Boolean(snap.rateLimitReachedType) || res?.ordinaryUsageAllowed === false });
}

/**
 * Starts `cmd args`, writes `lines` as JSON lines, and resolves with the first answer `pick` accepts.
 * Killed after `ms`. Resolves null on any failure: quota is a nice-to-have, never a reason to stop.
 */
function askCli(cmd, args, lines, pick, { ms = 20_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    let child;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child?.stdin?.end();
        child?.kill('SIGTERM');
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), ms);
    try {
      child = spawnImpl(cmd, args, { shell: isWin, stdio: ['pipe', 'pipe', 'ignore'], env: childEnv(), windowsHide: true });
    } catch {
      return finish(null);
    }
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => {
      buf += d.toString();
      if (buf.length > 4_000_000) return finish(null);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const got = pick(msg);
        if (got !== undefined) return finish(got);
      }
    });
    for (const l of lines) child.stdin.write(JSON.stringify(l) + '\n');
  });
}

/**
 * Claude Code: one short session that asks for the /usage data and nothing else. No prompt is
 * sent, so no plan usage is spent. The interface is marked experimental by Anthropic; when it
 * changes, this answers null and the helper falls back to what each run reports.
 */
export async function readClaudeQuota(opts = {}) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--tools', ''];
  return askCli(
    'claude',
    args,
    [
      { type: 'control_request', request_id: 'moyik-init', request: { subtype: 'initialize' } },
      { type: 'control_request', request_id: 'moyik-usage', request: { subtype: 'get_usage', skip_behaviors: true } },
    ],
    (m) => {
      if (m.type !== 'control_response' || m.response?.request_id !== 'moyik-usage') return undefined;
      return m.response.subtype === 'success' ? fromClaudeUsage(m.response.response) : null;
    },
    opts,
  );
}

/** Codex: its local app server answers account/rateLimits/read. */
export async function readCodexQuota(opts = {}) {
  return askCli(
    'codex',
    ['app-server'],
    [
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'moyik-seat', version: '0.3.2' } } },
      { method: 'initialized' },
      { id: 2, method: 'account/rateLimits/read' },
    ],
    (m) => (m.id === 2 ? (m.result ? fromCodexLimits(m.result) : null) : undefined),
    opts,
  );
}

export function readQuota(agent, opts) {
  if (agent === 'claude') return readClaudeQuota(opts);
  if (agent === 'codex') return readCodexQuota(opts);
  return Promise.resolve(null);
}

const RANK = { ok: 0, unknown: 1, low: 2, out: 3 };

/**
 * Which local AI takes this turn: the first in the owner's order that is not spent, preferring
 * one with room over one running low. `able(agent)` says whether it can do this kind of turn.
 * Returns null when every able AI is spent.
 */
export function pickAgent(agents, quotas, able = () => true) {
  const ranked = agents
    .filter(able)
    .map((a, i) => ({ a, i, r: RANK[quotas[a]?.state ?? 'unknown'] }))
    .sort((x, y) => x.r - y.r || x.i - y.i);
  const best = ranked[0];
  return best && best.r < RANK.out ? best.a : null;
}

/** The earliest time a spent AI gets room again, or null. */
export function nextReset(quotas) {
  const times = Object.values(quotas)
    .filter((q) => q?.state === 'out')
    .flatMap((q) => q.windows.filter((w) => w.used >= OUT_AT && w.resetsAt).map((w) => Date.parse(w.resetsAt)))
    .filter((t) => t > Date.now());
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/** What is sent to Moyik for one AI: no ids, no account, no plan name. */
export function reportArgs(q) {
  return {
    agent: q.agent,
    state: q.state,
    plan: q.plan,
    windows: q.windows.map((w) => ({ kind: w.kind, used: w.used, ...(w.resetsAt ? { resets_at: w.resetsAt } : {}) })),
  };
}

/** One short line for the log and for `moyik-seat quota`. */
export function describe(q) {
  if (!q) return '读不到额度';
  if (!q.plan) return '没有订阅额度窗口（用的是 API key，或还没登录）';
  const name = { five_hour: '5 小时', weekly: '每周', other: '其他' };
  const parts = q.windows.map((w) => `${name[w.kind]}已用 ${w.used}%${w.resetsAt ? `（${new Date(w.resetsAt).toLocaleString()} 重置）` : ''}`);
  const word = { ok: '额度够', low: '快用完了', out: '已用完', unknown: '不确定' }[q.state];
  return `${word}${parts.length ? '：' + parts.join('，') : ''}`;
}
