// A minimal Agent Client Protocol (ACP) client: newline-delimited JSON-RPC over the agent's
// stdin/stdout. Used to wake Google Antigravity's own `agy acp` for a speech.
// The helper never signs in for the agent: it never calls `authenticate`. If the agent is not
// signed in, the turn fails and the owner signs in to Antigravity themselves.
// Speeches need no tools, so every permission request is refused and no file or terminal
// access is offered to the agent.

import { spawn } from 'node:child_process';

export class AcpError extends Error {}

/**
 * Runs one prompt through an ACP agent and returns the text it wrote.
 * @param {{cmd: string, args: string[], cwd: string, env: object, prompt: string, minutes: number, spawnImpl?: Function, shell?: boolean}} o
 */
export function acpPrompt({ cmd, args, cwd, env, prompt, minutes, spawnImpl = spawn, shell = false }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cmd, args, { cwd, env, shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let nextId = 1;
    const pending = new Map();
    let text = '';
    let stderr = '';
    let buf = '';
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      child.kill('SIGTERM');
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new AcpError(`本机 AI 超过 ${minutes} 分钟没写完`)), minutes * 60_000);

    const send = (msg) => {
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); } catch {}
    };
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej, method });
      send({ id, method, params });
    });

    const onMessage = (msg) => {
      // A response to one of our requests.
      if (msg.id !== undefined && msg.method === undefined) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.rej(Object.assign(new AcpError(`${p.method}：${msg.error.message ?? '出错了'}`), { code: msg.error.code, data: msg.error.data }));
        else p.res(msg.result);
        return;
      }
      // The agent streaming its answer.
      if (msg.method === 'session/update') {
        const u = msg.params?.update;
        if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text;
        return;
      }
      // Anything the agent asks of us: refuse. A permission request is answered "cancelled".
      if (msg.id !== undefined) {
        if (msg.method === 'session/request_permission') send({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } });
        else send({ id: msg.id, error: { code: -32601, message: 'not offered by the Moyik seat helper' } });
      }
    };

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { onMessage(JSON.parse(line)); } catch {}
      }
      if (buf.length > 4_000_000) finish(new AcpError('本机 AI 输出太长'));
    });
    child.stderr.on('data', (d) => { if (stderr.length < 20_000) stderr += d.toString(); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => finish(e.code === 'ENOENT' ? new AcpError(`找不到 ${cmd}。请先装好 Antigravity 并在终端里登录一次`) : e));
    child.on('close', (code) => finish(new AcpError(`${cmd} 提前退出（${code}）${stderr ? '：' + stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300) : ''}`)));

    (async () => {
      const init = await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'moyik-seat', version: '0.3.0' },
      });
      let session;
      try {
        session = await request('session/new', { cwd, mcpServers: [] });
      } catch (err) {
        // ACP's "auth required" error. The helper does not sign in for the agent.
        if (err.code === -32000 || /auth/i.test(err.message)) throw new AcpError('Antigravity 还没登录。请先在终端运行 agy 自己登录一次，再重试');
        throw err;
      }
      const result = await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] });
      return { text, stopReason: result?.stopReason, agent: init?.agentInfo?.name };
    })().then((v) => finish(null, v), (e) => finish(e));
  });
}
