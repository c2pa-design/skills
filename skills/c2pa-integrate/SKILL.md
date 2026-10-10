---
name: c2pa-integrate
description: Connect a codebase to c2pa.design in one pass — API key and webhook secret in env, signed webhook receiver, monitors, domain crawlers, asset inventory, provenance for generated and composite media, and a CI gate, all with retries, backoff and idempotency. Use when the user asks to integrate, connect, set up or install c2pa.design, Content Credentials monitoring, C2PA verification, provenance webhooks or the c2pa-check CI gate in their project.
license: MIT OR Apache-2.0
metadata:
  homepage: https://c2pa.design/docs/agents
  openapi: https://docs.c2pa.design/openapi.yml
  version: "3"
---

# c2pa-integrate

You are wiring the user's project to c2pa.design. Goal: working integration in about five
minutes, nothing secret committed, every call safe to retry. Work in this order, show the user a
short plan first, and ask only for what you cannot find in the repo.

**Write no glue code.** The whole integration is one file and three commands; a script that
batches, retries or lists-then-creates is a sign you missed a command:

| Job | Command |
|---|---|
| Gate the build, several file sets with their own thresholds | `c2pa-check` (reads `c2pa.json`, §7) |
| Register files in the inventory | `c2pa-check register` or `--register` on the gate (§6) |
| Webhooks, monitors, domains | `c2pa-check apply` (§4) |
| Keep the chain through a conversion | `c2pa-check carry` |
| Get a key without the dashboard | `c2pa-check login` (the user approves a code in a browser) |
| Check the setup | `c2pa-check doctor --require api_key` |

The only code you write is the webhook receiver (§5), copied from an example.

**Always carry.** After you (or code you write) convert, resize, compress or re-encode any image,
video or audio file that had a Content Credential, run
`npx -y c2pa-check@0.3.0 carry --from <source> --to <output>` before shipping the output. Every
re-encode drops the manifest; `carry` writes a new one with the source as `parentOf` ingredient.
Exit `5` means it refused (`--json` gives `rule`: `different_picture`, `source_unsigned`,
`low_quality`, `not_comparable`, or the server's `carry_rejected` rule). A changed picture is not
a carry: see §6.

Never describe a result as real, fake or "AI detected". Report `credential.status`
(`absent | present_invalid | valid_untrusted | valid_trusted | error`) using the labels in
`https://c2pa.design/skills/c2pa-integrate/status-labels.json` (en, de, es, fr, ja, ko, ru, zh-CN,
pt-BR) so every integration shows the same words. For another language translate the `en` entries
and keep the five keys; send the result to hello@c2pa.design to have it added. A missing
credential proves nothing about the file.

## 0. Facts

| What | Value |
|---|---|
| REST base | `https://api.c2pa.design/v1` |
| OpenAPI 3 (public) | `https://docs.c2pa.design/openapi.yml` — includes every webhook payload (`WebhookEvent*`, index `x-webhooks`) |
| Remote MCP | `https://api.c2pa.design/mcp` — protocol `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26` (negotiated). Works without a key: `verify_url`, `inspect_manifest`, `ecosystem_lookup`, `trust_status` (20 calls/hour per IP); `check_pipeline` needs a key |
| Network | Outbound HTTPS (443) to `api.c2pa.design` from every place that calls the API or runs `c2pa-check` with a key: servers, CI runners, build containers. Inbound: webhook deliveries (§5) |
| Auth | `Authorization: Bearer c2pa_live_…` or `c2pa_test_…` |
| Keys | https://app.c2pa.design → your organization → **API keys** (`/o/<org>/keys`) |
| Check setup | `GET /whoami` → `key_type`, `organization`, `project`, `plan`, `quota[{metric, used, limit, period_end}]`; or `npx -y c2pa-check@0.3.0 doctor` (also says when this skill is out of date) |
| Error envelope | `{"error":{"code":"…","message":"…","retryable":true,"details":{}}}` — branch on `code`/`retryable`, never `message` |
| Rate headers | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` |
| CLI | `c2pa-check@0.3.0`, Node ≥ 18, `SHA256SUMS` + provenance attestation on every GitHub release. Linux builds are static (musl): Alpine and distroless work |
| Error reports | When a command ends with an error (exit 2–5 or a crash) `c2pa-check` sends `{version, os, arch, command, exit_code, code, mime, ci}` to `POST /cli-reports` from a detached process (the command does not wait) and prints what it sends. Fixed slugs only: no file names, paths, URLs, hashes or keys, no API key attached. Off with `C2PA_TELEMETRY=0`, `DO_NOT_TRACK=1` or `--offline` |
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

### Network access

Where outbound traffic is denied by default (Kubernetes `NetworkPolicy`, an egress gateway, a
corporate proxy, a locked-down CI runner), allow HTTPS to `api.c2pa.design` or the API calls,
hosted signing and `register` fail with a timeout (exit `4`; `carry` falls back to a local key
with a warning).

| From | To | Needed for |
|---|---|---|
| Server pods, workers | `api.c2pa.design:443` | Every API call |
| CI runners, build containers | `api.c2pa.design:443` | `carry` with a key, `register`, `apply`, `doctor`, error reports |
| CI runners | `registry.npmjs.org:443` (or your mirror) | `npx c2pa-check`; not needed with the release binary |
| c2pa.design → your ingress | prefixes in `https://c2pa.design/bot/ips.json` | Webhook deliveries, domain crawls |

`NetworkPolicy` matches IPs, not names, and the API sits behind a CDN whose addresses change:
allow by host name. Cilium:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata: { name: allow-c2pa-design }
spec:
  endpointSelector: { matchLabels: { app: <your-app> } }
  egress:
    - toFQDNs: [{ matchName: api.c2pa.design }]
      toPorts: [{ ports: [{ port: "443", protocol: TCP }] }]
```

Istio: a `ServiceEntry` for `api.c2pa.design` (port 443, `resolution: DNS`). Plain
`NetworkPolicy` without FQDN support: route through the cluster's egress proxy and set
`HTTPS_PROXY`. Verify from inside the pod: `npx -y c2pa-check@0.3.0 doctor` → `ok network`.

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
| `C2PA_WEBHOOK_SECRET` | if webhooks | `whsec_` + standard base64 of 24–64 bytes. Generate it yourself in the secret store (`echo "whsec_$(openssl rand -base64 32)"`) and `apply` registers it; it is then never printed anywhere |
| `C2PA_API_BASE` | no | Defaults to `https://api.c2pa.design/v1` |
| `C2PA_PROJECT_ID` | no | Scopes monitors, domains and assets to one project |
| `C2PA_SIGN_CERT`, `C2PA_SIGN_KEY` | no | Own C2PA certificate chain and key (PEM, or `_FILE` paths) for `carry`; never sent anywhere |
| `C2PA_TSA_URL` | no | RFC 3161 timestamp for own-key carries |
| `C2PA_TELEMETRY` | no | `0` turns the anonymous error reports off |

**Getting the key.** Ask the user to run `npx -y c2pa-check@0.3.0 login --test` (add
`--ci github` or `--ci gitlab` to also store it as the repository's `C2PA_API_KEY` secret). It
prints a link and a code; they approve it in a browser as an owner or admin; the key is saved in
`~/.config/c2pa-check/credentials` and used whenever `C2PA_API_KEY` is unset. You cannot approve
the code yourself, and a Docker build or CI job cannot either: those read the secret.

**No key is never a build failure.** Without `C2PA_API_KEY`, `register`, `--register` and `apply`
print a warning, send nothing and exit `0`; `carry` signs with a local key and warns; checks are
local anyway. So the integration can be committed before the user has an account. Use
`doctor --require api_key` only where a missing key must stop the job.

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
| `PUT /webhooks` | Idempotent by `url`: creates, or updates `events` (and rotates in a different `secret`) |
| `POST /webhooks`, `/monitors`, `/domains` | Not idempotent (`/domains` answers `409` for a known host). Use `c2pa-check apply`, which matches monitors by name and domains by host |
| `/sign` | Not idempotent; each call is a new signature |

## 4. Account setup: `c2pa.json` + `apply`

Declare what the account should have in `c2pa.json` at the repo root (commit it; it holds no
secret) and run `apply` from the deploy job. It is safe on every deploy and deletes nothing.

```json
{
  "checks": [
    { "name": "shipped", "paths": ["public/**/*.{jpg,png,webp}"], "baseline": "c2pa-baseline.json" },
    { "name": "sources", "paths": ["design/**/*.png"], "coverage": 39, "git_tracked": true }
  ],
  "webhooks": [
    { "url": "https://<host>/webhooks/c2pa", "events": ["verification.completed", "monitor.regression", "asset.lost", "asset.stripped_copy_seen", "usage.threshold"] }
  ],
  "monitors": [
    { "name": "CDN", "schedule": "hourly", "checkpoints": [{ "name": "hero", "url": "https://cdn.example.com/hero.jpg", "expect": "present_trusted" }] }
  ],
  "domains": ["example.com"]
}
```

```bash
npx -y c2pa-check@0.3.0 apply --ping          # webhooks (PUT by URL), monitors (by name), domains (by host)
npx -y c2pa-check@0.3.0 apply --wait 600      # also wait up to 10 min for the domain proof
```

| Part | Behaviour |
|---|---|
| Webhook secret | Taken from `C2PA_WEBHOOK_SECRET`. Or `--secret-out <path>`: created owner-only on the first run, reused afterwards. Never printed. A changed secret is rotated in with a 24 h overlap. With neither, `apply` refuses to create an endpoint (exit `2`) and changes nothing |
| Domains | A new host prints its DNS TXT record and well-known file; `apply` rechecks the proof on every run. `--wait` polls every 15 s and exits `1` if still pending |
| Monitors | Each entry is the `MonitorWrite` body; an existing name is updated |
| Unknown keys | An error, not ignored: a typo cannot silently disable a gate |

`checks` are used by the CI gate (§7) and by `register` (§6). Every section is optional.

### Direct API calls

| Need | Calls |
|---|---|
| Verify a URL | `POST /verifications {"url", "metadata": {"order_id": "…"}}` → sync result |
| Verify a file the server holds | `POST /verifications {"upload": true, "filename", "content_type", "size_bytes"}` → `PUT` bytes to `upload.url` with `upload.headers` → `POST /verifications/{id}/complete` → webhook `verification.completed` or poll `GET /verifications/{id}` |
| Watch a pipeline | `POST /monitors {"name", "schedule": "hourly", "checkpoints": [{"name": "CDN", "url": "…", "expect": "present_trusted"}]}` |
| Crawl a site | `POST /domains {"host"}` → DNS `txt_record` or `file_token` at `file_url` → `POST /domains/{id}/verify`; recrawl `POST /domains/{id}/crawl` |
| One-off public scan | `POST /scans {"host"}` → poll `GET /scans/{id}` every 3 s |
| Register assets at runtime | `POST /assets/sync {"hashes"}` → `POST /assets` with only the unknown ones (body in §6). From a build or CI: `c2pa-check register` |
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
https://github.com/c2pa-design/skills/tree/HEAD/examples/webhook-receiver. Adapt one rather than
writing from scratch. Their shared `vectors.json` covers a plain delivery, a rotation (two
signatures) and a stale timestamp; run it against your handler.

Register the endpoint with `apply` (§4). By hand it is one idempotent call; send your own
`secret` so it never appears in a response or a log:

```
PUT /webhooks {"url": "https://<host>/webhooks/c2pa", "events": ["verification.completed", "monitor.regression", "asset.lost", "usage.threshold"], "secret": "<C2PA_WEBHOOK_SECRET>"}
```

`201` created, `200` already there (events updated). Without `secret` one is generated and
returned once, on `201` only. The handler runs these steps **in this order**:

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
| No credential wanted on the output, or sources unsigned | `c2pa-check register` on the sources **and** the output | Inventory and stripped-copy matching only; no credential in the file |

`--compose` uses the same signer order as a carry. With `C2PA_API_KEY`, c2pa.design signs the
composite as "<verified domain> via c2pa.design" when:

| Hosted composite rule | Otherwise |
|---|---|
| The organization has a verified domain (§4 `domains`) | local key + warning `signing_disabled`; not a failure |
| Every source is `componentOf` (one `parentOf` with `--edited`) | exit `5`, `ingredient_mismatch` |
| Every credential a source carries validates | exit `5`, `component_invalid` |
| At least one source carries a credential | exit `5`, `component_unsigned` |

Unsigned sources may be mixed in. The sources are not uploaded separately: they travel inside the
composite as ingredients. Tell the user what the signature means: their account states the file
was composed from these sources; c2pa.design checked the sources' credentials, not the pixels.
Registering only the sources' hashes does not cover an output that differs from them — register
the output too.

For a pipeline like generate → chroma key → crop → atlas → WebP: compose the atlas from the
generated sources, then `carry` the atlas to WebP, then register the final files.

### Register files

```bash
npx -y c2pa-check@0.3.0 register 'public/**/*.{jpg,png,webp}' 'design/**/*.png'   # or no globs: the checks in c2pa.json
npx -y c2pa-check@0.3.0 --register                                                # gate and register in one run
```

It checks each file locally, asks which sha256 hashes are unknown (`POST /assets/sync`, 5000 per
call) and sends only those (`POST /assets`, 500 per call), with retries. Bytes never leave the
machine. Needs `C2PA_API_KEY`; `C2PA_PROJECT_ID` scopes it. Exit `4` when the API call failed.

Calling the API yourself: `POST /assets` takes the **whole result object** of a check per item,
not just a hash (status, signer and fingerprints are read from it):

```json
{"items": [{"location": "public/hero.webp", "source": "skill", "result": { …one element's "result" from `c2pa-check --format json`… }}]}
```

| `source` | Send it when |
|---|---|
| `skill` | Files checked in a repository, a build or CI (what `register` sends) |
| `upload` | Files your server received from users |
| `track` | A file an agent hook reported right after writing it |
| `crawl`, `verifier`, `carry` | Written by c2pa.design itself; do not send |

## 7. CI gate

Pin the version everywhere: `c2pa-check@0.3.0`. Release archives ship `SHA256SUMS`; the npm
package is published with provenance. With no target the command runs every entry of `checks` in
`c2pa.json` (§4) and names the one that failed.

| Per check | Meaning |
|---|---|
| `paths` | Globs. `public/**` in the examples is only an example: list every place shipped media lives (CDN uploads kept in the backend, generator sources in `design/`) |
| `baseline` | File of `path → status`. The build fails when a file that had a valid credential has lost it. Catches one lost file even at 0 % or 39 % coverage; prefer it to a percentage |
| `coverage` | Minimum share of `valid_trusted` files, for sets where a percentage is the goal |
| `expect` | `present`, `trusted` or `absent` for every file |
| `git_tracked` | Count only files git tracks, so a laptop and CI see the same set |

Create the baseline once and commit it; refresh it the same way after an intended change:

```bash
npx -y c2pa-check@0.3.0 --update-baseline
```

One run can write several reports: the Nth `--output` takes the Nth `--format`
(`text|json|ndjson|junit`). The same options exist as flags for a single set:
`c2pa-check 'public/**/*.webp' --baseline c2pa-baseline.json --git-tracked`.

GitHub Actions:

```yaml
- uses: c2pa-design/c2pa-check-action@v1
  with:
    version: v0.3.0
    format: junit
    output: c2pa-check.xml
    register: ${{ github.ref == 'refs/heads/main' }}
  env:
    C2PA_API_KEY: ${{ secrets.C2PA_API_KEY }}
```

GitLab CI:

```yaml
c2pa-check:
  image: node:22-alpine
  variables:
    npm_config_cache: "$CI_PROJECT_DIR/.npm"
  cache:
    key: c2pa-check-0.3.0
    paths: [.npm/]
  script:
    - npx -y c2pa-check@0.3.0 --format junit --output c2pa-check.xml --format json --output c2pa-check.json
  artifacts:
    when: always
    reports:
      junit: c2pa-check.xml
  rules:
    - changes: &c2pa-changes ["public/**/*", "design/**/*.png", "c2pa.json", "c2pa-baseline.json", ".gitlab-ci.yml"]

c2pa-register:
  image: node:22-alpine
  needs: []
  allow_failure: true
  script:
    - npx -y c2pa-check@0.3.0 register
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $C2PA_API_KEY'
      changes: *c2pa-changes
```

Bitbucket Pipelines:

```yaml
pipelines:
  default:
    - step:
        name: c2pa-check
        image: node:22-alpine
        caches: [node]
        condition: { changesets: { includePaths: ["public/**", "design/**", "c2pa.json", "c2pa-baseline.json"] } }
        script:
          - npx -y c2pa-check@0.3.0 --format junit --output test-results/c2pa-check.xml
  branches:
    main:
      - step:
          name: c2pa-register
          image: node:22-alpine
          script:
            - npx -y c2pa-check@0.3.0 register
```

CircleCI:

```yaml
jobs:
  c2pa-check:
    docker: [{image: node:22-alpine}]
    steps:
      - checkout
      - restore_cache: {keys: [c2pa-check-0.3.0]}
      - run: npx -y c2pa-check@0.3.0 --format junit --output test-results/c2pa-check.xml --register
      - save_cache: {key: c2pa-check-0.3.0, paths: [~/.npm]}
      - store_test_results: {path: test-results}
```

Without `c2pa.json` every example works with a glob and flags instead
(`'public/**/*.{jpg,png,webp}' --coverage 80`). Run the gate only when media, `c2pa.json` or the CI
file changed (the `rules: changes` / `changesets` above); the register job runs on the default
branch only and must not block the build.

Starting numbers: `--update-baseline` on day one, so nothing fails until a signed file loses its
credential. Add `coverage` at today's figure for sets that should grow, and raise it as §6 covers
generated media; 100 only once every shipped file is carried, composed or deliberately unsigned
(exclude those paths from the glob).

Post-deploy, check what the CDN serves:
`npx -y c2pa-check@0.3.0 https://cdn.example.com/hero.jpg --expect trusted`.

Exit codes: `0` pass, `1` expectation, coverage or baseline failed, `2` usage, `3` unreadable
asset, `4` network or API call failed, `5` carry refused.

**Docker.** Pass the key as a build secret, never `COPY` or `ARG`:

```dockerfile
RUN --mount=type=secret,id=c2pa_key,env=C2PA_API_KEY npx -y c2pa-check@0.3.0 carry 'public/**/*.webp' --from-dir src/
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

The header is optional: without a key the server lists the same tools and answers the public ones
at the anonymous rate. If the MCP server does not connect, continue with REST and `c2pa-check`:
everything the MCP tools do is available there.

## 9. Verify and hand over

1. `npx -y c2pa-check@0.3.0 doctor --require api_key,webhook_secret` (list only what this
   integration uses): key type, organization, quota left, webhook secret format, Node version,
   skill version. `--require` turns a missing value into exit `1`, so the same line is a CI
   pre-flight. Fix anything that fails before going on.
2. One `POST /verifications` with the test key against
   `https://c2pa.design/samples/ai-signed.jpg`; print `credential.status`.
3. `npx -y c2pa-check@0.3.0 apply --ping` and show the handler log line for the `ping`.
4. Run the CI command locally.
5. Checklist for the user: env vars and their secret store, DNS TXT record (if a domain), egress
   to `api.c2pa.design:443` from pods and CI runners (§0 Network access), WAF rules (if any: the
   crawler UA, and `https://c2pa.design/bot/ips.json` for webhook deliveries), switch from
   `c2pa_test_` to `c2pa_live_`.

Docs: https://c2pa.design/docs/agents · https://docs.c2pa.design
