import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 300;
export const MAX_BODY = 1 << 20;
const SECRET_PREFIX = 'whsec_';
const STD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TIMESTAMP = /^[0-9]{1,12}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const KNOWN_TYPES = new Set([
  'ping',
  'verification.completed',
  'monitor.run.completed',
  'monitor.regression',
  'usage.threshold',
  'asset.lost',
  'asset.stripped_copy_seen',
  'digest.ready',
  'evidence_pack.ready',
]);

export function webhookKey(secret) {
  const raw = typeof secret === 'string' && secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : '';
  if (!raw || !STD_BASE64.test(raw)) throw new Error('C2PA_WEBHOOK_SECRET is not whsec_ + standard base64');
  return Buffer.from(raw, 'base64');
}

export function sign(key, id, timestamp, body) {
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64')}`;
}

export function verify(key, headers, body, nowSeconds) {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const signatures = headers['webhook-signature'];
  if (typeof id !== 'string' || typeof ts !== 'string' || typeof signatures !== 'string' || !id || !ts || !signatures) {
    return 'missing headers';
  }
  if (!TIMESTAMP.test(ts) || Math.abs(nowSeconds - Number(ts)) > TOLERANCE_SECONDS) return 'timestamp outside tolerance';
  const want = Buffer.from(sign(key, id, ts, body));
  for (const candidate of signatures.split(' ')) {
    const got = Buffer.from(candidate);
    if (got.length === want.length && timingSafeEqual(got, want)) return null;
  }
  return 'no matching signature';
}

export function parseEnvelope(body) {
  let event;
  try {
    event = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isNonEmpty = (v) => typeof v === 'string' && v !== '';
  const isTime = (v) => typeof v === 'string' && RFC3339.test(v) && !Number.isNaN(Date.parse(v));
  if (!isObject(event) || !isNonEmpty(event.id) || !isNonEmpty(event.type)) return null;
  if (!isTime(event.created_at) || !isTime(event.occurred_at) || !isObject(event.data)) return null;
  return event;
}

function readBody(req) {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length']) > MAX_BODY) {
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        chunks.length = 0;
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

export function createHandler({ key, dedupe, queue, log, now = () => Math.floor(Date.now() / 1000) }) {
  const reply = (res, status, close = false) => {
    res.writeHead(status, close ? { connection: 'close' } : {});
    res.end();
  };
  const errorText = (err) => String(err?.message ?? err);

  return async (req, res) => {
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/webhooks/c2pa') return reply(res, 404);

    const body = await readBody(req);
    if (body === null) return reply(res, 413, true);

    const reason = verify(key, req.headers, body, now());
    if (reason) {
      log.warn({ msg: 'webhook rejected', reason });
      return reply(res, 401);
    }

    const deliveryId = req.headers['webhook-id'];
    const event = parseEnvelope(body);
    if (!event) {
      log.warn({ msg: 'webhook body unparseable', webhook_id: deliveryId });
      return reply(res, 400);
    }
    const meta = { webhook_id: deliveryId, id: event.id, type: event.type };

    let fresh;
    try {
      fresh = await dedupe.claim(deliveryId);
    } catch (err) {
      log.error({ msg: 'webhook dedupe failed', ...meta, error: errorText(err) });
      return reply(res, 503);
    }
    if (!fresh) {
      log.info({ msg: 'webhook duplicate', ...meta });
      return reply(res, 200);
    }

    if (!KNOWN_TYPES.has(event.type)) {
      log.info({ msg: 'webhook ignored', ...meta });
      return reply(res, 200);
    }

    try {
      await queue.enqueue(event);
    } catch (err) {
      log.error({ msg: 'webhook enqueue failed', ...meta, error: errorText(err) });
      try {
        await dedupe.release(deliveryId);
      } catch (releaseErr) {
        log.error({ msg: 'webhook dedupe release failed', ...meta, error: errorText(releaseErr) });
      }
      return reply(res, 503);
    }

    log.info({ msg: 'webhook accepted', ...meta });
    return reply(res, 204);
  };
}
