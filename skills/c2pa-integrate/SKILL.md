---
name: c2pa-integrate
description: Connect a codebase to c2pa.design in one pass — API key and webhook secret in env, signed webhook receiver, monitors, domain crawlers, asset inventory, provenance for generated and composite media, and a CI gate, all with retries, backoff and idempotency. Use when the user asks to integrate, connect, set up or install c2pa.design, Content Credentials monitoring, C2PA verification, provenance webhooks or the c2pa-check CI gate in their project.
license: MIT OR Apache-2.0
metadata:
  homepage: https://c2pa.design/docs/agents
  openapi: https://docs.c2pa.design/openapi.yml
  version: "8"
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
`npx -y c2pa-check carry --from <source> --to <output>` before shipping the output. Every
re-encode drops the manifest; `carry` writes a new one with the source as `parentOf` ingredient.
Exit `5` means it refused (`--json` gives `rule`: `different_picture`, `source_unsigned`,
`low_quality`, `not_comparable`, or the server's `carry_rejected` rule). A changed picture is not
a carry: add `--edited` when the step may change it, and see §6.

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
| Check setup | `GET /whoami` → `key_type`, `organization`, `project {id, name, archived}` (only for a project-scoped key), `resolved_project {id, name, default}` (where a write without `project_id` lands), `plan`, `quota[{metric, used, limit, period_end}]`; or `npx -y c2pa-check doctor` (prints `project <name>`, `(default)` when the key has no project, `FAIL` when the project is archived; also says when this skill is out of date) |
| Error envelope | `{"error":{"code":"…","message":"…","retryable":true,"details":{}}}` — branch on `code`/`retryable`, never `message` |
| Rejected key | `401 unauthorized` carries `details.reason`: `revoked` (issue a new key), `unknown` (wrong key or wrong environment) or `malformed` (truncated or quoted in the secret store). `403 forbidden` for a missing scope carries `details.scope`. `doctor` prints both |
| Projects | Every row belongs to a project; rules in §4. `403 project_mismatch`: a project-scoped key named another project (`details.project_id` is the key's). `project_archived` with `details {project_id, name}`: `409` on a write that names an archived project, `403` on every call except `GET /whoami` for a key scoped to one. Neither is retryable: fix the configuration |
| Inventory coverage | `GET /assets/coverage?project_id=&domain_id=` → `{assets, unsigned_by_design, expected, valid, traced, trusted, coverage_pct, traced_pct, trusted_pct}` over tracked assets of the last 30 days. `expected` = `assets` − `unsigned_by_design` and is the denominator of all three shares. `valid`: intact credential. `traced`: intact credential whose chain reaches a signer on the C2PA trust list (a hosted carry from a signed original is traced, the file itself stays `valid_untrusted`). `trusted`: `valid_trusted`. This is the number the dashboard shows; `GET /coverage` is the series of `POST /verifications` calls only |
| Rate headers | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` |
| Public coverage | `GET /public/coverage/{host}`, no key, 600/hour per address, cacheable for 5 minutes (`ETag`). Returns `{schema, host, name, verified_at, assets, unsigned_by_design, expected, valid, traced, trusted, coverage_pct, traced_pct, trusted_pct, declared_ai, sources{crawl,ci,api}, projects[], checked_at, recheck_minutes, stale, small_sample, trust_list_version}`, plus `signers[]` and `trend[]` only when the owner shows them, for an organization that published its space under a domain it verified (dashboard → **Public page**, owner only, off by default); `404 not_found` otherwise, the same for an unknown and an unpublished host. Badge: `GET /public/coverage/{host}/badge.svg` (same limit and cache). Shares are over `expected` (`assets` − `unsigned_by_design`); show `unsigned_by_design` next to any share and never word `traced` as "trusted": it says where the chain leads, not who signed the file. When `small_sample` is true (too few `expected` assets) show no percentage; when `stale` is true say the checks are more than seven days old. Counts cover the assets that organization registered, as last checked: never present the share as a statement about a whole product, and never read a missing credential as evidence |
| CLI | `c2pa-check`, current release 0.5.0 (every command in this file runs on it), Node ≥ 18, `SHA256SUMS` + provenance attestation on every GitHub release. Linux builds are static (musl): Alpine and distroless work |
| Error reports | When a command ends with an error (exit 2–4 or a crash; never for a failed gate, exit 1, or a carry refusal, exit 5) `c2pa-check` sends `{version, os, arch, command, exit_code, code, mime, ci}` to `POST /cli-reports` from a detached process (the command does not wait) and prints what it sends. Fixed slugs only: no file names, paths, URLs, hashes or keys, no API key attached. Off with `C2PA_TELEMETRY=0`, `DO_NOT_TRACK=1` or `--offline` |
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
`HTTPS_PROXY`. Verify from inside the pod: `npx -y c2pa-check doctor` → `ok network`.

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
- What re-encodes or serves media. Each of these drops the credential unless handled; search
  dependencies, build scripts, Dockerfiles and CDN config for them:

| Found in the repo | Do |
|---|---|
| `sharp`, `libvips`, ImageMagick (`convert`, `magick`), Pillow, `cwebp`, `ffmpeg`, Squoosh in a script or build step | `carry` right after the step (§6); `--edited` when it crops or retouches |
| `next/image`, an image loader or optimizer plugin | `carry` at build time and serve the carried file (`unoptimized` for it), or put a monitor checkpoint on the optimized URL |
| WordPress or another CMS that makes image sizes | The sizes are unsigned: `register` originals and sizes, monitor a served size |
| Cloudflare Images / Polish | Images → Transformations → "Preserve Content Credentials"; Polish strips them first |
| Fastly Image Optimizer | `metadata=c2pa` |
| Cloudinary | `fl_c2pa` |
| A web game, an app behind a login, an engine build (Unity, Godot, Phaser, asset bundles) | A crawl sees none of it: `register` the source art and the build output in CI (§6), and add the write-time check with `/assets/sync` (§5). Files packed into engine bundles carry no credential; the registered sources are the record |
| imgix, Vercel, Akamai, Shopify, any other CDN or image proxy | Not documented: carry before upload and add a monitor checkpoint on the URL it serves (§4) |

List every hit in the plan you show the user, with the fix next to it. A re-encode you did not
cover is where the credential is lost.

## 2. Secrets

Add to `.env.example` (empty values) and to the loader the project already uses. Never write a
real value into a tracked file, a log line, a test fixture or a CI file.

| Variable | Required | Use |
|---|---|---|
| `C2PA_API_KEY` | if the server, CI or scripts call the API | Bearer token. Server-side only — never in a browser bundle (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_` are wrong) |
| `C2PA_WEBHOOK_SECRET` | if webhooks | `whsec_` + standard base64 of 24–64 bytes. Generate it yourself in the secret store (`echo "whsec_$(openssl rand -base64 32)"`) and `apply` registers it; it is then never printed anywhere |
| `C2PA_API_BASE` | no | Defaults to `https://api.c2pa.design/v1` |
| `C2PA_PROJECT_ID` | no | Project for everything the CLI writes (assets, monitors, domains, hosted signatures). Wins over `project` in `c2pa.json`. Leave unset with a project-scoped key, or to use the name in `c2pa.json` (§4) |
| `C2PA_SIGN_CERT`, `C2PA_SIGN_KEY` | no | Own C2PA certificate chain and key (PEM, or `_FILE` paths) for `carry`; never sent anywhere |
| `C2PA_TSA_URL` | no | RFC 3161 timestamp for own-key carries |
| `C2PA_TELEMETRY` | no | `0` turns the anonymous error reports off |

**Getting the key.** Never ask the user to paste a key into the chat or a file in the repository.
Ask them to run `npx -y c2pa-check login` (add
`--ci github` or `--ci gitlab` to also store it as the repository's `C2PA_API_KEY` secret;
`--test` for a sandbox key, see §0 Test keys). It
prints a link and a code; they approve it in a browser as an owner or admin; the key is saved in
`~/.config/c2pa-check/credentials` and used whenever `C2PA_API_KEY` is unset. You cannot approve
the code yourself, and a Docker build or CI job cannot either: those read the secret.

**No key is never a build failure.** Without `C2PA_API_KEY`, `register`, `--register` and `apply`
print a warning, send nothing and exit `0`; `carry` signs with a local key and warns; checks are
local anyway. So the integration can be committed before the user has an account. Use
`doctor --require api_key` only where a missing key must stop the job.

Tell the user where the real values go (GitHub/GitLab CI variables, Kubernetes Secret, Vercel/Fly
env, a secret manager). Check `.gitignore` covers `.env`. A `c2pa_test_` key is optional, for
trying calls without spending the plan: it cannot sign, so never leave one in CI or production.

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
  "project": "Game client",
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
npx -y c2pa-check apply --ping          # webhooks (PUT by URL), monitors (by name), domains (by host)
npx -y c2pa-check apply --wait 600      # also wait up to 10 min for the domain proof
```

| Part | Behaviour |
|---|---|
| Webhook secret | Taken from `C2PA_WEBHOOK_SECRET`. Or `--secret-out <path>`: created owner-only on the first run, reused afterwards. Never printed. A changed secret is rotated in with a 24 h overlap. With neither, `apply` refuses to create an endpoint (exit `2`) and changes nothing |
| Domains | A new host prints its DNS TXT record and well-known file; `apply` rechecks the proof on every run. `--wait` polls every 15 s and exits `1` if still pending |
| Monitors | Each entry is the `MonitorWrite` body; an existing name is updated |
| Unknown keys | An error, not ignored: a typo cannot silently disable a gate |
| `project` | A name, 1–64 characters. Found or created on first use (`PUT /projects {"name"}`: `201` created, `200` existing, case-insensitive, safe to repeat), once per run; `register`, `--register`, `apply` and hosted `carry` then send its id. Needs an organization-wide key with the `monitors` scope |

`checks` are used by the CI gate (§7) and by `register` (§6). Every section is optional.

### Which project a write lands in

Applies to `/verifications`, `/assets`, `/assets/sync`, `/domains`, `/monitors`, `/sign` and
`/sign/certificate`. Nothing is stored outside a project.

| Key | `project_id` sent | Stored project |
|---|---|---|
| project-scoped | none, or the key's own | the key's project |
| project-scoped | another | refused, `403 project_mismatch` |
| organization-wide (or a dashboard session) | a project of the organization | that project |
| organization-wide | none | the organization's `Default` project |
| any | an archived project | refused, `409 project_archived` |

The CLI sends `C2PA_PROJECT_ID` when set, else the id of `project` from `c2pa.json`, else nothing
(the table decides). A project-scoped key also reads only its project: lists, the export and
coverage are limited to it and a single object of another project answers `404`. Register a file
from CI and track its domain under the same project: the crawl then finds the same asset instead
of creating a second one.

### Direct API calls

| Need | Calls |
|---|---|
| Verify a URL | `POST /verifications {"url", "metadata": {"order_id": "…"}}` → sync result |
| Verify a file the server holds | `POST /verifications {"upload": true, "filename", "content_type", "size_bytes"}` → `PUT` bytes to `upload.url` with `upload.headers` → `POST /verifications/{id}/complete` → webhook `verification.completed` or poll `GET /verifications/{id}` |
| Watch a pipeline | `POST /monitors {"name", "schedule": "hourly", "checkpoints": [{"name": "CDN", "url": "…", "expect": "present_trusted"}]}` |
| Crawl a site | `POST /domains {"host"}` → DNS `txt_record` or `file_token` at `file_url` → `POST /domains/{id}/verify`; recrawl `POST /domains/{id}/crawl` |
| Media on other hosts (`game.`, `app.`, `cdn.`) | One domain = one host, crawled from its own home page and sitemaps (40 pages); media is collected from any host those pages reference. `POST /domains {"host": "game.example.com"}` for each host that has pages: under a domain verified by DNS it returns `state: verified` with no new proof (a file proof covers one host). A host with no pages needs a sitemap, named in its `robots.txt` or at `/sitemap.xml`. `hint: "few_assets"` on a domain means the crawl read it and found fewer than 10 files: add hosts or `register` |
| Stop crawling a site | `POST /domains/{id}/pause` → `state: paused`: no new crawl or re-check starts and a running crawl stops before its next request; assets, history and the proof stay, no alerts. `POST /domains/{id}/resume` starts a crawl within a minute. Both are idempotent, `409` while `pending`. `DELETE /domains/{id}` stops tracking for good |
| One-off public scan | `POST /scans {"host"}` → poll `GET /scans/{id}` every 3 s |
| Register assets at runtime | `POST /assets/sync {"hashes"}` → `POST /assets` with only the unknown ones (body in §6). From a build or CI: `c2pa-check register` |
| Catch a file published around the pipeline (converted on a laptop, written straight to storage) | Where the service stores a file: sha256 of the bytes → `POST /assets/sync {"hashes": ["<sha256 hex>"]}` (≤ 5000 per call, no bytes sent). A hash in `unknown` was never registered: log it with your own row ID, or refuse the write until the file went through `carry` and `register`. Works without a public URL |
| Export the inventory | `GET /assets/export` (CSV; ends with `name`, `origin`, `origin_signer`) |
| Read the inventory | `GET /assets` → each item has `name` (file name, else the credential title) and, when hosted signing made it, `origin {kind: carry\|composite, source_signer, source_asset_id, created_at}`; `preview_url` only for files seen at a URL |
| Remove an asset | `DELETE /assets/{id}` → `204`; for trial outputs and mistakes. A file still on a crawled domain comes back as a new asset |
| Move, delete or mark many assets | `POST /assets/batch {"action": "move" \| "delete" \| "set_expects_credential", "ids": [≤ 500], "project_id", "expects_credential"}` → `{moved, merged, deleted, updated, skipped}`, one transaction. A moved asset whose bytes the target project already holds is merged into that row (`merged`). Ids that are unknown or outside the key's reach are `skipped`. Key needs the `monitors` scope |
| A file that cannot carry a credential (drawn by code, made from an unsigned source) | `"expect": "absent"` on its check in `c2pa.json`: `register` sends `expects_credential: false`. Or `PATCH /assets/{id} {"expects_credential": false}`, or the batch action. The asset leaves the coverage denominator and is counted in `unsigned_by_design`; a valid credential found on it later sets it back |
| Move a domain to another project | `PATCH /domains/{id} {"project_id"}`: the proof, state and history stay, and every asset live on the domain moves with it |
| A host that is already tracked | `POST /domains` answers `409 conflict` with `details {domain_id, project_id, project_name, project_archived}`: move that domain, or restore its project in the dashboard, instead of proving the host again |
| Does a carried file still lead to its signer | `result.origin {status: traced \| untraced \| none, signer_name, relationship, depth}`: `traced` when the file's own credential is valid and it, or an ingredient on its chain, is signed by a signer on the trust list. `credential.status` is unchanged by it. Each `ingredients[]` entry has its own `credential_status` and `signer_name`. `GET /assets` items carry `origin_status` and `origin_signer` |
| Source of a carried file | `result.source.category` follows the parent: a file carried or edited from an AI-generated original stays `ai-generated`, a composite with an AI component is `ai-composite`; `source.inherited: true` marks it |
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

A new endpoint is sent a signed `ping` the moment it is created, and `POST /webhooks/{id}/test`
(or `apply --ping`) sends another. Read the outcome from our side with `GET /webhooks`:

| `last_delivery` | Meaning |
|---|---|
| `status: delivered` | Your handler answered `2xx`: the firewall lets us in and the route exists |
| `status: failed`, `failure_reason: timeout \| dns \| tls \| connect \| network` | The request never reached the handler: firewall, WAF allow-list (`bot/ips.json`), DNS or certificate |
| `status: failed`, `failure_reason: http_status`, `response_code` | The handler answered outside `2xx`: wrong path, or the signature check refused it (secret mismatch) |
| `status: pending` | Queued or between retries; read again in a few seconds |

Confirm the `ping` arrives and verifies, and keep the
example's tests: valid signature, modified body, 10-minute-old timestamp, redelivery, signed but
unparseable body.

## 6. Generated and composite media

Pick by what the step does to the picture:

| Step | Do | Result |
|---|---|---|
| Re-encode, resize, compress, format change (PNG → WebP) | `c2pa-check carry --from src --to out` | Source is `parentOf`; same picture checked |
| Edit of one source (chroma-key removal, crop, retouch) | `c2pa-check carry --from src --to out --edited` | One call: the same picture is carried; a changed one is signed as an edit, source `parentOf`, `c2pa.opened` + `c2pa.edited`, status `composed`, exit `0` |
| Combine (atlas, sprite sheet, collage) | `c2pa-check carry --compose a.png b.png … --to atlas.webp` | A new work: `c2pa.created` (digital source type `composite`) + `c2pa.placed`; every source is a `componentOf` ingredient with its manifest kept |
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

For a pipeline like generate → chroma key → crop → atlas → WebP: sign at every step that changes
the picture and feed the signed file to the next step (`--edited` after the key and the crop,
`--compose` for the atlas, a plain `carry` to WebP), then register the final files. A step that
writes an unsigned file breaks the chain; never repair it by looking the original up by file name.

| Fact | Value |
|---|---|
| Weight | a credential adds about 6 KB plus the manifest store of each signed source (22 KB in a generator PNG we measured); weight budgets apply to the signed bytes |
| Rerun | write with `--out <shipped file>`: when that file already holds a valid credential from the same sources and shows the same pixels as `--to`, the answer is `skipped`, nothing is sent and no signature is spent. Delete the output to force a new signature |
| Local key → your key | an output signed with the local key is signed again on the next run once `C2PA_API_KEY` or your own certificate is set |
| Folder (`--from-dir`) | a derived file with no original (`unpaired`), several (`ambiguous`) or an original without a credential (`unsigned`) is passed over, exit `0`; `--strict` makes each of them exit `1` |
| Scripts that sign file by file | install once (`brew install c2pa-design/tap/c2pa-check`, the release binary, or a dev dependency) and call `c2pa-check`; `npx -y` costs 1–2 s per call |

### Register files

```bash
npx -y c2pa-check register 'public/**/*.{jpg,png,webp}' 'design/**/*.png'   # or no globs: the checks in c2pa.json
npx -y c2pa-check --register                                                # gate and register in one run
```

It checks each file locally, asks which sha256 hashes are unknown (`POST /assets/sync`, 5000 per
call) and sends only those (`POST /assets`, 500 per call), with retries. Bytes never leave the
machine. Needs `C2PA_API_KEY`; the project follows §4. Files of a check with `"expect": "absent"`
are registered with `expects_credential: false`. Exit `4` when the API call failed.

Calling the API yourself: `POST /assets` takes the **whole result object** of a check per item,
not just a hash (status, signer and fingerprints are read from it):

```json
{"items": [{"location": "public/hero.webp", "source": "skill", "result": { …one element's "result" from `c2pa-check --format json`… }}]}
```

Optional per item: `project_id` (§4) and `expects_credential: false` for a file that cannot carry
a credential.

| `source` | Send it when |
|---|---|
| `skill` | Files checked in a repository, a build or CI (what `register` sends) |
| `upload` | Files your server received from users |
| `track` | A file an agent hook reported right after writing it |
| `crawl`, `verifier`, `carry` | Written by c2pa.design itself; do not send |

## 7. CI gate

In CI pin the release you tested: `c2pa-check@<version>` (current release: §0). Release archives
ship `SHA256SUMS`; the npm package is published with provenance. With no target the command runs
every entry of `checks` in `c2pa.json` (§4) and names the one that failed.

| Per check | Meaning |
|---|---|
| `paths` | Globs. `public/**` in the examples is only an example: list every place shipped media lives (CDN uploads kept in the backend, generator sources in `design/`) |
| `baseline` | File of `path → status`. The build fails when a file that had a valid credential has lost it. Catches one lost file even at 0 % or 39 % coverage; prefer it to a percentage |
| `coverage` | Minimum share of covered files, for sets where a percentage is the goal |
| `coverage_metric` | What `coverage` counts: `trusted` (default: `valid_trusted`), `traced` (valid, and the chain reaches a signer on the trust list: use it for files signed by hosted `carry`) or `valid` (any intact credential). Flag for a single set: `--coverage-metric`. Reports name the metric next to the share |
| `expect` | `present`, `trusted` or `absent` for every file. Files of an `absent` check are outside every coverage denominator |
| `git_tracked` | Count only files git tracks, so a laptop and CI see the same set |

Create the baseline once and commit it; refresh it the same way after an intended change:

```bash
npx -y c2pa-check --update-baseline
```

One run can write several reports: the Nth `--output` takes the Nth `--format`
(`text|json|ndjson|junit`). The same options exist as flags for a single set:
`c2pa-check 'public/**/*.webp' --baseline c2pa-baseline.json --git-tracked`.

GitHub Actions:

```yaml
- uses: c2pa-design/c2pa-check-action@v1
  with:
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
    key: c2pa-check
    paths: [.npm/]
  script:
    - npx -y c2pa-check --format junit --output c2pa-check.xml --format json --output c2pa-check.json
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
    - npx -y c2pa-check register
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
          - npx -y c2pa-check --format junit --output test-results/c2pa-check.xml
  branches:
    main:
      - step:
          name: c2pa-register
          image: node:22-alpine
          script:
            - npx -y c2pa-check register
```

CircleCI:

```yaml
jobs:
  c2pa-check:
    docker: [{image: node:22-alpine}]
    steps:
      - checkout
      - restore_cache: {keys: [c2pa-check]}
      - run: npx -y c2pa-check --format junit --output test-results/c2pa-check.xml --register
      - save_cache: {key: c2pa-check, paths: [~/.npm]}
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
`npx -y c2pa-check https://cdn.example.com/hero.jpg --expect trusted`.

Exit codes: `0` pass, `1` expectation, coverage or baseline failed, `2` usage, `3` unreadable
asset, `4` network or API call failed, `5` carry refused.

**Docker.** Pass the key as a build secret, never `COPY` or `ARG`:

```dockerfile
RUN --mount=type=secret,id=c2pa_key,env=C2PA_API_KEY npx -y c2pa-check carry 'public/**/*.webp' --from-dir src/
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

1. `npx -y c2pa-check doctor --require api_key,webhook_secret` (list only what this
   integration uses): key type, organization, quota left, webhook secret format, Node version,
   skill version. `--require` turns a missing value into exit `1`, so the same line is a CI
   pre-flight. Fix anything that fails before going on.
2. One `POST /verifications` against
   `https://c2pa.design/samples/ai-signed.jpg`; print `credential.status`.
3. `npx -y c2pa-check apply --ping`, show the handler log line for the `ping`, then
   `GET /webhooks` and report `last_delivery.status` (§5). Both directions are now shown to the
   user in the dashboard under **Integration → Connection**: the `doctor` call in step 1 marks
   their side as connected, the delivered `ping` marks the webhook.
4. Run the CI command locally.
5. Give the user this checklist with each line marked done, not needed, or theirs to do. You
   cannot do the lines that live outside the repository; say so and name the place.

| # | On their side | Done when |
|---|---|---|
| 1 | `C2PA_API_KEY` (and `C2PA_WEBHOOK_SECRET`) in the secret store of every environment that runs the code: CI, server, workers | `doctor --require …` is `ok` there; `whoami` says `live key` |
| 2 | Egress to `api.c2pa.design:443` from pods and CI runners (§0 Network access) | `doctor` prints `ok network` from inside the pod and the job |
| 3 | WAF or firewall: UA `c2pa-design-bot` and the prefixes in `https://c2pa.design/bot/ips.json`, fetched, not hard-coded | `GET /webhooks` shows `last_delivery.status: delivered`; the domain shows no `last_error` |
| 4 | DNS TXT record or well-known file for each domain | `apply --wait` exits `0` |
| 5 | Every step from §1 that re-encodes media is followed by `carry` | The gate passes on the build output with `expect` or `baseline` |
| 6 | CDN or image proxy keeps the credential (its setting from §1), or files are carried before upload | A monitor checkpoint on the served URL, resized variant included, meets its `expect` |
| 7 | Baseline committed, the gate runs in CI on every merge request, `--register` on the main branch | A build that drops a credential fails and names the file |
| 8 | Webhook receiver deployed on every replica behind the same URL, events deduplicated in the shared store (§5) | `apply --ping` shows one handled `ping` |
| 9 | Someone receives the alerts: monitor `alert_channels` or the webhook reaches a channel people read | A test delivery is seen by a person |

Docs: https://c2pa.design/docs/agents · https://docs.c2pa.design
