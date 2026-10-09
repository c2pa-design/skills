# Node receiver

`node:http` and the `redis` client. Node 20+. Tests use `node:test` and need no install.

```bash
npm install
export C2PA_WEBHOOK_SECRET=whsec_...
export REDIS_URL=redis://localhost:6379/0
npm start
npm test
```

`receiver.js` signs, verifies and handles the request; `store.js` holds `RedisDedupe`,
`RedisQueue` and the test-only `MemoryDedupe`. With Express, mount the handler before any JSON
body parser, or use `express.raw({ type: '*/*' })`: the signature covers the raw bytes.
