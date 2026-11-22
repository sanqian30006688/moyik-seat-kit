import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySigned, verifyBearer, sign, signingKey } from '../src/index.ts';

// Public test vector published by the Standard Webhooks project (https://www.standardwebhooks.com/).
// It is not a Moyik secret and signs nothing real.
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: '1614265330',
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};
const AT = Number(VECTOR.timestamp) * 1000;
const headers = (over: Record<string, string> = {}) => ({
  'webhook-id': VECTOR.id,
  'webhook-timestamp': VECTOR.timestamp,
  'webhook-signature': VECTOR.signature,
  ...over,
});

test('matches the Standard Webhooks reference signature', () => {
  assert.equal(sign(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body), VECTOR.signature);
});

test('accepts a correctly signed call', () => {
  assert.deepEqual(verifySigned(VECTOR.secret, headers(), VECTOR.body, { now: AT }), { ok: true });
});

test('accepts when one of several signatures matches (secret rotation)', () => {
  const h = headers({ 'webhook-signature': `v1,AAAA ${VECTOR.signature}` });
  assert.equal(verifySigned(VECTOR.secret, h, VECTOR.body, { now: AT }).ok, true);
});

test('works with a Fetch Headers object and mixed-case names', () => {
  assert.equal(verifySigned(VECTOR.secret, new Headers(headers()), VECTOR.body, { now: AT }).ok, true);
  const mixed = { 'Webhook-Id': VECTOR.id, 'Webhook-Timestamp': VECTOR.timestamp, 'Webhook-Signature': VECTOR.signature };
  assert.equal(verifySigned(VECTOR.secret, mixed, VECTOR.body, { now: AT }).ok, true);
});

test('rejects a changed body', () => {
  assert.deepEqual(verifySigned(VECTOR.secret, headers(), '{"test": 1}', { now: AT }), { ok: false, reason: 'bad_signature' });
});

test('rejects the wrong secret', () => {
  const other = 'whsec_' + Buffer.alloc(24, 7).toString('base64');
  assert.deepEqual(verifySigned(other, headers(), VECTOR.body, { now: AT }), { ok: false, reason: 'bad_signature' });
});

test('rejects old or future timestamps', () => {
  assert.deepEqual(verifySigned(VECTOR.secret, headers(), VECTOR.body, { now: AT + 6 * 60_000 }), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verifySigned(VECTOR.secret, headers(), VECTOR.body, { now: AT - 6 * 60_000 }), { ok: false, reason: 'stale_timestamp' });
});

test('rejects missing headers and non-whsec secrets', () => {
  assert.deepEqual(verifySigned(VECTOR.secret, {}, VECTOR.body, { now: AT }), { ok: false, reason: 'missing_headers' });
  assert.deepEqual(verifySigned('not-a-secret', headers(), VECTOR.body, { now: AT }), { ok: false, reason: 'bad_secret' });
  assert.equal(signingKey('whsec_short'), null);
});

test('rejects signatures that are not v1', () => {
  const v2 = VECTOR.signature.replace('v1,', 'v2,');
  assert.equal(verifySigned(VECTOR.secret, headers({ 'webhook-signature': v2 }), VECTOR.body, { now: AT }).ok, false);
});

test('bearer: accepts the exact secret only', () => {
  const secret = 'test-only-not-a-real-secret';
  assert.equal(verifyBearer(secret, { authorization: `Bearer ${secret}` }).ok, true);
  assert.equal(verifyBearer(secret, { Authorization: `bearer ${secret}` }).ok, true);
  assert.equal(verifyBearer(secret, { authorization: `Bearer ${secret}x` }).ok, false);
  assert.equal(verifyBearer(secret, { authorization: secret }).ok, false);
  assert.equal(verifyBearer(secret, {}).ok, false);
  assert.equal(verifyBearer('', { authorization: 'Bearer ' }).ok, false);
});
