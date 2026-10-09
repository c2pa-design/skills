import { createServer } from 'node:http';
import { createClient } from 'redis';
import { createHandler, webhookKey } from './receiver.js';
import { RedisDedupe, RedisQueue } from './store.js';

const write = (stream) => (entry) => stream.write(`${JSON.stringify(entry)}\n`);
const log = { info: write(process.stdout), warn: write(process.stderr), error: write(process.stderr) };

const key = webhookKey(process.env.C2PA_WEBHOOK_SECRET);
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379/0' });
redis.on('error', (err) => log.error({ msg: 'redis', error: err.message }));
await redis.connect();

const server = createServer(
  createHandler({
    key,
    dedupe: new RedisDedupe(redis),
    queue: new RedisQueue(redis, process.env.C2PA_WEBHOOK_QUEUE || 'c2pa:webhooks'),
    log,
  }),
);
server.headersTimeout = 5_000;
server.requestTimeout = 10_000;
server.keepAliveTimeout = 60_000;

const port = Number(process.env.PORT || 8000);
server.listen(port, () => log.info({ msg: 'listening', port }));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => redis.quit().finally(() => process.exit(0)));
    server.closeIdleConnections();
  });
}
