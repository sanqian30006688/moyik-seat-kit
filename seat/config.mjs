// Where the seat helper keeps its own small state on the owner's computer.
// It holds the owner's Moyik sign-in for this helper, and nothing from any AI vendor.

import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_ORIGIN = 'https://moyik.com';

export function configDir() {
  if (process.env.MOYIK_SEAT_HOME) return process.env.MOYIK_SEAT_HOME;
  if (platform() === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'moyik-seat');
  return join(homedir(), '.moyik-seat');
}

function ensureDir() {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readJson(name) {
  const file = join(configDir(), name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Written to a temporary file and renamed, so a crash never leaves half a token on disk. */
function writeJson(name, value) {
  const dir = ensureDir();
  const file = join(dir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {}
}

/**
 * @typedef {object} SeatConfig
 * @property {string} origin       Moyik address, https://moyik.com unless testing.
 * @property {'claude'|'codex'|'custom'} agent  Which local AI answers for the seat.
 * @property {string} [agentCmd]   For agent=custom: a command that reads the prompt on stdin and prints the answer.
 * @property {string} [model]      Optional model name passed to the local AI.
 * @property {string} [contextDir] A folder the local AI may read (read-only) when it writes a speech. Off by default.
 * @property {string} [repo]       The owner's local clone that task cards are carried out in.
 * @property {number} [turnMinutes] How long the local AI may take for one turn.
 * @property {string} [groupId]    Only answer turns in this space.
 */

/** @returns {SeatConfig} */
export function loadConfig() {
  return { origin: DEFAULT_ORIGIN, agent: 'claude', turnMinutes: 8, ...(readJson('config.json') ?? {}) };
}

/** @param {Partial<SeatConfig>} patch */
export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined || v === '') delete next[k];
  writeJson('config.json', next);
  return next;
}

export const loadAuth = () => readJson('auth.json');
export const saveAuth = (auth) => writeJson('auth.json', auth);
export function clearAuth() {
  const file = join(configDir(), 'auth.json');
  if (existsSync(file)) writeFileSync(file, '{}\n', { mode: 0o600 });
}

export const loadSeen = () => readJson('seen.json') ?? [];
export const saveSeen = (ids) => writeJson('seen.json', ids.slice(-200));

const LOG_MAX = 1_000_000;

/** One line per event. Never the round, never the speech, never a whole turn_id. */
export function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  try {
    const file = join(ensureDir(), 'seat.log');
    if (existsSync(file) && statSync(file).size > LOG_MAX) renameSync(file, `${file}.1`);
    appendFileSync(file, text + '\n', { mode: 0o600 });
  } catch {}
}

/** First characters of a turn_id, enough to match a log line to the site, not enough to use it. */
export const shortId = (id) => (typeof id === 'string' ? `${id.slice(0, 6)}…` : '?');
