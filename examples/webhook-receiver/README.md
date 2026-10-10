# c2pa.design webhook receivers

Runnable `POST /webhooks/c2pa` receivers in [Go](go/), [Node](node/) and [Python](python/).
Each one follows the same order:

1. Read the raw body, capped at 1 MiB. → `413`
2. Verify the Standard Webhooks signature (`webhook-id`, `webhook-timestamp`,
   `webhook-signature`), constant-time, any of several space-separated `v1,<base64>` entries
   (two are sent during a secret rotation), timestamp within 300 s. → `401`
3. Parse the envelope `{id, type, created_at, occurred_at, data}` (non-empty `id`/`type`, RFC 3339
   times, `data` an object). → `400`, and the delivery id is not consumed.
4. Deduplicate on `webhook-id` in a shared store (Redis `SET webhook:<id> 1 NX EX 86400`).
   A redelivery gets `200` without reprocessing; a store error answers `503`.
5. Enqueue for a worker. On failure the dedupe key is released and the receiver answers `503`,
   so c2pa.design retries.
6. Answer `2xx`. Unknown event types are acknowledged and ignored.

Only `webhook-id`, `id` and `type` are logged: `data` may echo customer metadata.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `C2PA_WEBHOOK_SECRET` | — | `whsec_…` returned once by `POST /webhooks`; anything that is not `whsec_` + standard base64 fails at startup |
| `REDIS_URL` | `redis://localhost:6379/0` | Dedupe store and example queue |
| `C2PA_WEBHOOK_QUEUE` | `c2pa:webhooks` | Redis list the events are pushed to |
| `PORT` | `8000` | Listen port |

The dedupe store must be shared across replicas; an in-process set lets two replicas each
process the same redelivery. A database unique index on the delivery id works as well as Redis.
The in-memory implementations exist only for the tests. Replace the Redis list with your real
queue (River, Sidekiq, Celery, BullMQ, SQS…).

## Test vectors

`vectors.json` follows the c2pa.design backend signer. Every suite runs it, so the three
receivers and the sender agree byte for byte. Each vector has `now` (the clock to verify at, in
seconds) and `valid` (the expected outcome): a plain delivery, a delivery during a secret
rotation (two signatures in `webhook-signature`, accepted with either secret), and a correct
signature whose timestamp is ten minutes old or ten minutes ahead (rejected).

After deploying, call `POST /webhooks/{id}/test`: a real-signed `ping` should arrive and return
`204`.
