// `moyik-seat add antigravity`: adds Moyik to Antigravity's own MCP settings, so the owner can
// open Antigravity and let it sit in their seat themselves. Nothing is woken in the background;
// Antigravity signs in to Moyik through its own OAuth flow, and this file only writes the address.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** Current Antigravity reads ~/.gemini/config; older releases read ~/.gemini/antigravity. */
export function antigravityConfigPaths(home = homedir()) {
  return [join(home, '.gemini', 'config', 'mcp_config.json'), join(home, '.gemini', 'antigravity', 'mcp_config.json')];
}

/** Adds or updates the "moyik" server in every config file that exists (or the current one). Keeps other servers. */
export function addMoyikToAntigravity(origin, { home = homedir(), name = 'moyik', token } = {}) {
  const paths = antigravityConfigPaths(home);
  const targets = paths.filter((p) => existsSync(p));
  if (!targets.length) targets.push(paths[0]);
  const written = [];
  for (const file of targets) {
    let cfg = {};
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      try {
        cfg = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        throw new Error(`${file} 不是合法的 JSON，没有改动。请先修好它或删掉它再运行`);
      }
      copyFileSync(file, `${file}.bak`);
    } else mkdirSync(dirname(file), { recursive: true });
    const server = { serverUrl: `${origin.replace(/\/$/, '')}/mcp` };
    // A static token from the owner's /connect page, for Antigravity builds that cannot finish Moyik's sign-in page.
    if (token) server.headers = { Authorization: `Bearer ${token}` };
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: server };
    writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', token ? { mode: 0o600 } : undefined);
    if (token) try { chmodSync(file, 0o600); } catch {}
    if (token) try { chmodSync(`${file}.bak`, 0o600); } catch {}
    written.push(file);
  }
  return written;
}

/** What the owner pastes into Antigravity's chat to take their seat. */
export const SIT_IN_PROMPT = '用 moyik 工具替我坐 Moyik 座位。先用 moot_overview 找到我正在进行的话题，然后调用 moot_wait_for_turn；轮到我时读简报，按我说过的立场写一段发言，用 moot_speak 和同一个 turn_id 交回，然后继续调用 moot_wait_for_turn，直到它说讨论结束。不要替我投票或拍板。';

/** Reads a token typed at the terminal without echoing it, or from stdin when piped. */
export async function readTokenQuietly(question = '粘贴 Moyik「连接我的 AI」页面生成的静态令牌（输入时不显示），回车：') {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let token = '';
    const onData = (d) => {
      for (const ch of d.toString()) {
        if (ch === '\r' || ch === '\n') { done(); return resolve(token.trim()); }
        if (ch === '\u0003') { done(); return reject(new Error('已取消')); }
        if (ch === '\u007f' || ch === '\b') token = token.slice(0, -1);
        else token += ch;
      }
    };
    const done = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); };
    stdin.on('data', onData);
  });
}
