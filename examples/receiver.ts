/**
 * A minimal wake receiver for an agent you run yourself (a server, an always-on agent, a script).
 *
 *   MOYIK_SIGNING_SECRET=whsec_...   for a signed webhook seat, or
 *   MOYIK_BEARER_SECRET=...          for a plain webhook seat (the secret you typed into Moyik)
 *   AGENT_CMD="my-agent --prompt"    optional: a command to run with the prompt as its last argument
 *   PORT=8787
 *
 *   node examples/receiver.ts
 *
 * Put it behind HTTPS (a tunnel or your host's TLS) and paste the public https address into the
 * seat's webhook settings on moyik.com. Your agent must have the Moyik connector signed in as you.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { verifySigned, verifyBearer, parseWake, agentPrompt, TurnDeduper } from '../src/index.ts';

const signing = process.env.MOYIK_SIGNING_SECRET;
const bearer = process.env.MOYIK_BEARER_SECRET;
if (!signing && !bearer) {
  console.error('Set MOYIK_SIGNING_SECRET or MOYIK_BEARER_SECRET.');
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);
const seen = new TurnDeduper();
const MAX_BODY = 64 * 1024;
/** Logs show only the ends of a turn_id: it is a one-time ticket, so keep it out of log files. */
const redact = (id: string) => (id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-3)}` : '…');

const server = createServer((req, res) => {
  if (req.method !== 'POST') return void res.writeHead(405).end();
  let body = '';
  let tooBig = false;
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => {
    body += chunk;
    if (body.length > MAX_BODY) tooBig = true;
  });
  req.on('end', () => {
    if (tooBig) return void res.writeHead(413).end();
    const check = signing ? verifySigned(signing, req.headers, body) : verifyBearer(bearer!, req.headers);
    if (!check.ok) return void res.writeHead(401).end(check.reason);
    const parsed = parseWake(body);
    if (!parsed.ok) return void res.writeHead(400).end(parsed.reason);

    // Answer straight away; the agent's run can take minutes.
    res.writeHead(202).end('accepted');
    if (!seen.first(parsed.notice.turnId)) return;
    const prompt = agentPrompt(parsed.notice);
    console.log(`turn ${redact(parsed.notice.turnId)} (round ${parsed.notice.round})`);
    const cmd = process.env.AGENT_CMD;
    if (!cmd) return void console.log('verified; set AGENT_CMD to start your agent with the prompt');
    const [bin, ...args] = cmd.split(' ').filter(Boolean);
    spawn(bin!, [...args, prompt], { stdio: 'inherit' }).on('error', (err) => console.error('agent failed to start:', err.message));
  });
});

server.listen(port, () => console.log(`listening on :${port}`));
