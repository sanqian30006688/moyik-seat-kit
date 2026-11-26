// The resident loop: wait for the owner's turn on Moyik, wake the owner's AI on this computer,
// hand in what it wrote. One turn at a time.

import { Connector, NeedsLogin } from './mcp.mjs';
import { readWait, speechPrompt, extractJson, speakArgs } from './brief.mjs';
import { runAgent } from './agents.mjs';
import { doCard } from './card.mjs';
import { askOwner } from './confirm.mjs';
import { loadAuth, saveAuth, loadSeen, saveSeen, log, shortId } from './config.mjs';
import { readQuota, pickAgent, nextReset, reportArgs, describe, stateOf } from './quota.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Handles one turn. Returns a word for the log. Exported for tests. */
export async function handleTurn(conn, cfg, turn, { ask = (p, o) => runAgent(cfg, p, o), speakSchema, confirm = (plan) => askOwner(turn.card, plan, { log }) } = {}) {
  // A card's review step, or a card that names no files, is answered like a speech: from the brief, with no tools.
  const works = turn.card && turn.card.step === 'write' && turn.card.scope.length > 0;
  if (turn.card && !works) log(turn.card.step === 'review' ? '任务卡的审阅轮，按发言处理' : '这张任务卡没写能改哪些文件，不在本机仓库动手，按发言处理');
  if (works) {
    // Moyik now takes card branches only from the member's own fork, which the helper cannot push to yet; files it can hand in.
    const canPushBranch = false;
    const args = await doCard(turn.card, cfg, ask, (m) => log(m), confirm, { canPushBranch });
    await conn.call('moot_speak', { ...args, turn_id: turn.turnId });
    return args.branch ? `已推分支 ${args.branch.name}` : args.files ? '已交文件' : '没有动手或没有改动';
  }
  const prompt = speechPrompt(turn.brief);
  let answer = extractJson(await ask(prompt, { mode: 'speak' }));
  if (!answer) answer = extractJson(await ask(`${prompt}\n上一次没有输出合法的 JSON。这次只输出 JSON 对象本身。`, { mode: 'speak' }));
  const args = answer && speakArgs(answer, turn.turnId, speakSchema);
  if (!args) throw new Error('本机 AI 没有给出能交的发言，这一轮没有交（Moyik 会按席位设置处理）');
  const reply = await conn.call('moot_speak', args);
  // moot_speak asks for a second hand-in when the round was never read; the helper always read it first.
  return reply.startsWith('这条还没收下') ? '没收下' : '已交';
}

/** The local AIs the owner set up, in their order. */
export const agentsOf = (cfg) => (cfg.agent === 'custom' ? ['custom'] : [...new Set([...(cfg.agents ?? []), cfg.agent].filter(Boolean))]);

/**
 * Keeps the last known quota of each local AI, and tells Moyik when the connector takes it.
 * Only the state, each window's share used and its reset time are sent.
 */
export class QuotaKeeper {
  constructor(cfg, conn, { canReport = false, read = readQuota, everyMs = 10 * 60_000 } = {}) {
    this.agents = agentsOf(cfg);
    this.conn = conn;
    this.canReport = canReport;
    this.read = read;
    this.everyMs = everyMs;
    this.quotas = {};
    this.lastRead = 0;
    this.lastSent = '';
  }

  /** Asks each CLI again when it is time (or `force`), then reports what changed. */
  async refresh(force = false) {
    if (!force && Date.now() - this.lastRead < this.everyMs) return;
    this.lastRead = Date.now();
    for (const a of this.agents) {
      const q = await this.read(a).catch(() => null);
      if (q) this.quotas[a] = q;
    }
    await this.report();
  }

  /** What a run just said about its own plan. */
  async seen(q) {
    if (!q) return;
    const prev = this.quotas[q.agent];
    // A run only sees the window it touched; keep the other one from the last full read.
    const kinds = new Set(q.windows.map((w) => w.kind));
    const windows = [...q.windows, ...(prev?.windows ?? []).filter((w) => !kinds.has(w.kind))];
    this.quotas[q.agent] = { ...q, windows, state: q.state === 'out' ? 'out' : stateOf(windows) };
    await this.report();
  }

  async report() {
    const list = this.agents.map((a) => this.quotas[a]).filter(Boolean);
    if (!this.canReport || list.length === 0) return;
    const args = { agents: list.map(reportArgs) };
    const key = JSON.stringify(args);
    if (key === this.lastSent) return;
    try {
      await this.conn.call('moot_report_quota', args);
      this.lastSent = key;
    } catch (err) {
      if (err instanceof NeedsLogin) throw err;
      log(`额度没报上（${err.message}）`);
    }
  }

  /** Which AI takes this turn, or null when every one that could is spent. */
  pick(able) {
    return pickAgent(this.agents, this.quotas, able);
  }

  line() {
    return this.agents.map((a) => `${a}：${describe(this.quotas[a])}`).join('；');
  }
}

export async function runSeat(cfg, { once = false, signal } = {}) {
  let auth = loadAuth();
  if (!auth?.accessToken) throw new NeedsLogin('还没有登录');
  const conn = new Connector(auth, (a) => saveAuth(a));
  const tools = await conn.listTools();
  const speakSchema = tools.find((t) => t.name === 'moot_speak')?.inputSchema;
  if (!tools.some((t) => t.name === 'moot_wait_for_turn')) throw new Error('Moyik 连接器没有 moot_wait_for_turn，可能这次登录没有给读取权限');
  const keeper = new QuotaKeeper(cfg, conn, { canReport: tools.some((t) => t.name === 'moot_report_quota') });
  await keeper.refresh(true);
  log(`座位助手已开始守候（本机 AI：${keeper.agents.join('、')}${cfg.groupId ? '，只守一个空间' : ''}）`);
  if (Object.keys(keeper.quotas).length) log(`额度：${keeper.line()}`);
  let spentLogged = false;

  const seen = new Set(loadSeen());
  let backoff = 5_000;
  let lastIdleLog = 0;
  while (!signal?.aborted) {
    await keeper.refresh();
    // Every local AI is spent: do not take turns nobody here can write. Moyik already knows and
    // asks the member's other AI, or the stand-in, instead. Look again when a window resets.
    if (!keeper.pick()) {
      const reset = nextReset(keeper.quotas);
      if (!spentLogged) log(`本机 AI 额度都用完了，先不接轮次${reset ? `，${new Date(reset).toLocaleString()} 后再看` : ''}`);
      spentLogged = true;
      const ms = reset ? Math.min(Math.max(Date.parse(reset) - Date.now() + 30_000, 60_000), 10 * 60_000) : 10 * 60_000;
      await sleep(ms);
      await keeper.refresh(true);
      if (once) break;
      continue;
    }
    if (spentLogged) log('本机 AI 又有额度了，继续守候');
    spentLogged = false;
    let wait;
    try {
      const text = await conn.call('moot_wait_for_turn', { max_wait_seconds: 50, ...(cfg.groupId ? { group_id: cfg.groupId } : {}) }, { timeoutMs: 120_000 });
      wait = readWait(text);
      backoff = 5_000;
    } catch (err) {
      if (err instanceof NeedsLogin) throw err;
      const ms = err.retryAfter ? err.retryAfter * 1000 : backoff;
      log(`连不上 Moyik（${err.message}），${Math.round(ms / 1000)} 秒后重试`);
      await sleep(ms);
      backoff = Math.min(backoff * 2, 5 * 60_000);
      continue;
    }

    if (wait.kind === 'test') {
      await conn.call('moot_speak', { turn_id: wait.turnId, text: '收到', kind: 'pass' }).catch((e) => log(`连通测试没答上：${e.message}`));
      log('答了一次连通测试');
    } else if (wait.kind === 'turn' && !seen.has(wait.turnId)) {
      seen.add(wait.turnId);
      saveSeen([...seen]);
      log(`轮到你了（${wait.card ? '任务卡' : '讨论'}，${shortId(wait.turnId)}），叫醒本机 AI`);
      try {
        // Task cards need Claude Code; a speech can be written by whichever local AI has room.
        const works = wait.card && wait.card.step === 'write' && wait.card.scope.length > 0;
        const agent = keeper.pick((a) => !works || a === 'claude') ?? (works ? 'claude' : keeper.agents[0]);
        const turnCfg = { ...cfg, agent };
        if (keeper.agents.length > 1) log(`这一轮由 ${agent} 来写`);
        const ask = (p, o) => runAgent(turnCfg, p, { ...o, onQuota: (q) => keeper.seen(q).catch(() => {}) });
        log(`${shortId(wait.turnId)} ${await handleTurn(conn, turnCfg, wait, { speakSchema, ask })}`);
        keeper.lastRead = 0; // read again after a turn: it used some of the plan
      } catch (err) {
        if (err instanceof NeedsLogin) throw err;
        log(`${shortId(wait.turnId)} 没交上：${err.message}`);
      }
    } else if (wait.kind === 'over' || wait.kind === 'idle') {
      if (Date.now() - lastIdleLog > 30 * 60_000) {
        log(wait.kind === 'over' ? '现在没有进行中的讨论，继续守着' : '还没轮到你，继续守着');
        lastIdleLog = Date.now();
      }
      // With nothing going on there is no need to ask every minute.
      if (wait.kind === 'over') await sleep(60_000);
    } else {
      await sleep(10_000); // a turn already handled is still open until the round moves on
    }
    if (once) break;
  }
}
