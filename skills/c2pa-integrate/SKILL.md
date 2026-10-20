---
name: c2pa-integrate
description: Connect a codebase to c2pa.design in one pass — domain monitoring first, then API key in the CI secret store, c2pa.json, a CI gate that checks and registers media, carry after converters, and a signed webhook receiver if wanted, all with retries, backoff and idempotency. Use when the user asks to integrate, connect, set up or install c2pa.design, Content Credentials monitoring, C2PA verification, provenance webhooks or the c2pa-check CI gate in their project.
license: MIT OR Apache-2.0
metadata:
  homepage: https://c2pa.design/docs/agents
  openapi: https://docs.c2pa.design/openapi.yml
  version: "10"
---

# c2pa-integrate

| This skill does | This skill never does |
|---|---|
| Reads the repo and shows the user a plan before writing anything | Commits, pushes or deploys: every change stays in the working tree for the user to review |
| Adds `c2pa.json` (no secrets) and one CI step that checks and registers media | Installs anything on production servers |
| Has the user store `C2PA_API_KEY` in the CI secret store (`c2pa-check login`) | Asks for a key in the chat or writes one into a tracked file |
| Adds `carry` after image converters; a webhook receiver only if the user wants webhooks | Uploads media to register it: `register` sends hashes and check results. Only `carry` with a key sends files (hosted signing; deleted after the check) |
| Needs outbound HTTPS to `api.c2pa.design` from CI | Breaks a build for a missing key: without one, `register` and `apply` warn and exit `0` |

You are wiring the user's project to c2pa.design. Goal: a working integration in about five
minutes, nothing secret committed, every call safe to retry. Work in the order of this file, show
the user a short plan first, ask only for what you cannot find in the repo, and leave every
change uncommitted.

**Write no glue code.** The whole integration is one file and a few commands; a script that
batches, retries or lists-then-creates is a sign you missed a command. If one is truly missing,
tell the user to write to info@c2pa.design: it should become a command, not their script.

| Job | Command |
|---|---|
| Gate the build, several file sets with their own thresholds | `c2pa-check` (reads `c2pa.json`, §8) |
| Register files in the inventory | `c2pa-check register` or `--register` on the gate (§7) |
| Webhooks, monitors, domains | `c2pa-check apply` (§5) |
| Keep the chain through a conversion | `c2pa-check carry` (§7) |
| Get a key without the dashboard | `c2pa-check login` (the user approves a code in a browser) |
| Check the setup | `c2pa-check doctor --require api_key` |

The only code you write is the webhook receiver (§6), copied from an example.

**Always carry.** After you (or code you write) convert, resize, compress or re-encode any image,
video or audio file that had a Content Credential, run
`npx -y c2pa-check@0.5.0 carry --from <source> --to <output>` before shipping the output. Every
re-encode drops the manifest; `carry` writes a new one with the source as `parentOf` ingredient.
Exit `5` means it refused (`--json` gives `rule`: `different_picture`, `source_unsigned`,
`low_quality`, `not_comparable`, or the server's `carry_rejected` rule). A changed picture is not
a carry: add `--edited` when the step may change it (§7).

Never describe a result as real, fake or "AI detected". Report `credential.status`
(`absent | present_invalid | valid_untrusted | valid_trusted | error`) using the labels in
`https://c2pa.design/skills/c2pa-integrate/status-labels.json` (en, de, es, fr, ja, ko, ru, zh-CN,
pt-BR) so every integration shows the same words. For another language translate the `en` entries
and keep the five keys; send the result to info@c2pa.design to have it added. A missing
credential proves nothing about the file.

## 0. Facts

| What | Value |
|---|---|
| REST base | `https://api.c2pa.design/v1` |
| OpenAPI 3 (public) | `https://docs.c2pa.design/openapi.yml` — includes every webhook payload (`WebhookEvent*`, index `x-webhooks`) |
| Remote MCP | `https://api.c2pa.design/mcp` — protocol `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26` (negotiated). Without a key: `verify_url`, `inspect_manifest`, `ecosystem_lookup`, `trust_status` (20 calls/hour per IP); `check_pipeline` needs a key |
| Auth | `Authorization: Bearer c2pa_live_…` or `c2pa_test_…` |
| Keys | https://app.c2pa.design → your organization → **API keys** (`/o/<org>/keys`), or `c2pa-check login` (§3) |
| Check setup | `GET /whoami` → `key_type`, `organization`, `project {id, name, archived}` (project-scoped key only), `resolved_project {id, name, default}` (where a write without `project_id` lands), `plan`, `quota[{metric, used, limit, period_end}]`. Or `c2pa-check doctor`: prints `project <name>`, `(default)` for a key without a project, `FAIL` for an archived project, and says when this skill is out of date |
| Error envelope | `{"error":{"code":"…","message":"…","retryable":true,"details":{}}}` — branch on `code`/`retryable`, never `message` |
| Rejected key | `401 unauthorized` with `details.reason`: `revoked` (issue a new key), `unknown` (wrong key or environment), `malformed` (truncated or quoted in the secret store). `403 forbidden` for a missing scope carries `details.scope`. `doctor` prints both |
| Inventory coverage | `GET /assets/coverage?project_id=&domain_id=` → `{assets, unsigned_by_design, expected, valid, traced, trusted, coverage_pct, traced_pct, trusted_pct}` over tracked assets of the last 30 days. `expected` = `assets` − `unsigned_by_design`, the denominator of all three shares. `valid`: intact credential; `traced`: intact and the chain reaches a signer on the C2PA trust list; `trusted`: `valid_trusted`. This is the number the dashboard shows; `GET /coverage` is the series of `POST /verifications` calls only |
| Rate headers | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` |
| Public coverage | `GET /public/coverage/{host}`, no key, 600/hour per address, cacheable 5 min (`ETag`). Returns `{schema, host, name, verified_at, assets, unsigned_by_design, expected, valid, traced, trusted, coverage_pct, traced_pct, trusted_pct, declared_ai, sources{crawl,ci,api}, projects[], checked_at, recheck_minutes, stale, small_sample, trust_list_version}`, plus `signers[]` and `trend[]` when the owner shows them, for an organization that published its space under a verified domain (dashboard → **Public page**, owner only, off by default); `404 not_found` for an unknown or unpublished host. Badge: `/public/coverage/{host}/badge.svg`. Show `unsigned_by_design` next to any share, never word `traced` as "trusted", show no percentage when `small_sample`, say the checks are over seven days old when `stale`. Counts cover registered assets only: never present them as a statement about a whole product |
| Public catalog | `GET /public/catalog` (no key, 600/hour): organizations c2pa.design listed with their written permission, each the coverage document plus `description` and `listed_at`. For a listed host, `GET /public/coverage/{host}/assets` returns up to 300 files `{location, status, signer_name, generator, source_category, claim, actions[], ingredients[], first_seen, last_seen, checked_at}` and `truncated`; `404` for any host not listed. Being listed is arranged by email (info@c2pa.design), not by API |
| CLI | `c2pa-check`, current release 0.5.0 (every command here runs on it), Node ≥ 18, `SHA256SUMS` + provenance attestation on every GitHub release. Linux builds are static (musl): Alpine and distroless work. Pin it once in CI (§8) |
| Error reports | When a command ends with an error (exit 2–4 or a crash; never exit 1 or 5) `c2pa-check` sends `{version, os, arch, command, exit_code, code, mime, ci}` to `POST /cli-reports` from a detached process and prints what it sends. No file names, paths, URLs, hashes or keys. Off with `C2PA_TELEMETRY=0`, `DO_NOT_TRACK=1` or `--offline` |
| Crawler | UA `c2pa-design-bot/1.0`, honours robots.txt, 1 request/s per host, from the prefixes in `https://c2pa.design/bot/ips.json` |
| Carry signer | own key (`C2PA_SIGN_CERT`/`C2PA_SIGN_KEY`) → `C2PA_API_KEY` ("<verified domain> via c2pa.design", `signatures` quota) → local key with a warning; c2pa.design vouches for the account, never for the content |

### What each status means for the user's own files

| Result | Typical file | Meaning |
|---|---|---|
| `valid_trusted` | straight from OpenAI, Adobe, a signing camera | Intact, signer on the C2PA trust list |
| `valid_untrusted` with `origin.status: traced` | carried or composed by hosted signing ("example.com via c2pa.design") | **Expected, not a failure.** The c2pa.design signing CA is not on the C2PA trust list, so the file itself is `valid_untrusted`; `traced` says its chain reaches a listed signer. Gate these sets with `coverage_metric: traced` |
| `valid_untrusted`, `untraced` | own CA, or the local-key fallback | Intact, signer not listed. A local-key file has a per-machine signer: fix the key and re-run (§7) |
| `present_invalid` | edited after signing without `carry` | The bytes changed after the signature |
| `absent` | most files on the internet | No credential. Proves nothing |

`result.origin {status: traced | untraced | none, signer_name, relationship, depth}` never changes
`credential.status`; `GET /assets` items carry `origin_status` and `origin_signer`.

### Live and test keys

Use a **live** key (`c2pa_live_…`) in CI, on servers and wherever `carry` runs. A **test** key
(`c2pa_test_…`) is for trying calls: everything runs for real, usage goes to a sandbox allowance,
and it cannot sign, so `carry` with a test key falls back to a local key. Never leave one in CI
or production; `doctor` prints the key type.

| With a test key | Behaviour |
|---|---|
| `POST /verifications` | Real result; sandbox cap 1000 per period |
| `/webhooks` (create, test, rotate, enable) | Same as live; real signed deliveries |
| `POST /domains` | 1 sandbox domain, at most 50 assets per crawl |
| `POST /monitors` | 2 sandbox monitors, hourly or slower; checkpoint checks use the same 1000 |
| `POST /assets`, `/assets/sync` | Same as live |
| `POST /sign`, `/sign/certificate` | `403 forbidden` |

Over a sandbox cap: `402 usage_limit_exceeded` with `details.sandbox: true`.

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

The same limits are `maxItems`/`maxLength`/`maxProperties` in the OpenAPI.

### Network access

Where outbound traffic is denied by default (Kubernetes `NetworkPolicy`, an egress gateway, a
corporate proxy, a locked-down runner), allow HTTPS to `api.c2pa.design`, or API calls, hosted
signing and `register` time out (exit `4`; `carry` falls back to a local key with a warning).

| From | To | Needed for |
|---|---|---|
| Server pods, workers | `api.c2pa.design:443` | Every API call |
| CI runners, build containers | `api.c2pa.design:443` | `carry` with a key, `register`, `apply`, `doctor`, error reports |
| CI runners | `registry.npmjs.org:443` (or your mirror) | `npx c2pa-check@…`; not needed with the release binary |
| c2pa.design → your ingress | prefixes in `https://c2pa.design/bot/ips.json` | Webhook deliveries, domain crawls |

The API sits behind a CDN whose addresses change: allow by host name. Cilium:

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
`NetworkPolicy` without FQDN support: route through the egress proxy and set `HTTPS_PROXY`.
Verify from inside the pod: `npx -y c2pa-check@0.5.0 doctor` → `ok network`.

## 1. Domain first: the read-only win

Start here. Verifying the user's domain needs no code and installs nothing, and it is the only
step that watches what is actually served. Without a verified domain nothing served is crawled,
`asset.lost` never fires for live URLs, and hosted composite signing is off.

1. The user signs in at https://app.c2pa.design and adds the domain, or you put it in
   `c2pa.json` (`"domains": ["example.com"]`, §5) and run `apply --wait 600` once a key exists.
2. They publish the DNS TXT record (or the well-known file) it prints.
3. **Done when** the dashboard shows the domain verified and the first crawl lists its assets
   (`apply --wait` exits `0`).

One domain is one host, crawled from its home page and sitemaps (40 pages); media is collected
from any host those pages reference. Add each host that has its own pages (`game.`, `app.`):
under a domain verified by DNS it needs no new proof (a file proof covers one host). A host with
no pages needs a sitemap in its `robots.txt` or at `/sitemap.xml`. `hint: "few_assets"` means
the crawl found fewer than 10 files: add hosts or `register` (§7). Behind a WAF, allow the UA
`c2pa-design-bot`; a blocked crawl shows as `last_error` on the domain.

Show the user this result before moving on: it is useful even if they stop here.

## 2. Detect the stack

Read the repo before writing anything:

- Server language and framework: `go.mod`, `package.json`, `pyproject.toml` / `requirements.txt`,
  `Gemfile`, `composer.json`, `pom.xml` / `build.gradle`, `*.csproj`, `Cargo.toml`.
- How config is loaded and where `.env.example` lives.
- CI: `.github/workflows`, `.gitlab-ci.yml`, `bitbucket-pipelines.yml`, `.circleci`.
- How many replicas the server runs and what shared store exists (Redis, Postgres) — §6 needs it.
- Where media lives and where it is produced: uploads, generator calls (OpenAI / Firefly /
  Gemini), build steps that change pictures (chroma key, crop, atlas, sprite sheets), and files
  drawn by code that can never carry a credential.
- What re-encodes or serves media. Each of these drops the credential unless handled:

| Found in the repo | Do |
|---|---|
| `sharp`, `libvips`, ImageMagick (`convert`, `magick`), Pillow, `cwebp`, `ffmpeg`, Squoosh in a script or build step | `carry` right after the step (§7); `--edited` when it crops or retouches |
| `next/image`, an image loader or optimizer plugin | `carry` at build time and serve the carried file (`unoptimized` for it), or a monitor checkpoint on the optimized URL |
| WordPress or another CMS that makes image sizes | The sizes are unsigned: `register` originals and sizes, monitor a served size |
| Cloudflare Images / Polish | Images → Transformations → "Preserve Content Credentials"; Polish strips them first |
| Fastly Image Optimizer | `metadata=c2pa` |
| Cloudinary | `fl_c2pa` |
| A web game, an app behind a login, an engine build (Unity, Godot, Phaser, asset bundles) | A crawl sees none of it: `register` the source art and the build output in CI (§7), plus the write-time check with `/assets/sync` (§5). Files packed into bundles carry no credential; the registered sources are the record |
| imgix, Vercel, Akamai, Shopify, any other CDN or image proxy | Not documented: carry before upload and add a monitor checkpoint on the served URL (§5) |

List every hit in the plan, with the fix next to it. A re-encode you did not cover is where the
credential is lost.

## 3. Secrets

Add the variables to `.env.example` (empty values) and to the loader the project already uses.
Never write a real value into a tracked file, a log line, a test fixture or a CI file. Check that
`.gitignore` covers `.env`.

| Secret | Read by | Lives in | Checked by |
|---|---|---|---|
| `C2PA_API_KEY` (live) | the CLI in CI and build containers; the server only if it calls the API (§4) | CI secret store; server secret store; on a workstation `~/.config/c2pa-check/credentials` (written by `login`) | `doctor --require api_key`: key type, organization, quota |
| `C2PA_WEBHOOK_SECRET` | the webhook receiver (verifies) **and** the job that runs `apply` (registers it) | server secret store and the deploy job's secrets: **the same value in both** | `doctor --require webhook_secret` checks the format; a delivered `ping` (§6) proves both sides match |
| `C2PA_SIGN_CERT`, `C2PA_SIGN_KEY` (optional) | `carry` with your own C2PA certificate (PEM, or `_FILE` paths); never sent anywhere | CI secret store | — |

`C2PA_API_KEY` is server-side only — never in a browser bundle (`NEXT_PUBLIC_`, `VITE_`,
`REACT_APP_` are wrong). `C2PA_WEBHOOK_SECRET` is `whsec_` + standard base64 of 24–64 bytes;
generate it in the secret store (`echo "whsec_$(openssl rand -base64 32)"`) and `apply` registers
it without printing it.

| Optional variable | Use |
|---|---|
| `C2PA_API_BASE` | Defaults to `https://api.c2pa.design/v1` |
| `C2PA_PROJECT_ID` | Project for everything the CLI writes. Wins over `project` in `c2pa.json`. Leave unset with a project-scoped key |
| `C2PA_TSA_URL` | RFC 3161 timestamp for own-key carries |
| `C2PA_TELEMETRY` | `0` turns error reports off |

**Getting the key.** Never ask the user to paste a key into the chat or a file in the repository.
Ask them to run `npx -y c2pa-check@0.5.0 login` (`--ci github` or `--ci gitlab` also stores it as
the repository's `C2PA_API_KEY` secret through `gh` or `glab`; `--test` for a test key). It prints
a link and a code; an owner or admin approves it in a browser; the key is saved to
`~/.config/c2pa-check/credentials` and used whenever `C2PA_API_KEY` is unset. You cannot approve
the code yourself, and a Docker build or CI job cannot either: those read the secret.

**People who check pages by hand** use the browser extension: its side panel's **Connect** runs
the same device login and gets a key with the `verify` and `read` scopes only.

**No key is never a build failure.** Without `C2PA_API_KEY`, `register`, `--register` and `apply`
warn, send nothing and exit `0`; `carry` signs with a local key and warns; checks are local
anyway. The integration can be committed before the user has an account. Use
`doctor --require api_key` only where a missing key must stop the job.

## 4. API client — only if the server calls the API

| The project's server… | Do |
|---|---|
| verifies user uploads or URLs at runtime, registers assets at runtime, manages monitors from code | Generate a client (below) |
| only receives webhooks; the key is used by CI and build scripts | **No client.** Webhook receiver (§6) + CLI (§8). A client would be dead code |

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
   monitors, domains, checkpoints) are also `402`, without `period_end`. A new organization runs
   on Autopilot limits for its first 7 days, then on its plan's limits.
5. **Idempotency.** See the table; send `Idempotency-Key: <uuid or stable hash of the input>`
   where supported.
6. **Proactive slow-down.** When `X-RateLimit-Remaining` is 0, wait before the next call.
7. **Logging.** Method, path, status, `error.code`, attempt. Never the key.
8. **Results are not errors.** `200` with `credential.status: "absent"` is a successful check.

| Call | Idempotency |
|---|---|
| `POST /verifications` | `Idempotency-Key` (API keys). Same key returns the first verification while it exists; two concurrent first requests: the loser gets `409 idempotency_conflict`, retry it. Fresh key for a different body |
| `POST /assets`, `/assets/sync` | Naturally idempotent per location + hash |
| `PUT /webhooks` | Idempotent by `url`: creates, or updates `events` (and rotates in a different `secret`) |
| `POST /webhooks`, `/monitors`, `/domains` | Not idempotent (`/domains` answers `409` for a known host). Use `c2pa-check apply` |
| `POST /sign` | Not idempotent; each call is a new signature |

## 5. Account setup: `c2pa.json` + `apply`

Declare what the account should have in `c2pa.json` at the repo root (commit it; it holds no
secret) and run `apply` from the deploy job. It is safe on every deploy and deletes nothing.

```json
{
  "project": "Game client",
  "domains": ["example.com"],
  "checks": [
    { "name": "shipped", "paths": ["public/**/*.{jpg,png,webp}"], "baseline": "c2pa-baseline.json" },
    { "name": "sources", "paths": ["design/**/*.png"], "coverage": 39, "git_tracked": true },
    { "name": "drawn", "paths": ["public/generated/**/*.png"], "expect": "absent" }
  ],
  "monitors": [
    { "name": "CDN", "schedule": "hourly", "checkpoints": [{ "name": "hero", "url": "https://cdn.example.com/hero.jpg", "expect": "present_trusted" }] }
  ],
  "webhooks": [
    { "url": "https://<host>/webhooks/c2pa", "events": ["monitor.regression", "asset.lost", "asset.stripped_copy_seen", "usage.threshold"] }
  ]
}
```

```bash
npx -y c2pa-check@0.5.0 apply --ping          # webhooks (PUT by URL), monitors (by name), domains (by host)
npx -y c2pa-check@0.5.0 apply --wait 600      # also wait up to 10 min for the domain proof
```

| Part | Behaviour |
|---|---|
| `project` | A name, 1–64 characters, one per repository so repos do not mix in `Default`. Found or created on first use (`PUT /projects {"name"}`: `201` created, `200` existing, case-insensitive), once per run; `register`, `--register`, `apply` and hosted `carry` send its id. Needs an organization-wide key with the `monitors` scope |
| Domains | A new host prints its DNS TXT record and well-known file; `apply` rechecks the proof on every run. `--wait` polls every 15 s and exits `1` if still pending |
| Monitors | Each entry is the `MonitorWrite` body; an existing name is updated |
| Webhook secret | From `C2PA_WEBHOOK_SECRET`, or `--secret-out <path>` (created owner-only on the first run, reused afterwards). Never printed. A changed secret is rotated in with a 24 h overlap. With neither, `apply` refuses to create an endpoint (exit `2`) |
| Unknown keys | An error, not ignored: a typo cannot silently disable a gate |

`checks` are used by the CI gate (§8) and by `register` (§7). Every section is optional.

### Which project a write lands in

Applies to `/verifications`, `/assets`, `/assets/sync`, `/domains`, `/monitors`, `/sign` and
`/sign/certificate`. Nothing is stored outside a project.

| Key | `project_id` sent | Stored project |
|---|---|---|
| project-scoped | none, or the key's own | the key's project |
| project-scoped | another | refused, `403 project_mismatch` (`details.project_id` is the key's) |
| organization-wide (or a dashboard session) | a project of the organization | that project |
| organization-wide | none | the organization's `Default` project |
| any | an archived project | refused, `409 project_archived` (`403` on every call but `GET /whoami` for a key scoped to it) |

The CLI sends `C2PA_PROJECT_ID` when set, else the id of `project` from `c2pa.json`, else nothing.
A project-scoped key reads only its project; another project's object answers `404`. Register
files from CI and track the domain under the same project, so a crawl finds the same asset
instead of creating a second one.

### Direct API calls

| Need | Calls |
|---|---|
| Verify a URL | `POST /verifications {"url", "metadata": {"order_id": "…"}}` → sync result |
| Verify a file the server holds | `POST /verifications {"upload": true, "filename", "content_type", "size_bytes"}` → `PUT` bytes to `upload.url` with `upload.headers` → `POST /verifications/{id}/complete` → webhook `verification.completed` or poll `GET /verifications/{id}` |
| Watch a pipeline | `POST /monitors {"name", "schedule": "hourly", "checkpoints": [{"name": "CDN", "url": "…", "expect": "present_trusted"}]}` |
| Crawl a site | `POST /domains {"host"}` → DNS `txt_record` or `file_token` at `file_url` → `POST /domains/{id}/verify`; recrawl `POST /domains/{id}/crawl` |
| Pause or stop a crawl | `POST /domains/{id}/pause` (`state: paused`, history and proof kept, no alerts) and `/resume` (a crawl starts within a minute); both idempotent, `409` while `pending`. `DELETE /domains/{id}` stops for good |
| Move a domain | `PATCH /domains/{id} {"project_id"}`: proof, state, history and live assets move with it. `409 conflict` on `POST /domains` for a tracked host carries `details {domain_id, project_id, project_name, project_archived}`: move or restore that one instead of proving the host again |
| One-off public scan | `POST /scans {"host"}` → poll `GET /scans/{id}` every 3 s; or add `"email"` (and `"locale"`) for one mail when it ends. At most 10 scan mails per address a day; each has a stop link with a confirm button |
| Catch a file published around the pipeline | Where the service stores a file: sha256 → `POST /assets/sync {"hashes": [...]}` (no bytes sent). A hash in `unknown` was never registered: log it with your row ID, or refuse the write until it went through `carry` and `register` |
| Read or export the inventory | `GET /assets` (each item: `name`, and `origin {kind: carry\|composite, source_signer, source_asset_id, created_at}` when hosted signing made it; `preview_url` for files seen at a URL); `GET /assets/export` (CSV) |
| Remove, move or mark assets | `DELETE /assets/{id}` → `204` (a file still on a crawled domain comes back). `POST /assets/batch {"action": "move" \| "delete" \| "set_expects_credential", "ids": [≤ 500], "project_id", "expects_credential"}` → `{moved, merged, deleted, updated, skipped}`, one transaction; needs the `monitors` scope |
| A file that cannot carry a credential | `"expect": "absent"` on its check (`register` sends `expects_credential: false`), or `PATCH /assets/{id} {"expects_credential": false}`. It leaves the coverage denominator and counts in `unsigned_by_design`; a valid credential found later sets it back |
| One field the pipeline acts on | The owner picks a policy in the dashboard (**Projects → Policy**). Every verification, URL check and `verification.completed` in that project then has `decision {value: allow \| review \| block, policy_id, policy_version, reasons[]}`; branch on `decision.value`, log `reasons`. No policy → no `decision` (keep your own mapping of `credential.status`) |
| Source of a carried file | `result.source.category` follows the parent: carried from an AI-generated original stays `ai-generated`, a composite with an AI component is `ai-composite`; `source.inherited: true` marks it |

Attach `metadata` with the project's own IDs so webhooks map back to rows.

## 6. Webhooks (optional)

### Events and what produces them

An event fires only when something produces it. Subscribe only to events whose producer exists in
this integration: an event with no producer is silence, not a clean record.

| Event | Produced by |
|---|---|
| `ping` | Creating the endpoint, `POST /webhooks/{id}/test`, `apply --ping` |
| `usage.threshold` | Usage crossing 50 %, 80 %, 100 % of a quota (once each per period) |
| `verification.completed` | `POST /verifications` (async uploads; sync URL checks answer inline and fire it too) |
| `monitor.run.completed`, `monitor.regression` | A monitor (§5). Without one, never |
| `asset.lost` | A verified domain (§1) or registered assets (§7) |
| `asset.stripped_copy_seen` | Registered assets |
| `digest.ready` | A domain or registered assets (weekly) |
| `evidence_pack.ready` | A plan with `evidence_pack` (1st of the month) |

**Who reads the alerts.** A handler that only logs reaches no human unless log alerting exists.
For a team without on-call, set the monitor's `alert_channels` or the dashboard's email or Slack
alerts instead of, or next to, a webhook.

### Receiver

Complete receivers with tests (Go, Node, Python):
https://github.com/c2pa-design/skills/tree/HEAD/examples/webhook-receiver. Adapt one; their
shared `vectors.json` covers a plain delivery, a rotation (two signatures) and a stale timestamp.

Register the endpoint with `apply` (§5). By hand: `PUT /webhooks {"url", "events", "secret"}`
(`201` created, `200` existing; without `secret` one is generated and returned once, on `201`
only). The handler runs these steps **in this order**:

1. **Raw body.** Read the bytes before any JSON middleware.
2. **Signature.** Headers `webhook-id`, `webhook-timestamp`, `webhook-signature`. Reject
   `|now - timestamp| > 300 s`. Key = standard-base64 decode of the secret without `whsec_` (a
   secret that does not decode is a configuration error — fail at startup). Compute
   `base64(HMAC-SHA256(key, "{id}.{timestamp}.{body}"))` and compare in constant time against
   every space-separated `v1,<sig>` in the header; accept if any matches. Any `standardwebhooks`
   library does this.
3. **Parse.** Unparseable or missing `type` → `400`. Do this **before** step 4, or a bad body
   burns its `webhook-id` and the redelivery is lost.
4. **Deduplicate on `webhook-id`** in a store **shared by all replicas**: Redis
   `SET webhook:<id> 1 NX EX 86400`, or a unique index on a deliveries table. A process-memory
   cache does not work with more than one replica. Already seen →
   `2xx` without processing.
5. **Enqueue and answer `2xx` within 10 s.** If enqueueing fails, delete the dedupe key and
   answer `5xx` so the retry is processed.
6. **Branch on `type`**; ignore unknown types with `2xx`.

Envelope: `{"id", "type", "created_at", "occurred_at", "data"}`. Payload schemas for every type
are in the OpenAPI (`WebhookEvent*`); generate types from them.

| Guarantee | Value |
|---|---|
| Delivery | At least once; six attempts over ~6 h; 10 s timeout |
| `webhook-id` | One per delivery to your endpoint, identical on every retry. Envelope `id` is the event id |
| Order | Not guaranteed. Use `occurred_at` to drop stale events |
| `ping` | Signed exactly like other events; deduplicate it like any other |
| Disabling | 20 consecutive failures disable the endpoint and email the owners. `POST /webhooks/{id}/enable` re-enables it |
| Source IP | The prefixes in `https://c2pa.design/bot/ips.json`; allow them by fetching the list. An allowed IP is not proof: always verify the signature |
| Rotation | `POST /webhooks/{id}/rotate-secret` returns the new secret once; the old one keeps signing for 24 h, both signatures are sent meanwhile |

**Personal data in payloads.** Fields marked `x-echoes-customer-metadata` echo the customer's
`metadata`; `asset.*` `location` is the URL as found (query string included); `monitor.regression`
contains checkpoint names; signed URLs (`x-signed-url`) appear only in `evidence_pack.ready` and
expire after 7 days. No payload holds an IP. Log `webhook-id` and `type`; log `data` only if your
metadata is not personal. c2pa.design keeps sent payloads 30 days:
https://c2pa.design/legal/privacy.

### Prove it: the ping is part of setup

Run `apply --ping` (or `POST /webhooks/{id}/test`), show the handler's log line for the `ping`,
then read `GET /webhooks`. The webhook step is **done only when** `last_delivery.status` is
`delivered`; the first real alert must not be the first delivery.

| `last_delivery` | Meaning |
|---|---|
| `status: delivered` | Your handler answered `2xx`: firewall, route and secret are right |
| `status: failed`, `failure_reason: timeout \| dns \| tls \| connect \| network` | The request never reached the handler: firewall, WAF allow-list (`bot/ips.json`), DNS or certificate |
| `status: failed`, `failure_reason: http_status`, `response_code` | The handler answered outside `2xx`: wrong path, or the signature check refused it (secret mismatch between receiver and `apply`) |
| `status: pending` | Queued or between retries; read again in a few seconds |

Keep the example's tests: valid signature, modified body, 10-minute-old timestamp, redelivery,
signed but unparseable body.

## 7. Generated and composite media

| Step | Do | Result |
|---|---|---|
| Re-encode, resize, compress, format change (PNG → WebP) | `c2pa-check carry --from src --to out` | Source is `parentOf`; same picture checked |
| Edit of one source (chroma key, crop, retouch) | `c2pa-check carry --from src --to out --edited` | A same picture is carried; a changed one is signed as an edit (`c2pa.opened` + `c2pa.edited`, status `composed`, exit `0`) |
| Combine (atlas, sprite sheet, collage) | `c2pa-check carry --compose a.png b.png … --to atlas.webp` | A new work: `c2pa.created` (digital source type `composite`) + `c2pa.placed`; every source is a `componentOf` ingredient with its manifest kept |
| No credential wanted on the output, or sources unsigned | `c2pa-check register` on the sources **and** the output | Inventory and stripped-copy matching only |

With `C2PA_API_KEY`, c2pa.design signs a composite as "<verified domain> via c2pa.design" when:

| Hosted composite rule | Otherwise |
|---|---|
| The organization has a verified domain (§1) | local key + warning `signing_disabled`; not a failure |
| Every source is `componentOf` (one `parentOf` with `--edited`) | exit `5`, `ingredient_mismatch` |
| Every credential a source carries validates | exit `5`, `component_invalid` |
| At least one source carries a credential | exit `5`, `component_unsigned` |

Unsigned sources may be mixed in; sources travel inside the composite as ingredients. Tell the
user what the signature means: their account states the file was composed from these sources;
c2pa.design checked the sources' credentials, not the pixels. Register the output too: the
sources' hashes do not cover an output that differs from them.

For generate → chroma key → crop → atlas → WebP: sign at every step that changes the picture and
feed the signed file to the next (`--edited` after the key and the crop, `--compose` for the
atlas, a plain `carry` to WebP), then register the final files. A step that writes an unsigned
file breaks the chain; never repair it by looking the original up by file name.

| Fact | Value |
|---|---|
| Size | A carried file grows by about **27 KB** in our measurement: the new manifest plus the source's manifest store kept as its ingredient. Page-weight budgets apply to the signed bytes: re-check them after the first carry |
| Rerun | `--out <shipped file>`: when it already holds a valid credential from the same sources with the same pixels as `--to`, the answer is `skipped` and no signature is spent. Delete the output to force a new signature |
| Local-key fallback | No key, a test key or a spent `signatures` quota → signed with a local key and a stderr warning; in `--json` the `signer` is not "<your domain> via c2pa.design". Fix the key and re-run: those files are signed again |
| Folder (`--from-dir`) | A derived file with no original (`unpaired`), several (`ambiguous`) or an unsigned original (`unsigned`) is passed over, exit `0`; `--strict` makes each exit `1` |
| Scripts that sign file by file | Install once (`brew install c2pa-design/tap/c2pa-check`, the release binary, or a pinned dev dependency); `npx -y` costs 1–2 s per call |

**Producer runs and the baseline go together.** Any change that runs a generator, `carry` or
`--compose` and adds or re-signs files also refreshes the baseline (`--update-baseline`, §8) and
registers the files, in the same change. A signed file missing from the baseline is not protected.

### Register files

```bash
npx -y c2pa-check@0.5.0 register 'public/**/*.{jpg,png,webp}' 'design/**/*.png'   # or no globs: the checks in c2pa.json
npx -y c2pa-check@0.5.0 --register                                                # gate and register in one run
```

It checks each file locally, asks which sha256 hashes are unknown (`POST /assets/sync`) and sends
only those (`POST /assets`), with retries. Bytes never leave the machine. Files of a check with
`"expect": "absent"` are registered with `expects_credential: false`. Exit `4` when the API call
failed.

Calling the API yourself: `POST /assets` takes the **whole result object** of a check per item:

```json
{"items": [{"location": "public/hero.webp", "source": "skill", "result": { …one element's "result" from `c2pa-check --format json`… }}]}
```

Optional per item: `project_id` (§5) and `expects_credential: false`. `source`: `skill` (files in
a repository, build or CI; what `register` sends), `upload` (files users sent your server),
`track` (an agent hook right after writing a file). `crawl`, `verifier` and `carry` are written by
c2pa.design; do not send them.

## 8. CI gate

Pin the CLI **once**: one variable, `C2PA_CHECK_VERSION`, referenced by every `npx` line and the
cache key. With no target the command runs every entry of `checks` in `c2pa.json` (§5) and names
the one that failed.

| Per check | Meaning |
|---|---|
| `paths` | Globs. List every place shipped media lives (CDN uploads kept in the backend, generator sources in `design/`), not only `public/**` |
| `baseline` | File of `path → status`. Fails when a file that had a valid credential lost it, even at 0 % coverage; prefer it to a percentage |
| `coverage` | Minimum share of covered files, for sets where a percentage is the goal |
| `coverage_metric` | `trusted` (default), `traced` (use it for files signed by hosted `carry`, §0) or `valid` |
| `expect` | `present`, `trusted` or `absent` for every file. `absent` files are outside every denominator |
| `git_tracked` | Count only files in the git index, so a laptop and CI see the same set: commit deletions |

Starting numbers: `--update-baseline` on day one, so nothing fails until a signed file loses its
credential, and commit the baseline. Add `coverage` at today's share for sets that should grow.
**The floor only moves up:** when a change signs more files, raise `coverage` to the new share in
the same change; never lower it to make a build pass — find the file that lost its credential.
100 only once every shipped file is carried, composed or marked `"expect": "absent"`.

```bash
npx -y c2pa-check@0.5.0 --update-baseline
```

One run can write several reports: the Nth `--output` takes the Nth `--format`
(`text|json|ndjson|junit`). Flags exist for a single set:
`c2pa-check 'public/**/*.webp' --baseline c2pa-baseline.json --git-tracked`.

GitHub Actions (the tag is the version; keep it equal to `C2PA_CHECK_VERSION` elsewhere):

```yaml
- uses: c2pa-design/c2pa-check/action@v0.5.0
  with:
    format: junit
    output: c2pa-check.xml
    register: ${{ github.ref == 'refs/heads/main' }}
  env:
    C2PA_API_KEY: ${{ secrets.C2PA_API_KEY }}
```

GitLab CI:

```yaml
variables:
  C2PA_CHECK_VERSION: "0.5.0"

.c2pa:
  image: node:22-alpine
  variables:
    npm_config_cache: "$CI_PROJECT_DIR/.npm"
  cache:
    key: c2pa-check-$C2PA_CHECK_VERSION
    paths: [.npm/]

c2pa-check:
  extends: .c2pa
  script:
    - npx -y c2pa-check@$C2PA_CHECK_VERSION --format junit --output c2pa-check.xml --format json --output c2pa-check.json
  artifacts:
    when: always
    reports:
      junit: c2pa-check.xml
  rules:
    - changes: &c2pa-changes ["public/**/*", "design/**/*.png", "c2pa.json", "c2pa-baseline.json", ".gitlab-ci.yml"]

c2pa-register:
  extends: .c2pa
  needs: []
  allow_failure: true
  script:
    - npx -y c2pa-check@$C2PA_CHECK_VERSION register
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $C2PA_API_KEY'
      changes: *c2pa-changes
```

Bitbucket Pipelines (set `C2PA_CHECK_VERSION` = `0.5.0` once under Repository variables):

```yaml
pipelines:
  default:
    - step:
        name: c2pa-check
        image: node:22-alpine
        caches: [node]
        condition: { changesets: { includePaths: ["public/**", "design/**", "c2pa.json", "c2pa-baseline.json"] } }
        script:
          - npx -y c2pa-check@$C2PA_CHECK_VERSION --format junit --output test-results/c2pa-check.xml
  branches:
    main:
      - step:
          name: c2pa-register
          image: node:22-alpine
          script:
            - npx -y c2pa-check@$C2PA_CHECK_VERSION register
```

CircleCI:

```yaml
parameters:
  c2pa-check-version: { type: string, default: "0.5.0" }

jobs:
  c2pa-check:
    docker: [{image: node:22-alpine}]
    steps:
      - checkout
      - restore_cache: {keys: ['c2pa-check-<< pipeline.parameters.c2pa-check-version >>']}
      - run: npx -y c2pa-check@<< pipeline.parameters.c2pa-check-version >> --format junit --output test-results/c2pa-check.xml --register
      - save_cache: {key: 'c2pa-check-<< pipeline.parameters.c2pa-check-version >>', paths: [~/.npm]}
      - store_test_results: {path: test-results}
```

Run the gate only when media, `c2pa.json` or the CI file changed; the register job runs on the
default branch only and must not block the build. Without `c2pa.json` every example works with a
glob and flags (`'public/**/*.{jpg,png,webp}' --coverage 80`).

Post-deploy, check what the CDN serves:
`npx -y c2pa-check@$C2PA_CHECK_VERSION https://cdn.example.com/hero.jpg --expect trusted`.

Exit codes: `0` pass, `1` expectation, coverage or baseline failed, `2` usage, `3` unreadable
asset, `4` network or API call failed, `5` carry refused.

**Docker.** Pass the key as a build secret, never `COPY` or `ARG`:

```dockerfile
ARG C2PA_CHECK_VERSION=0.5.0
RUN --mount=type=secret,id=c2pa_key,env=C2PA_API_KEY npx -y c2pa-check@${C2PA_CHECK_VERSION} carry 'public/**/*.webp' --from-dir src/
```

BuildKit reuses an unchanged layer with its old signatures; a changed source re-signs. For
byte-reproducible images sign before `docker build` and `COPY` the signed files.

### Upgrade

1. Read the release notes: https://github.com/c2pa-design/c2pa-check/releases.
2. Change `C2PA_CHECK_VERSION` (and the GitHub action tag `@vX.Y.Z`) in one commit; the cache key
   follows.
3. Run the gate locally on the new version. Refresh the baseline only if a status changed on
   purpose.
4. Update this skill: `npx skills add c2pa-design/skills --skill c2pa-integrate`. Its version is
   `metadata.version` at the top of this file; `doctor` prints it and says when a newer one is
   published.

## 9. Verify and hand over

1. `npx -y c2pa-check@0.5.0 doctor --require api_key,webhook_secret` (list only what this
   integration uses): key type, organization, quota left, webhook secret format, Node version,
   skill version. `--require` turns a missing value into exit `1`, so the same line is a CI
   pre-flight. Fix anything that fails before going on.
2. Run the block for the project's language (curl, TypeScript, Go, Python) from
   https://docs.c2pa.design/quickstart with the user's key; do not rewrite it. It must print
   `openai-signed.png valid_trusted` and `changed-after-signing.jpg present_invalid`; its `call`
   function is the retry rule of §4. One sample per `credential.status` at
   `https://c2pa.design/samples/<file>`: `openai-signed.png` (`valid_trusted`, `ai-generated`),
   `camera-capture.jpg` (`valid_untrusted`, `camera`), `ai-declared.jpg` (`valid_untrusted`,
   `ai-generated`), `changed-after-signing.jpg` (`present_invalid`), `stripped.jpg` (`absent`),
   `unsupported.bmp` (fails with `unsupported_media_type`, `error`); list at
   `https://c2pa.design/samples/samples.json`. Postman / Bruno collection:
   https://docs.c2pa.design/c2pa-design.postman_collection.json.
3. If webhooks are used: the ping of §6 is delivered. The dashboard's **Integration →
   Connection** then shows both directions: `doctor` marks their side, the `ping` the webhook.
4. Run the CI command locally.
5. Give the user this checklist with each line marked done, not needed, or theirs to do. You
   cannot do the lines that live outside the repository; say so and name the place.

| # | On their side | Done when |
|---|---|---|
| 1 | Domain added and its DNS record published (§1) | The dashboard shows it verified; `apply --wait` exits `0` |
| 2 | Live `C2PA_API_KEY` (and `C2PA_WEBHOOK_SECRET`) in the secret store of every environment that runs the code (§3) | `doctor --require …` is `ok` there; `whoami` says `live key` |
| 3 | Egress to `api.c2pa.design:443` from pods and CI runners (§0) | `doctor` prints `ok network` from inside the pod and the job |
| 4 | WAF or firewall: UA `c2pa-design-bot` and the prefixes in `bot/ips.json`, fetched, not hard-coded | The domain shows no `last_error`; `last_delivery.status: delivered` |
| 5 | Every re-encode from §2 is followed by `carry` | The gate passes on the build output with `expect` or `baseline` |
| 6 | CDN or image proxy keeps the credential, or files are carried before upload | A monitor checkpoint on the served URL, resized variant included, meets its `expect` |
| 7 | Baseline committed, the gate runs on every merge request, `--register` on the main branch | A build that drops a credential fails and names the file |
| 8 | Webhook receiver on every replica behind one URL, deduplicated in the shared store, subscribed only to events with a producer (§6) | `apply --ping` shows one handled `ping` |
| 9 | Someone receives the alerts: monitor `alert_channels`, dashboard email/Slack, or a webhook into a channel people read | A test delivery is seen by a person |

Nothing is committed: tell the user which files changed and that the diff is theirs to review.

## 10. Agent access (optional)

```bash
claude mcp add --transport http c2pa https://api.c2pa.design/mcp --header "Authorization: Bearer $C2PA_API_KEY"
npx skills add c2pa-design/skills
```

The header is optional: without a key the server answers the public tools at the anonymous rate.
If the MCP server does not connect, continue with REST and `c2pa-check`: everything the MCP tools
do is available there.

Docs: https://c2pa.design/docs/agents · https://docs.c2pa.design · contact info@c2pa.design
