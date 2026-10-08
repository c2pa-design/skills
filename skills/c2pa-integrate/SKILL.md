---
name: c2pa-integrate
description: Connect a codebase to c2pa.design in one pass — API client in the server's own language, API key and webhook secret in env, signed webhook receiver, monitors, domain crawlers, asset inventory and a CI gate, all with retries, backoff and idempotency. Use when the user asks to integrate, connect, set up or install c2pa.design, Content Credentials monitoring, C2PA verification, provenance webhooks or the c2pa-check CI gate in their project.
license: MIT OR Apache-2.0
metadata:
  homepage: https://c2pa.design/docs/agents
  openapi: https://docs.c2pa.design/openapi.yml
  version: "1"
---

# c2pa-integrate

You are wiring the user's project to c2pa.design. Goal: working integration in about five
minutes, nothing secret committed, every call safe to retry. Work in this order, show the user a
short plan first, and ask only for what you cannot find in the repo.

Never describe a result as real, fake or "AI detected". Report `credential.status`
(`absent | present_invalid | valid_untrusted | valid_trusted | error`). A missing credential
proves nothing about the file.

## 0. Facts

| What | Value |
|---|---|
| REST base | `https://api.c2pa.design/v1` |
| OpenAPI 3 (public) | `https://docs.c2pa.design/openapi.yml` |
| Remote MCP | `https://api.c2pa.design/mcp` |
| Auth | `Authorization: Bearer c2pa_live_…` (`c2pa_test_…` costs no quota, answers from fixtures) |
| Keys | https://app.c2pa.design → API keys |
| Error envelope | `{"error":{"code":"…","message":"…","details":{}}}` — branch on `code`, never `message` |
| Rate headers | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` on every response |
| Crawler UA | `c2pa-design-bot/1.0`, honours robots.txt, 1 request/s per host |

## 1. Detect the stack

Read the repo before writing anything:

- Server language and framework: `go.mod`, `package.json` (Express, Fastify, Next.js, Nest),
  `pyproject.toml` / `requirements.txt` (FastAPI, Django, Flask), `Gemfile`, `composer.json`,
  `pom.xml` / `build.gradle`, `*.csproj`, `Cargo.toml`.
- How config is loaded (dotenv, envconfig, pydantic-settings, Rails credentials) and where
  `.env.example` lives.
- CI: `.github/workflows`, `.gitlab-ci.yml`, `bitbucket-pipelines.yml`, `.circleci`.
- Where media lives: `public/`, `static/`, `assets/`, upload buckets, a CDN host in config.
- Where images are generated or uploaded in code (OpenAI / Firefly / Gemini calls, S3 PUTs).

## 2. Secrets

Add to `.env.example` (empty values) and to the loader the project already uses. Never write a
real value into a tracked file, a log line, a test fixture or a CI file.

| Variable | Required | Use |
|---|---|---|
| `C2PA_API_KEY` | yes | Bearer token. Server-side only — never in a browser bundle (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_` prefixes are wrong) |
| `C2PA_WEBHOOK_SECRET` | if webhooks | `whsec_…`, shown once when the endpoint is created |
| `C2PA_API_BASE` | no | Defaults to `https://api.c2pa.design/v1` |
| `C2PA_PROJECT_ID` | no | Scopes monitors, domains and assets to one project |

Tell the user where to put the real values: the platform's secret store (GitHub Actions
secrets, GitLab CI variables, Vercel/Fly/Render/Railway env, Kubernetes Secret, AWS/GCP Secret
Manager, Doppler, 1Password). Check `.gitignore` covers `.env`. Use a `c2pa_test_` key until
the integration passes, then swap to `c2pa_live_`.

## 3. API client

Generate a typed client from `https://docs.c2pa.design/openapi.yml` with the generator idiomatic
for the stack, or write a thin wrapper when the project avoids codegen:

| Stack | Generator |
|---|---|
| TypeScript | `openapi-typescript` + `openapi-fetch` |
| Go | `ogen` or `oapi-codegen` |
| Python | `openapi-python-client` |
| Java / Kotlin | `openapi-generator` (`java` / `kotlin`) |
| C# | `NSwag` or `Kiota` |
| Ruby, PHP, Rust | `openapi-generator` |

Wrap it in one small module (`c2pa` client) that every call goes through. That module owns:

1. **Timeouts.** 30 s per request; URL verifications can take that long on slow hosts.
2. **Retry only what is retryable.** Retry on network errors and on `code` in
   `rate_limited` (429), `engine_unavailable` (503), `url_unreachable` (422), `internal` (500,
   once). Never retry `invalid_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
   `url_forbidden`, `asset_too_large`, `unsupported_media_type`, `parse_failed`,
   `idempotency_conflict`.
3. **Backoff.** If `Retry-After` is present, wait exactly that long. Otherwise exponential with
   full jitter: `sleep = random(0, min(30s, 0.5s * 2^attempt))`, at most 5 attempts.
4. **Quota.** `usage_limit_exceeded` (429) means the plan is spent until the period end given in
   `Retry-After`. Do not retry; surface it (log + alert) and fall back gracefully.
5. **Idempotency.** Send `Idempotency-Key: <uuid v4 or a stable hash of the input>` on every
   `POST /verifications`. A retry with the same key within 24 h returns the first answer.
6. **Proactive slow-down.** When `X-RateLimit-Remaining` is 0, wait before the next call
   instead of waiting to be refused.
7. **Logging.** Log method, path, status, `error.code`, attempt number. Never log the key.
8. **Results are not errors.** `200` with `credential.status: "absent"` or `present_invalid` is
   a successful check with an unwelcome answer.

## 4. Wire the calls the project needs

Ask which of these the user wants; default to verification + webhooks + CI.

| Need | Calls |
|---|---|
| Verify a URL the app serves or receives | `POST /verifications {"url": "…", "metadata": {"order_id": "…"}}` → sync result |
| Verify a file the server holds | `POST /verifications {"upload": true, "filename", "content_type", "size_bytes"}` → `PUT` bytes to `upload.url` with `upload.headers` → `POST /verifications/{id}/complete` → webhook `verification.completed` or poll `GET /verifications/{id}` (max 64 MiB) |
| Watch a pipeline (generator → storage → resize → CDN) | `POST /monitors {"name", "schedule": "hourly", "checkpoints": [{"name": "CDN", "url": "…", "expect": "present_trusted"}]}` |
| Crawl a whole site (Autopilot) | `POST /domains {"host"}` → add the returned `txt_record` to DNS or serve `file_token` at `file_url` → `POST /domains/{id}/verify`; recrawl with `POST /domains/{id}/crawl` (≥10 min apart) |
| One-off public scan of a site | `POST /scans {"host"}` → poll `GET /scans/{id}` every 3 s; 1 scan per 10 min per IP |
| Register assets the project generated | `POST /assets/sync {"hashes": [sha256…]}` → `POST /assets` with only the unknown ones (≤500 per call, ≤5000 hashes per sync) |
| Export the inventory | `GET /assets/export` (CSV) |

Attach `metadata` (≤10 string pairs) with the project's own IDs so webhooks map back to rows.

For the crawler: if the site sits behind Cloudflare, Akamai or a WAF, tell the user to allow
the user agent `c2pa-design-bot` and check `robots.txt` does not disallow it. A blocked crawl
shows as `last_error` on the domain.

## 5. Webhook receiver

Create one endpoint in the project's framework, e.g. `POST /webhooks/c2pa`, then register it:

```
POST /webhooks {"url": "https://<their host>/webhooks/c2pa", "events": ["verification.completed", "monitor.regression", "asset.lost", "usage.threshold"]}
```

Store the returned `secret` as `C2PA_WEBHOOK_SECRET` — it is never shown again.

The handler must (Standard Webhooks):

1. Read the **raw body bytes** before any JSON parsing middleware touches them.
2. Take headers `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64>`).
3. Reject if `|now - timestamp| > 300 s`.
4. Compute `base64(HMAC-SHA256(key, "{id}.{timestamp}.{body}"))`, where `key` is the secret with
   the `whsec_` prefix removed and standard-base64-decoded (a secret issued before 2026-10-08
   that does not decode: use its UTF-8 bytes as the key); compare in constant time
   (`hmac.Equal`, `crypto.timingSafeEqual`, `hmac.compare_digest`). A header may list several
   space-separated signatures; accept if any matches.
5. Deduplicate on `webhook-id` (unique column or cache with 24 h TTL): delivery is
   at-least-once.
6. Answer `2xx` within 10 s. Do the work in the project's queue (Sidekiq, Celery, BullMQ,
   River, SQS…) — six attempts over ~6 h, 20 consecutive failures disable the endpoint.
7. Branch on `type`: `verification.completed`, `monitor.run.completed`, `monitor.regression`,
   `usage.threshold`, `asset.lost`, `asset.stripped_copy_seen`, `digest.ready`,
   `evidence_pack.ready`. Ignore unknown types with `2xx`.

Prefer an existing Standard Webhooks library when the stack has one (`standardwebhooks` for
JS/Python/Go/Ruby/PHP/Java/C#). Then call `POST /webhooks/{id}/test` and confirm the `ping`
arrives and verifies. Write one test: a valid signature passes, a modified body fails, a
timestamp 10 minutes old fails.

## 6. CI gate

Fail the build when shipped media loses its credential.

GitHub Actions:

```yaml
- uses: c2pa-design/c2pa-check-action@v1
  with:
    paths: "public/**/*.{jpg,jpeg,png,webp,avif}"
    coverage: 100
    format: junit
```

Any other CI:

```bash
npx -y c2pa-check 'public/**/*.{jpg,png,webp}' --coverage 100
```

Post-deploy, check what the CDN actually serves (that is where credentials usually disappear):

```bash
npx -y c2pa-check https://cdn.example.com/hero.jpg --expect trusted
```

Exit codes: `0` pass, `1` expectation/coverage failed, `2` usage, `3` unreadable asset, `4`
network. Set `coverage` to what the repo actually has today (run once locally) so the gate
catches regressions instead of failing day one. No API key is needed for this step.

## 7. Agent access (optional)

```bash
claude mcp add --transport http c2pa https://api.c2pa.design/mcp --header "Authorization: Bearer $C2PA_API_KEY"
npx skills add c2pa-design/skills     # c2pa-check skill: offline checks + asset lockfile
```

## 8. Verify and hand over

1. Run one `POST /verifications` with the test key against
   `https://c2pa.design/samples/ai-signed.jpg` and print `credential.status`.
2. Fire `POST /webhooks/{id}/test` and show the handler log line.
3. Run the CI command locally.
4. Give the user a checklist: env vars to set in which secret store, the DNS TXT record (if a
   domain was added), the WAF allow rule (if any), and the switch from `c2pa_test_` to
   `c2pa_live_`.

Docs: https://c2pa.design/docs/agents · https://docs.c2pa.design
