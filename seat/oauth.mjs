// Signing in to Moyik as the seat's owner: OAuth 2.1 with PKCE, a client registered on the spot,
// and a one-time listener on this computer's loopback address for the answer.
// The token is the owner's grant to this helper on Moyik. It can be seen and revoked on the site,
// and it is never shown to the local AI.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export const SCOPES = 'moot:read moot:write';
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function post(url, body, form = false) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', accept: 'application/json', 'user-agent': 'moyik-seat/0.2' },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${json.error ?? res.status}: ${json.error_description ?? 'request failed'}`);
    err.status = res.status;
    err.code = json.error;
    throw err;
  }
  return json;
}

export async function metadata(origin) {
  const res = await fetch(`${origin}/.well-known/oauth-authorization-server`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Moyik 没有返回登录信息（${res.status}）。请检查网络，或确认地址是 ${origin}`);
  return res.json();
}

function openBrowser(url) {
  const cmd = platform() === 'darwin' ? ['open', [url]] : platform() === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

/**
 * Full sign-in. Opens the browser at Moyik's consent page; the owner agrees there, signed in on
 * the site as usual. Returns what to keep in auth.json.
 */
export async function login(origin, { label = 'Claude Code', timeoutMs = 5 * 60_000, open = openBrowser, say = console.log } = {}) {
  const meta = await metadata(origin);
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));

  // The listener answers only on 127.0.0.1, once, for this state.
  let resolveCode, rejectCode;
  const got = new Promise((res, rej) => ((resolveCode = res), (rejectCode = rej)));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') return res.writeHead(404).end();
    const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ok ? '<p>已连上 Moyik。可以关掉这个页面，回到终端。</p><p>Connected to Moyik. You can close this page.</p>' : '<p>登录没有完成，请回到终端重试。</p>');
    if (ok) resolveCode(url.searchParams.get('code'));
    else rejectCode(new Error(url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? '登录没有完成'));
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const timer = setTimeout(() => rejectCode(new Error('等了 5 分钟没有完成登录，请重新运行 moyik-seat login')), timeoutMs);

  try {
    const client = await post(meta.registration_endpoint, {
      client_name: `Moyik 座位助手 · ${label}`,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      software_id: 'moyik-seat',
      software_version: '0.2.0',
    });
    const auth = new URL(meta.authorization_endpoint);
    auth.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: SCOPES,
      state,
      resource: `${origin}/mcp`,
    }).toString();
    say(`在浏览器里同意连接（没有自动打开就复制这个地址）：\n${auth}\n`);
    open(auth.toString());
    const code = await got;
    const token = await post(
      meta.token_endpoint,
      { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: `${origin}/mcp` },
      true,
    );
    return toAuth(origin, meta, client.client_id, token);
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

function toAuth(origin, meta, clientId, token) {
  return {
    origin,
    clientId,
    tokenEndpoint: meta.token_endpoint,
    revocationEndpoint: meta.revocation_endpoint,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000,
  };
}

/** A fresh access token from the refresh token. Moyik rotates refresh tokens, so both are replaced. */
export async function refresh(auth) {
  const token = await post(auth.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: auth.clientId, resource: `${auth.origin}/mcp` }, true);
  return {
    ...auth,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? auth.refreshToken,
    expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000,
  };
}

export async function revoke(auth) {
  if (!auth?.revocationEndpoint) return;
  for (const [token, hint] of [
    [auth.refreshToken, 'refresh_token'],
    [auth.accessToken, 'access_token'],
  ]) {
    if (token) await post(auth.revocationEndpoint, { token, token_type_hint: hint, client_id: auth.clientId }, true).catch(() => {});
  }
}
