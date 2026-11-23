// Where the Moyik sign-in is kept: the system keychain when there is one (macOS Keychain,
// Linux Secret Service), otherwise a file only the owner can read. The secret is always passed
// on stdin, never on a command line other processes could see.

import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const SERVICE = 'moyik-seat';
const ACCOUNT = 'moyik-connector';

const has = (cmd) => spawnSync(platform() === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
const quote = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

/** Which store is used here. MOYIK_SEAT_KEYCHAIN=off forces the file (tests, headless servers). */
export function store() {
  if (process.env.MOYIK_SEAT_KEYCHAIN === 'off') return 'file';
  if (platform() === 'darwin' && has('security')) return 'macos';
  if (platform() === 'linux' && has('secret-tool') && process.env.DBUS_SESSION_BUS_ADDRESS) return 'secret-service';
  return 'file';
}

export function keychainGet() {
  const kind = store();
  let r;
  if (kind === 'macos') r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { encoding: 'utf8' });
  else if (kind === 'secret-service') r = spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT], { encoding: 'utf8' });
  else return undefined;
  if (r.status !== 0 || !r.stdout.trim()) return null;
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return null;
  }
}

/** Returns true when the keychain took it; false means the caller keeps the file instead. */
export function keychainSet(value) {
  const kind = store();
  const secret = JSON.stringify(value);
  let r;
  if (kind === 'macos') {
    // `security -i` reads its command from stdin, so the token never appears in a process list.
    r = spawnSync('security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${quote(secret)}\n`, encoding: 'utf8' });
  } else if (kind === 'secret-service') {
    r = spawnSync('secret-tool', ['store', '--label=Moyik seat helper', 'service', SERVICE, 'account', ACCOUNT], { input: secret, encoding: 'utf8' });
  } else return false;
  return r.status === 0;
}

export function keychainDelete() {
  const kind = store();
  if (kind === 'macos') spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], { stdio: 'ignore' });
  else if (kind === 'secret-service') spawnSync('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT], { stdio: 'ignore' });
}
