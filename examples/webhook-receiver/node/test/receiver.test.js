import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { KNOWN_TYPES, MAX_BODY, createHandler, sign, verify, webhookKey } from '../receiver.js';
import { MemoryDedupe } from '../store.js';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const key = webhookKey(SECRET);
const silent = { info() {}, warn() {}, error() {} };

let server;
let url;
let current;
let queue;
let nowSeconds;

before(async () => {
  server = createServer((req, res) => current(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/webhooks/c2pa`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  nowSeconds = Math.floor(Date.now() / 1000);
  queue = {
    events: [],
    fail: false,
    async enqueue(event) {
      if (this.fail) throw new Error('queue down');
      this.events.push(event);
    },
  };
  useHandler(new MemoryDedupe());
});

function useHandler(dedupe) {
  current = createHandler({ key, dedupe, queue, log: silent, now: () => nowSeconds });
}

function envelope(type) {
  return JSON.stringify({
    id: '0199b1f2-6c1e-7a3b-9d4e-5f6a7b8c9d0e',
    type,
    created_at: '2026-10-09T00:00:00Z',
    occurred_at: '2026-10-09T00:00:00Z',
    data: { x: 1 },
  });
}

async function send(payload, { id = 'msg_1', ts = String(nowSeconds), signature } = {}) {
  const headers = {};
  if (id) headers['webhook-id'] = id;
  if (ts) headers['webhook-timestamp'] = ts;
  const sig = signature ?? sign(key, id, ts, payload);
  if (sig) headers['webhook-signature'] = sig;
  const res = await fetch(url, { method: 'POST', headers, body: payload });
  return res.status;
}

test('valid signature is accepted and enqueued', async () => {
  assert.equal(await send(envelope('asset.lost')), 204);
  assert.deepEqual(queue.events.map((e) => e.type), ['asset.lost']);
});

test('every documented event type is enqueued', async () => {
  for (const type of KNOWN_TYPES) assert.equal(await send(envelope(type), { id: type }), 204, type);
  assert.equal(queue.events.length, KNOWN_TYPES.size);
});

test('tampered body is rejected', async () => {
  const payload = envelope('asset.lost');
  const signature = sign(key, 'msg_1', String(nowSeconds), payload);
  assert.equal(await send(payload.replace('"x":1', '"x":2'), { signature }), 401);
  assert.equal(queue.events.length, 0);
});

test('stale and future timestamps are rejected', async () => {
  assert.equal(await send(envelope('ping'), { ts: String(nowSeconds - 600) }), 401);
  assert.equal(await send(envelope('ping'), { ts: String(nowSeconds + 600) }), 401);
});

test('malformed timestamps are rejected', async () => {
  for (const ts of ['abc', '-1', '+1757000000', '1e9', '99999999999999999999', '0x68b9a780']) {
    assert.equal(await send(envelope('ping'), { ts }), 401, ts);
  }
});

test('missing headers are rejected', async () => {
  const payload = envelope('ping');
  assert.equal(await send(payload, { id: '', signature: 'v1,x' }), 401);
  assert.equal(await send(payload, { ts: '' }), 401);
  assert.equal(await send(payload, { signature: '' }), 401);
});

test('one valid signature among several is accepted', async () => {
  const payload = envelope('ping');
  const good = sign(key, 'msg_1', String(nowSeconds), payload);
  assert.equal(await send(payload, { signature: `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=  garbage ${good}` }), 204);
});

test('signatures that all mismatch are rejected', async () => {
  assert.equal(await send(envelope('ping'), { signature: 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= v1,' }), 401);
});

test('redelivery is acknowledged without reprocessing', async () => {
  const payload = envelope('asset.lost');
  assert.equal(await send(payload), 204);
  assert.equal(await send(payload), 200);
  assert.equal(queue.events.length, 1);
});

test('signed but invalid envelope is 400 and does not consume the id', async () => {
  for (const payload of [
    'not json',
    '[]',
    'null',
    '{"id":"e","type":"ping","created_at":"2026-10-09T00:00:00Z","data":{}}',
    '{"id":"e","type":"ping","created_at":"x","occurred_at":"2026-10-09T00:00:00Z","data":{}}',
    '{"id":"e","type":"ping","created_at":"2026-10-09T00:00:00Z","occurred_at":"2026-10-09T00:00:00Z","data":null}',
    '{"type":"ping","created_at":"2026-10-09T00:00:00Z","occurred_at":"2026-10-09T00:00:00Z","data":{}}',
  ]) {
    assert.equal(await send(payload), 400, payload);
  }
  assert.equal(await send(envelope('ping')), 204);
});

test('unknown type is acknowledged and not enqueued', async () => {
  assert.equal(await send(envelope('something.new')), 200);
  assert.equal(queue.events.length, 0);
});

test('enqueue failure releases the id and returns 503', async () => {
  const payload = envelope('asset.lost');
  queue.fail = true;
  assert.equal(await send(payload), 503);
  queue.fail = false;
  assert.equal(await send(payload), 204);
});

test('dedupe store failure returns 503', async () => {
  const down = async () => {
    throw new Error('store down');
  };
  useHandler({ claim: down, release: down });
  assert.equal(await send(envelope('asset.lost')), 503);
  assert.equal(queue.events.length, 0);
});

test('body over 1 MiB is rejected', async () => {
  assert.equal(await send('a'.repeat(MAX_BODY + 1)), 413);
});

test('a secret that is not whsec_ + standard base64 fails', () => {
  for (const secret of [undefined, '', 'whsec_', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'whsec_q-8_Zt3x-Rb1Yk_PQ2mN7wLs-Vh4Jc9A', 'whsec_abc']) {
    assert.throws(() => webhookKey(secret), String(secret));
  }
});

test('shared vectors signed by the c2pa.design backend verify', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../vectors.json', import.meta.url), 'utf8'));
  assert.ok(vectors.length > 0);
  for (const v of vectors) {
    const headers = { 'webhook-id': v.id, 'webhook-timestamp': v.timestamp, 'webhook-signature': v.signature };
    assert.equal(verify(webhookKey(v.secret), headers, Buffer.from(v.body), Number(v.timestamp)), null, v.name);
  }
});
