---
name: c2pa-integrate
description: Connect a codebase to c2pa.design in one pass — API key and webhook secret in env, signed webhook receiver, monitors, domain crawlers, asset inventory, provenance for generated and composite media, and a CI gate, all with retries, backoff and idempotency. Use when the user asks to integrate, connect, set up or install c2pa.design, Content Credentials monitoring, C2PA verification, provenance webhooks or the c2pa-check CI gate in their project.
license: MIT OR Apache-2.0
metadata:
  homepage: https://c2pa.design/docs/agents
  openapi: https://docs.c2pa.design/openapi.yml
  version: "2"
---

# c2pa-integrate

You are wiring the user's project to c2pa.design. Goal: working integration in about five
minutes, nothing secret committed, every call safe to retry. Work in this order, show the user a
short plan first, and ask only for what you cannot find in the repo.

**Always carry.** After you (or code you write) convert, resize, compress or re-encode any image,
video or audio file that had a Content Credential, run
`npx -y c2pa-check@0.2.0 carry --from <source> --to <output>` before shipping the output. Every
re-encode drops the manifest; `carry` writes a new one with the source as `parentOf` ingredient.
Exit `5` means it refused (`--json` gives `rule`: `different_picture`, `source_unsigned`,
`low_quality`, `not_comparable`, or the server's `carry_rejected` rule). A changed picture is not
a carry: see §6.

Never describe a result as real, fake or "AI detected". Report `credential.status`
(`absent | present_invalid | valid_untrusted | valid_trusted | error`) using the labels in
`https://c2pa.design/skills/c2pa-integrate/status-labels.json` (en, de, es, fr, ja, ko) so every
integration shows the same words. A missing credential proves nothing about the file.

## 0. Facts

| What | Value |
|---|---|
| REST base | `https://api.c2pa.design/v1` |
| OpenAPI 3 (public) | `https://docs.c2pa.design/openapi.yml` — includes every webhook payload (`WebhookEvent*`, index `x-webhooks`) |
| Remote MCP | `https://api.c2pa.design/mcp` — protocol `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26` (negotiated) |
| Auth | `Authorization: Bearer c2pa_live_…` or `c2pa_test_…` |
| Keys | https://app.c2pa.design → your organization → **API keys** (`/o/<org>/keys`) |
| Check setup | `GET /whoami` → `key_type`, `organization`, `project`, `plan`, `quota[{metric, used, limit, period_end}]`; or `npx -y c2pa-check@0.2.0 doctor` |
| Error envelope | `{"error":{"code":"…","message":"…","retryable":true,"details":{}}}` — branch on `code`/`retryable`, never `message` |
| Rate headers | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` |
| CLI | `c2pa-check@0.2.0`, Node ≥ 18, `SHA256SUMS` + provenance attestation on every GitHub release |
| Crawler UA | `c2pa-design-bot/1.0`, honours robots.txt, 1 request/s per host |
| Carry signer | own key (`C2PA_SIGN_CERT`/`C2PA_SIGN_KEY`) → `C2PA_API_KEY` ("<verified domain> via c2pa.design", `signatures` quota) → local key with a warning; c2pa.design vouches for the account, never for the content |

### Test keys (`c2pa_test_…`)

Everything runs for real (verification, fetches, webhooks) so the whole flow can be tested, but usage
goes to a separate sandbox allowance and never touches the live quota.

| Endpoint | With a test key |
|---|---|
| `POST /verifications` (URL, upload) | Real result; sandbox cap 1000 per period |
| `POST /webhooks`, `/webhooks/{id}/test`, rotate, enable | Same as live; real signed deliveries |
| `POST /domains` | 1 sandbox domain, each crawl finds at most 50 assets |
| `POST /monitors` | 2 sandbox monitors, hourly or slower; checkpoint checks use the same 1000 |
| `POST /assets`, `/assets/sync` | Same as live |
| `POST /sign`, `/sign/certificate` | `403 forbidden` — carry falls back to a local key |
| `GET /whoami` | `key_type: "test"` and the sandbox quota |

Over a sandbox cap: `402 usage_limit_exceeded` with `details.sandbox: true`. Sandbox domains and
monitors are labelled in the dashboard.

### Limits

| Limit | Value |
|---|---|
| Upload size | 64 MiB |
| `POST /assets` items | ≤ 500 per call |
| `POST /assets/sync` hashes | ≤ 5000 per call |
| `metadata` | ≤ 10 pairs, key ≤ 64, value ≤ 256 chars |
| URLs | ≤ 2048 chars |
| Webhook `events` | ≤ 16 |
| Monitor checkpoints | 1–25 (plan may be lower) |
| Recrawl a domain | ≥ 10 min apart |
| Public scan | 1 per 10 min per IP |

The same limits are `maxItems`/`maxLength`/`maxProperties` in the OpenAPI, so generated clients
check them.

## 1. Detect the stack

Read the repo before writing anything:

- Server language and framework: `go.mod`, `package.json`, `pyproject.toml` / `requirements.txt`,
  `Gemfile`, `composer.json`, `pom.xml` / `build.gradle`, `*.csproj`, `Cargo.toml`.
- How config is loaded and where `.env.example` lives.
- CI: `.github/workflows`, `.gitlab-ci.yml`, `bitbucket-pipelines.yml`, `.circleci`.
- How many replicas the server runs (k8s `replicas`, autoscaling, several dynos) and what
  shared store exists (Redis, Postgres) — §5 needs it.
- Where media lives and where it is produced: uploads, generator calls (OpenAI / Firefly /
  Gemini), and build steps that change pictures (chroma key, crop, atlas, sprite sheets).

## 2. Secrets

Add to `.env.example` (empty values) and to the loader the project already uses. Never write a
real value into a tracked file, a log line, a test fixture or a CI file.

| Variable | Required | Use |
|---|---|---|
| `C2PA_API_KEY` | if the server, CI or scripts call the API | Bearer token. Server-side only — never in a browser bundle (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_` are wrong) |
| `C2PA_WEBHOOK_SECRET` | if webhooks | `whsec_` + standard base64, shown once at creation and at each rotation |
| `C2PA_API_BASE` | no | Defaults to `https://api.c2pa.design/v1` |
| `C2PA_PROJECT_ID` | no | Scopes monitors, domains and assets to one project |
| `C2PA_SIGN_CERT`, `C2PA_SIGN_KEY` | no | Own C2PA certificate chain and key (PEM, or `_FILE` paths) for `carry`; never sent anywhere |
| `C2PA_TSA_URL` | no | RFC 3161 timestamp for own-key carries |

Tell the user where the real values go (GitHub/GitLab CI variables, Kubernetes Secret, Vercel/Fly
env, a secret manager). Check `.gitignore` covers `.env`. Use a `c2pa_test_` key until §9 passes,
then swap to `c2pa_live_`.

## 3. API client — only if the server calls the API

Decide first:

| The project's server… | Do |
|---|---|
| verifies user uploads or URLs at runtime, registers assets at runtime, manages monitors from code | Generate a client (below) |
| only receives webhooks; the key is used by CI and build scripts | **No client.** Webhook receiver (§5) + CLI (§7). A client would be dead code |

Generators: TypeScript `openapi-typescript` + `openapi-fetch`; Go `ogen` or `oapi-codegen`;
Python `openapi-python-client`; Java/Kotlin/Ruby/PHP/Rust `openapi-generator`; C# `NSwag` or
`Kiota`. Wrap it in one `c2pa` module that owns:

1. **Timeouts.** 30 s per request.
2. **Retry on `error.retryable`.** `true`: `rate_limited` (429), `url_unreachable` (502),
   `engine_unavailable` (503), `signing_unavailable` (503), `internal` (500, once). Every other
   code is final. Network errors are retryable.
3. **Backoff.** `Retry-After` when present, else full jitter
   `random(0, min(30s, 0.5s * 2^attempt))`, at most 5 attempts.
4. **Quota.** `402 usage_limit_exceeded` means the plan (or sandbox) is spent until
   `details.period_end`. Never retry; log, alert, degrade. Plan-capacity errors (too many
   monitors, domains, checkpoints) are also `402`, without `period_end`.
5. **Idempotency.** See the table; send `Idempotency-Key: <uuid or stable hash of the input>`
   where supported.
6. **Proactive slow-down.** When `X-RateLimit-Remaining` is 0, wait before the next call.
7. **Logging.** Method, path, status, `error.code`, attempt. Never the key.
8. **Results are not errors.** `200` with `credential.status: "absent"` is a successful check.

| POST | Idempotency |
|---|---|
| `/verifications` | `Idempotency-Key` (API keys). Same key returns the first verification for as long as it exists; two concurrent first requests: the loser gets `409 idempotency_conflict`, retry it. Use a fresh key for a different body |
| `/assets`, `/assets/sync` | Naturally idempotent per location + hash; no header needed |
| `/monitors`, `/domains`, `/webhooks` | Not idempotent — list first, create only what is missing |
| `/sign` | Not idempotent; each call is a new signature |

## 4. Wire the calls the project needs

| Need | Calls |
|---|---|
| Verify a URL | `POST /verifications {"url", "metadata": {"order_id": "…"}}` → sync result |
| Verify a file the server holds | `POST /verifications {"upload": true, "filename", "content_type", "size_bytes"}` → `PUT` bytes to `upload.url` with `upload.headers` → `POST /verifications/{id}/complete` → webhook `verification.completed` or poll `GET /verifications/{id}` |
| Watch a pipeline | `POST /monitors {"name", "schedule": "hourly", "checkpoints": [{"name": "CDN", "url": "…", "expect": "present_trusted"}]}` |
| Crawl a site | `POST /domains {"host"}` → DNS `txt_record` or `file_token` at `file_url` → `POST /domains/{id}/verify`; recrawl `POST /domains/{id}/crawl` |
| One-off public scan | `POST /scans {"host"}` → poll `GET /scans/{id}` every 3 s |
| Register generated assets | `POST /assets/sync {"hashes"}` → `POST /assets` with only the unknown ones |
| Export the inventory | `GET /assets/export` (CSV) |
| CDN resizing | Cloudflare: "Preserve Content Credentials"; Fastly IO: `metadata=c2pa`; anything else: carry before upload |

Attach `metadata` with the project's own IDs so webhooks map back to rows. If the site sits behind
a WAF, allow the UA `c2pa-design-bot`; a blocked crawl shows as `last_error` on the domain.

### What each part delivers

| You connect | Webhook events you will get |
|---|---|
| Webhook endpoint only | `ping` (on test), `usage.threshold` (80 % / 100 % of a quota) |
| + upload verifications | `verification.completed` for each async upload (sync URL checks answer inline, the event fires too) |
| + monitors | `monitor.run.completed` every run, `monitor.regression` when a checkpoint regresses |
| + domain or registered assets | `asset.lost`, `asset.stripped_copy_seen`, `digest.ready` (weekly) |
| + plan with `evidence_pack` | `evidence_pack.ready` (1st of the month) |

Webhooks without monitors, domains or assets are nearly silent. Wire them when one of those is in
place, or for async uploads.

## 5. Webhook receiver

Complete receivers with tests (Go, Node, Python):
https://github.com/c2pa-design/skills/tree/main/examples/webhook-receiver. Adapt one rather than
writing from scratch.

Register the endpoint:

```
POST /webhooks {"url": "https://<host>/webhooks/c2pa", "events": ["verification.completed", "monitor.regression", "asset.lost", "usage.threshold"]}
```

Store the returned `secret` as `C2PA_WEBHOOK_SECRET`. The handler runs these steps **in this
order**:

1. **Raw body.** Read the bytes before any JSON middleware.
2. **Signature.** Headers `webhook-id`, `webhook-timestamp`, `webhook-signature`. Reject
   `|now - timestamp| > 300 s`. Key = standard-base64 decode of the secret without `whsec_` (a
   secret that does not decode is a configuration error — fail at startup). Compute
   `base64(HMAC-SHA256(key, "{id}.{timestamp}.{body}"))` and compare in constant time against
   every space-separated `v1,<sig>` in the header; accept if any matches (during a rotation two
   are sent). Any `standardwebhooks` library does this.
3. **Parse.** Unparseable or missing `type` → `400`. Do this **before** step 4, or a bad body
   burns its `webhook-id` and the redelivery is lost.
4. **Deduplicate on `webhook-id`** in a store **shared by all replicas**: Redis
   `SET webhook:<id> 1 NX EX 86400`, or a unique index on a deliveries table. A process-memory
   cache does not work with more than one replica. Already seen → `2xx` without processing.
5. **Enqueue and answer `2xx` within 10 s.** If enqueueing fails, delete the dedupe key and
   answer `5xx` so the retry is processed.
6. **Branch on `type`**; ignore unknown types with `2xx`.

Envelope: `{"id", "type", "created_at", "occurred_at", "data"}`. Payload schemas for every type,
`ping` included, are in the OpenAPI (`WebhookEvent*`); generate types from them.

| Guarantee | Value |
|---|---|
| Delivery | At least once; six attempts over ~6 h; 10 s timeout |
| `webhook-id` | One per delivery to your endpoint; identical on every retry. Envelope `id` is the event id |
| Order | Not guaranteed, even for one object. Use `occurred_at` to drop stale events (e.g. `monitor.run.completed` may arrive before `monitor.regression`) |
| `ping` | Signed exactly like other events; deduplicate it like any other |
| Disabling | 20 consecutive failures disable the endpoint and email the organization owners. `POST /webhooks/{id}/enable` re-enables it |
| Source IP | Deliveries come from the prefixes in `https://c2pa.design/bot/ips.json` (same list as the crawler; `creationTime` moves when it changes). Behind a WAF or firewall, allow them by fetching the list, not by hard-coding. An allowed IP is not proof: always verify the signature |
| Rotation | `POST /webhooks/{id}/rotate-secret` returns the new secret once; the old one keeps signing for 24 h (`previous_secret_expires_at`), both signatures are sent meanwhile |

**Personal data in payloads.** Fields that echo the customer's own `metadata` verbatim are marked
`x-echoes-customer-metadata` in the schema; `asset.*` `location` is the URL as found (query string
included); `monitor.regression` contains checkpoint names. No payload holds an IP. Signed URLs
(`x-signed-url`) appear only in `evidence_pack.ready` and expire after 7 days. Log `webhook-id` and
`type`; log `data` only if the metadata you send is not personal. c2pa.design keeps sent payloads
30 days: https://c2pa.design/legal/privacy.

Then call `POST /webhooks/{id}/test`, confirm the `ping` arrives and verifies, and keep the
example's tests: valid signature, modified body, 10-minute-old timestamp, redelivery, signed but
unparseable body.

## 6. Generated and composite media

Pick by what the step does to the picture:

| Step | Do | Result |
|---|---|---|
| Re-encode, resize, compress, format change (PNG → WebP) | `c2pa-check carry --from src --to out` | Source is `parentOf`; same picture checked |
| Edit or combine (chroma-key removal, crop, atlas, sprite sheet, collage) | `c2pa-check carry --compose a.png b.png … --to atlas.webp` | A new work: `c2pa.created` (digital source type `composite`) + `c2pa.placed`; every source is a `componentOf` ingredient with its manifest kept. `--edited` for a single-source edit: source `parentOf`, `c2pa.opened` + `c2pa.edited` |
| No credential wanted on the output, or sources unsigned | `POST /assets` with the hashes of the sources **and** of the output | Inventory and stripped-copy matching only; no credential in the file |

`--compose` signs with your own key (`C2PA_SIGN_CERT`/`C2PA_SIGN_KEY`) or a local key with a
warning; hosted signing does not accept composites yet. Registering only the sources' hashes does
not cover an output that differs from them — register the output too.

For a pipeline like generate → chroma key → crop → atlas → WebP: compose the atlas from the
generated sources, then `carry` the atlas to WebP. Register the final files with `POST /assets`.

## 7. CI gate

Pin the version everywhere: `c2pa-check@0.2.0`. Release archives ship `SHA256SUMS`; the npm
package is published with provenance. `--format text|json|ndjson|junit`, `--output <path>`.

GitHub Actions:

```yaml
- uses: c2pa-design/c2pa-check-action@v1
  with:
    version: v0.2.0
    paths: "public/**/*.{jpg,jpeg,png,webp,avif}"
    coverage: 80
    format: junit
    output: c2pa-check.xml
```

GitLab CI:

```yaml
c2pa-check:
  image: node:22-bookworm-slim
  variables:
    npm_config_cache: "$CI_PROJECT_DIR/.npm"
  cache:
    key: c2pa-check-0.2.0
    paths: [.npm/]
  script:
    - npx -y c2pa-check@0.2.0 'public/**/*.{jpg,png,webp}' --coverage 80 --format junit --output c2pa-check.xml
  artifacts:
    when: always
    reports:
      junit: c2pa-check.xml
```

Bitbucket Pipelines:

```yaml
pipelines:
  default:
    - step:
        name: c2pa-check
        image: node:22-bookworm-slim
        caches: [node]
        script:
          - npx -y c2pa-check@0.2.0 'public/**/*.{jpg,png,webp}' --coverage 80 --format junit --output test-results/c2pa-check.xml
```

CircleCI:

```yaml
jobs:
  c2pa-check:
    docker: [{image: node:22-bookworm-slim}]
    steps:
      - checkout
      - restore_cache: {keys: [c2pa-check-0.2.0]}
      - run: npx -y c2pa-check@0.2.0 'public/**/*.{jpg,png,webp}' --coverage 80 --format junit --output test-results/c2pa-check.xml
      - save_cache: {key: c2pa-check-0.2.0, paths: [~/.npm]}
      - store_test_results: {path: test-results}
```

Coverage: run once locally and set `--coverage` to today's number so the gate catches regressions
without failing on day one. Raise it as §6 covers generated media; 100 only once every shipped
file is carried, composed or deliberately unsigned (exclude those paths from the glob).

Post-deploy, check what the CDN serves:
`npx -y c2pa-check@0.2.0 https://cdn.example.com/hero.jpg --expect trusted`.

Exit codes: `0` pass, `1` expectation or coverage failed, `2` usage, `3` unreadable asset, `4`
network, `5` carry refused.

**Docker.** Pass the key as a build secret, never `COPY` or `ARG`:

```dockerfile
RUN --mount=type=secret,id=c2pa_key,env=C2PA_API_KEY npx -y c2pa-check@0.2.0 carry 'public/**/*.webp' --from-dir src/
```

BuildKit's cache key for this `RUN` covers the command and the inputs, not the secret: an
unchanged layer is reused with its old signatures (and their old timestamps), a changed source
re-signs. That is fine for provenance; for byte-reproducible images sign before `docker build`
and `COPY` the signed files, or bust the layer with a `--build-arg` that changes per release.

## 8. Agent access (optional)

```bash
claude mcp add --transport http c2pa https://api.c2pa.design/mcp --header "Authorization: Bearer $C2PA_API_KEY"
npx skills add c2pa-design/skills
```

If the MCP server does not connect, continue with REST and `c2pa-check`: everything the MCP tools
do is available there.

## 9. Verify and hand over

1. `npx -y c2pa-check@0.2.0 doctor` (or `GET /whoami`): key type, organization, quota left,
   webhook secret format, Node version. Fix anything that fails before going on.
2. One `POST /verifications` with the test key against
   `https://c2pa.design/samples/ai-signed.jpg`; print `credential.status`.
3. `POST /webhooks/{id}/test` and show the handler log line.
4. Run the CI command locally.
5. Checklist for the user: env vars and their secret store, DNS TXT record (if a domain), WAF
   rules (if any: the crawler UA, and `https://c2pa.design/bot/ips.json` for webhook deliveries), switch from `c2pa_test_` to `c2pa_live_`.

Docs: https://c2pa.design/docs/agents · https://docs.c2pa.design
