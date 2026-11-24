// A minimal client for Moyik's connector (MCP over Streamable HTTP, no session, one JSON answer
// per request). Only what the helper needs: list tools, call a tool, refresh the sign-in.

import { refresh } from './oauth.mjs';

export class NeedsLogin extends Error {}

export class Connector {
  /**
   * @param {object} auth   what login() returned
   * @param {(auth: object) => void} onRefresh  called with new tokens, to be saved
   */
  constructor(auth, onRefresh = () => {}, fetchImpl = fetch) {
    this.auth = auth;
    this.onRefresh = onRefresh;
    this.fetch = fetchImpl;
    this.nextId = 1;
  }

  async token() {
    if (!this.auth?.accessToken) throw new NeedsLogin('还没有登录');
    if (Date.now() > this.auth.expiresAt - 60_000) await this.renew();
    return this.auth.accessToken;
  }

  async renew() {
    try {
      this.auth = await refresh(this.auth);
    } catch (err) {
      if (err.status === 400 || err.status === 401) throw new NeedsLogin('Moyik 的登录已失效或被收回');
      throw err;
    }
    this.onRefresh(this.auth);
  }

  async rpc(method, params, { timeoutMs = 90_000, retried = false } = {}) {
    const res = await this.fetch(`${this.auth.origin}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.token()}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        'user-agent': 'moyik-seat/0.3',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 && !retried) {
      await this.renew();
      return this.rpc(method, params, { timeoutMs, retried: true });
    }
    if (res.status === 401) throw new NeedsLogin('Moyik 不认这个登录');
    if (res.status === 429) {
      const err = new Error('Moyik 让慢一点');
      err.retryAfter = Number(res.headers.get('retry-after')) || 60;
      throw err;
    }
    const body = await res.json().catch(() => null);
    if (!body) throw new Error(`Moyik 回了 ${res.status}`);
    if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
    return body.result;
  }

  async listTools() {
    const result = await this.rpc('tools/list', {});
    return result?.tools ?? [];
  }

  /** Returns the text of a tool's answer. A tool that refused (isError) throws with its text. */
  async call(name, args, opts) {
    const result = await this.rpc('tools/call', { name, arguments: args }, opts);
    const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (result?.isError) {
      const err = new Error(text || `${name} 被拒绝`);
      err.refused = true;
      throw err;
    }
    return text;
  }
}
