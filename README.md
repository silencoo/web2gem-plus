# web2gem-plus

[English](README.md) | [简体中文](README.zh.md)

Lightweight Gemini Web gateway with OpenAI-compatible and Google-compatible APIs. Deploy the single Worker bundle to Cloudflare or run it with Docker, with optional API authentication and Gemini cookie-backed features.

The `main` branch supports either one Gemini cookie or a persistent round-robin cookie pool on Cloudflare Workers. No separate account-pool branch or management console is required.

[Credential modes](#credential-modes) · [Deploy to Cloudflare](#option-1-deploy-the-release-single-file-worker) · [Deploy with Docker](#option-2-deploy-with-docker) · [API examples](#api-surface)

## Contents

- [web2gem-plus](#web2gem-plus)
  - [Contents](#contents)
  - [Overview](#overview)
  - [Credential Modes](#credential-modes)
  - [Core Features](#core-features)
  - [Before You Start](#before-you-start)
  - [API Surface](#api-surface)
    - [Health](#health)
    - [OpenAI Chat Completions](#openai-chat-completions)
    - [OpenAI Responses](#openai-responses)
    - [OpenAI Images API](#openai-images-api)
    - [Google Gemini API](#google-gemini-api)
  - [Models](#models)
  - [Quick Start](#quick-start)
    - [Option 1: Deploy the release single-file Worker](#option-1-deploy-the-release-single-file-worker)
    - [Option 2: Deploy with Docker](#option-2-deploy-with-docker)
  - [Configuration](#configuration)
  - [Authentication](#authentication)
  - [Troubleshooting](#troubleshooting)
  - [Development](#development)
  - [Testing](#testing)
  - [Project Structure](#project-structure)
  - [Security Notice](#security-notice)
  - [Acknowledgements](#acknowledgements)
  - [License](#license)

## Overview

`web2gem-plus` lets OpenAI-compatible and Google Gemini-compatible clients use Gemini Web through a familiar HTTP API. Optional authenticated features can use one `GEMINI_COOKIE` or multiple accounts in `GEMINI_COOKIES`. On Cloudflare Workers, a Durable Object persists the round-robin cursor, account health, and refreshed cookie values across isolate cold starts.

It works well for personal deployments, simple proxies, and users who prefer a small stateless runtime. Cloudflare Workers can use `cloudflare:sockets` for upstream transport when regular `fetch` paths are rate-limited; Docker uses standard `fetch` by default.

The main compatibility targets are:

| Surface                             | Status    | Routes                                                                                               |
| ----------------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| OpenAI Chat Completions             | Supported | `POST /v1/chat/completions`                                                                          |
| OpenAI Responses                    | Supported | `POST /v1/responses`                                                                                 |
| OpenAI Models                       | Supported | `GET /v1/models`, `GET /v1/models/{id}`                                                              |
| Google Gemini generateContent       | Supported | `POST /v1beta/models/{model}:generateContent`, `POST /v1/models/{model}:generateContent`             |
| Google Gemini streamGenerateContent | Supported | `POST /v1beta/models/{model}:streamGenerateContent`, `POST /v1/models/{model}:streamGenerateContent` |
| Google Models                       | Supported | `GET /v1beta/models`, `GET /v1beta/models/{model}`                                                   |
| Health                              | Supported | `GET /`                                                                                              |

## Credential Modes

| Mode | Configuration | Behavior |
| --- | --- | --- |
| Single account | `GEMINI_COOKIE` and optional `SAPISID` | Backward-compatible setup. On Workers, refreshed state is persisted in the session-pool Durable Object. |
| Account pool | `GEMINI_COOKIES` | JSON array of cookie strings or cookie objects. Requests use round-robin selection, refresh authentication before failover, and cool rejected accounts temporarily instead of disabling them permanently. |

`GEMINI_COOKIES` takes precedence when both settings are present. Set `ADMIN_PASSWORD` to enable the redacted account-management WebUI at `/admin`.

## Core Features

| Feature                      | Description                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ready-to-use Flash models    | No authentication or configuration is required; deploy the single file to start using Flash models with no usage limits, completely free.       |
| Tool calling                 | Converts tool definitions into prompt instructions and parses DSML/XML-style tool-call output back into compatible API responses.               |
| Structured output            | Validates and canonicalizes final JSON for non-streaming structured responses; streaming structured output is rejected by default.              |
| Large context handling       | With `GEMINI_COOKIE` configured, large prompt context can be uploaded as Gemini text attachments instead of remaining entirely inline.           |
| Image generation             | Supports explicit OpenAI `image_generation` metadata for non-streaming Chat/Responses requests, plus `/v1/images/generations` and `/v1/images/edits`; a Gemini cookie is required. |
| Watermark removal            | Optional opt-in. Uses [GargantuaX](https://github.com/GargantuaX/gemini-watermark-remover) reverse-alpha blending on a **bottom-right corner crop** after the web full-size download path. **Default `remove_watermark: false`** (keeps the Gemini sparkle) so full-size ~2K downloads do not hit Workers CPU Error 1102. Pass `"remove_watermark": true` to scrub in-Worker, or scrub offline with GargantuaX / the browser extension. |
| Image input handling         | Resolves user-provided inline/base64 images through the Gemini provider path. The Worker does not fetch remote image or file URLs.                |
| Generic file attachments     | With a Gemini cookie, request-local `input_file` and inline non-image data can use Gemini Web upload references with arbitrary filenames and MIME types; persistent `/v1/files` storage is not implemented. |
| Worker and Docker deployment | Deploy the Worker bundle to Cloudflare Workers or self-host with Docker / Docker Compose. Workers persist session-pool state in a Durable Object. |
| Upstream socket transport    | Workers prefer `cloudflare:sockets` when available; Docker uses standard `fetch`.                                                                |

## Before You Start

Choose only the settings your deployment needs:

| Goal | Required setting |
| --- | --- |
| Try supported Flash routes | No Gemini secret is required. |
| Protect a shared endpoint | Set one or more `API_KEYS`. |
| Use real Pro routing | Set `GEMINI_COOKIE`; `SAPISID` is optional and can often be derived. |
| Generate or edit images | Set `GEMINI_COOKIE`. |
| Upload large prompt context as Gemini text attachments | Set `GEMINI_COOKIE`. |
| Run behind a custom forwarding origin | Set `GEMINI_ORIGIN`. |

Gemini Web is an upstream web protocol and may change without notice. This project is best suited to personal, research, and internal use.

## API Surface

### Health

```sh
curl https://your-web2gem-plus.example/
```

Returns service status, version, and the model IDs currently exposed by the adapter.

### OpenAI Chat Completions

```sh
curl https://your-web2gem-plus.example/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-flash",
    "messages": [
      { "role": "user", "content": "Write a concise project summary." }
    ]
  }'
```

Set `"stream": true` to receive Server-Sent Events.

For image generation, send explicit OpenAI image-generation metadata with a non-streaming request. The Worker routes requests with either `tool_choice: { "type": "image_generation" }` or a `tools[]` entry `{ "type": "image_generation" }` through a pass-through image path. This mode uses only user-authored prompt text plus user-provided inline/existing image inputs, rejects attachments-only prompts, and returns upstream text/images as data-image or URL markdown in Chat Completions. Remote image/file URLs are not fetched. `GEMINI_COOKIE` is required for image generation, image editing, and image byte fetching.

```sh
curl https://your-web2gem-plus.example/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-flash",
    "messages": [{ "role": "user", "content": "Generate a small blue app icon." }],
    "tool_choice": { "type": "image_generation" }
  }'
```

### OpenAI Responses

```sh
curl https://your-web2gem-plus.example/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-flash",
    "input": "Explain what this worker does in one paragraph."
  }'
```

Responses image generation uses the same explicit metadata and returns `image_generation_call` output items with base64 `result` values when image bytes are available; URL-only image metadata is passed through as markdown output text. Streaming image generation is not supported.

### OpenAI Images API

`POST /v1/images/generations` and `POST /v1/images/edits` are supported as non-streaming image-generation routes. They do not require `tools` or `tool_choice`, but they still require `GEMINI_COOKIE`.

```sh
curl https://your-web2gem-plus.example/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-flash",
    "prompt": "Generate a small blue app icon.",
    "response_format": "b64_json"
  }'
```

Image edits require `prompt` plus at least one local image input. JSON and multipart edit inputs can use `image`, `images`, `image_url`, or `input_image` with inline base64/data URL image bytes. Remote `http://` / `https://` image URLs are rejected and are not fetched by the Worker. Image endpoints support only `n: 1`, default `response_format` to `b64_json`, also accept `response_format: "url"` for provider URLs, and reject `stream: true`.

Optional image fields:

| Field | Default | Notes |
| --- | --- | --- |
| `remove_watermark` | `false` | When `true`, scrub Gemini corner sparkles after hydration. When omitted/`false`, return the full-size bytes as downloaded (watermark kept). Also accepted on Chat / Responses image-generation requests and multipart edits. |

Hydration prefers Gemini’s web full-size download chain (`c8o8Fe` + `=s0-d-I?alr=yes` / `/rd-gg/`), which is what yields multi‑MB ~2K assets. In-Worker watermark scrubbing is CPU-heavy and often exceeds the default Workers budget on those assets (Error 1102), so it is **off by default**. Pass `"remove_watermark": true` only when you want scrubbing, or remove the sparkle locally with [GargantuaX/gemini-watermark-remover](https://github.com/GargantuaX/gemini-watermark-remover). Paid Workers can raise `limits.cpu_ms` (up to 5 minutes) if you enable in-Worker scrubbing of larger assets.

```sh
curl https://your-web2gem-plus.example/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-flash",
    "prompt": "Generate a landscape photo.",
    "response_format": "b64_json",
    "remove_watermark": true
  }'
```

### Google Gemini API

```sh
curl https://your-web2gem-plus.example/v1beta/models/gemini-3.5-flash:generateContent \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{ "text": "Return a short deployment checklist." }]
      }
    ]
  }'
```

For streaming, call `:streamGenerateContent` on the same model path.

## Models

`web2gem-plus` exposes a fixed model map in `src/models/index.ts`.

| Model ID                         | Description                                                 |
| -------------------------------- | ----------------------------------------------------------- |
| `gemini-3.5-flash`               | Fast general-purpose model.                                 |
| `gemini-3.6-flash`               | Gemini 3.6 Flash — stronger agentic / coding Fast model.    |
| `gemini-3.5-flash-thinking`      | Deep thinking mode with longer output.                      |
| `gemini-3.1-pro`                 | Pro route; requires a valid Gemini cookie for real routing. |
| `gemini-3.1-pro-enhanced`        | Experimental enhanced Pro output mode.                      |
| `gemini-auto`                    | Gemini Web auto model selection.                            |
| `gemini-3.5-flash-thinking-lite` | Dynamic thinking with adaptive depth.                       |
| `gemini-flash-lite`              | Lightweight fast model.                                     |

You can override thinking depth per request by appending `@think=N` to a known model ID, for example `gemini-3.5-flash@think=0`. Supported override values are `0`, `1`, `2`, `3`, and `4`.

## Quick Start

Both deployment modes can run without secrets. Configure optional secrets only when you need authentication or cookie-backed Gemini Web features.

### Option 1: Deploy the release single-file Worker

Download the main-edition artifact `web2gem-plus-main-worker.js` from the [Releases](https://github.com/silencoo/web2gem-plus/releases) page, open your Cloudflare Worker in the dashboard, and replace the Worker source with the contents of that file. In the Worker dashboard settings, add the `nodejs_compat` compatibility flag.

![Cloudflare Worker settings showing nodejs_compat](./docs/images/cloudflare-worker-settings-nodejs-compat.png)

Each release publishes these assets:

| Asset | Use |
|-------|-----|
| `web2gem-plus-main-worker.js` | Main-edition single-file Cloudflare Worker bundle. |
| `web2gem-plus-main_<tag>_docker_linux_amd64.tar.gz` | Main-edition Docker image archive for `linux/amd64`. |
| `web2gem-plus-main_<tag>_docker_linux_arm64.tar.gz` | Main-edition Docker image archive for `linux/arm64`. |
| `sha256sums.txt` | Checksums for the released files. |

Secrets are optional. In the Worker dashboard, open the Worker settings and add variables/secrets only for the features you need. Set `API_KEYS` when you want to protect shared access, and set `GEMINI_COOKIE` when Pro routing, large-context text attachments, or signed-in Gemini Web behavior is needed.

![Cloudflare Worker settings showing secrets](./docs/images/cloudflare-worker-settings-secrets-GEMINI_COOKIE.png)

If you build from source instead of using a release artifact, `pnpm deploy` builds `dist/worker.js` and deploys it through the checked-in `wrangler.jsonc`.

### Option 2: Deploy with Docker

Use [`.env.example`](.env.example) as the environment template and [`compose.yaml`](compose.yaml) as the Compose service definition:

```sh
cp .env.example .env
docker compose up -d
```

On PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

The provided [`compose.yaml`](compose.yaml) pulls `ghcr.io/silencoo/web2gem-plus:latest` by default, maps `${PORT:-52389}:${PORT:-52389}`, and forwards the runtime variables from `.env`. Set `API_KEYS` in `.env` for shared deployments, and set `GEMINI_COOKIE` when Pro routing, image generation/editing, large-context text attachments, or other signed-in Gemini Web behavior is needed. To pin a specific image tag, set `WEB2GEM_PLUS_IMAGE=ghcr.io/silencoo/web2gem-plus:<tag>` in `.env`.

After the container starts, verify the local health route:

```sh
curl http://127.0.0.1:52389/
```

If you changed `PORT` in `.env`, use that host port instead. Docker deployments default `UPSTREAM_SOCKET` to `false` in [`.env.example`](.env.example) because `cloudflare:sockets` is only available in the Cloudflare Workers runtime. Other runtime variables are the same as the configuration variables listed below.

For one-off local testing without Compose, you can still build and run the image directly:

```sh
docker build -t web2gem-plus .
docker run --rm -p 52389:52389 --env-file .env web2gem-plus
```

Release pages also provide prebuilt Docker image archives. Download the archive matching your platform, load it, and run the tagged image:

```sh
gzip -dc web2gem-plus-main_<tag>_docker_linux_amd64.tar.gz | docker load
docker run --rm -p 52389:52389 --env-file .env web2gem-plus:<tag>
```

If the upstream Gemini Web path starts returning empty output, first check whether `GEMINI_BL` needs to be refreshed from the current Gemini Web frontend. If Cloudflare egress is rate-limited, set `GEMINI_ORIGIN` to your own forwarding service or proxy endpoint.

## Configuration

Configuration defaults live in `src/config/index.ts`. Cloudflare Worker environment variables / secrets and Docker environment variables override those defaults at runtime.

| Variable                        | Default                     | Description                                                                                                                                                                                                      |
| ------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_KEYS`                      | empty                       | Comma-separated or JSON-array API keys. Empty disables auth. Empty members, non-string members, and duplicates are rejected.                                                                                                                                                     |
| `ADMIN_USERNAME`                | `admin`                     | Username for `/admin/login`. The login page never pre-fills or returns this value. Change it from the default and configure it as a secret for shared deployments. |
| `ADMIN_PASSWORD`                | empty                       | Password for the dedicated `/admin/login` page. A successful login creates a signed, HttpOnly, SameSite=Strict 12-hour session; leaving this empty disables all admin routes with HTTP 404. Configure it as a secret. |
| `GEMINI_COOKIE`                 | empty                       | Raw Gemini cookie string; JSON with `cookie` and optional `sapisid`; or JSON with `secure_1psid`, `secure_1psidts`, and optional `sapisid`. Needed for real Pro routing, large-context text attachments, and signed-in Gemini Web behavior. |
| `GEMINI_COOKIES`                | empty                       | JSON array of cookie strings or cookie objects. Takes precedence over `GEMINI_COOKIE` and initializes the account pool. The admin UI can later persist a managed account list and routing strategy in the Durable Object. Configure it as a secret. |
| `SAPISID`                       | empty                       | Optional SAPISID override. If empty, it is extracted from `GEMINI_COOKIE` when possible.                                                                                                                         |
| `GEMINI_BL`                     | bundled value               | Gemini Web build label used by upstream requests. Update if Gemini Web changes and upstream responses become empty.                                                                                              |
| `GEMINI_ORIGIN`                 | `https://gemini.google.com` | Upstream origin. Can point to your own forwarding service or proxy endpoint while preserving expected request semantics.                                                                                         |
| `UPSTREAM_SOCKET`               | `true`                      | Prefer `cloudflare:sockets` upstream transport when available.                                                                                                                                                   |
| `DEFAULT_MODEL`                 | `gemini-3.5-flash`          | Model used when a request omits `model`.                                                                                                                                                                         |
| `RETRY_ATTEMPTS`                | `3`                         | Upstream retry attempts; minimum `1`.                                                                                                                                                                            |
| `GEMINI_ACCOUNT_MAX_ATTEMPTS`   | `10`                        | Maximum distinct pooled accounts attempted by one logical request. This budget is independent from `RETRY_ATTEMPTS`.                                                                                           |
| `RETRY_DELAY_SEC`               | `2`                         | Delay between retry attempts; minimum `0`.                                                                                                                                                                       |
| `REQUEST_TIMEOUT_SEC`           | `180`                       | Upstream request timeout; minimum `1`.                                                                                                                                                                           |
| `REQUEST_BODY_MAX_BYTES`        | `16777216`                  | Maximum buffered JSON request-body bytes. Declared or streamed bodies above this limit are rejected with HTTP 413 before JSON parsing; multipart image edits use their attachment limit instead.                  |
| `LOG_REQUESTS`                  | `false`                     | Enable structured runtime stage logs.                                                                                                                                                                            |
| `CURRENT_INPUT_FILE_ENABLED`    | `true`                      | Enable Gemini text attachments for large prompt context.                                                                                                                                                         |
| `CURRENT_INPUT_FILE_MIN_BYTES`  | `95000`                     | Inline prompt byte threshold before text attachment handling is attempted.                                                                                                                                       |
| `CURRENT_INPUT_FILE_NAME`       | `message.txt`               | Filename used for large message context attachment.                                                                                                                                                              |
| `CURRENT_TOOLS_FILE_NAME`       | `tools.txt`                 | Filename used for large tool-definition context attachment.                                                                                                                                                      |
| `GENERIC_FILE_UPLOAD_MAX_BYTES` | `20971520`                  | Maximum bytes per request-local attachment. The preferred upload path does not send Gemini cookie or SAPISID authorization to `content-push.googleapis.com`; unavailable or failed request-local uploads are ignored with a prompt note. |

When managing a Worker through the Wrangler CLI, optional secrets can be set with:

- Set `API_KEYS` for shared deployments. If it is empty, auth is disabled.
- Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` to enable the account-pool status page and management API with private credentials.
- Set `GEMINI_COOKIE` when Pro routing, image generation/editing, large-context text attachments, or other signed-in Gemini Web behavior is needed.
- Or set `GEMINI_COOKIES` to a JSON array when several accounts should share requests.

```sh
wrangler secret put API_KEYS
wrangler secret put ADMIN_USERNAME
wrangler secret put ADMIN_PASSWORD
wrangler secret put GEMINI_COOKIE
# alternatively:
wrangler secret put GEMINI_COOKIES
```

After setting `ADMIN_USERNAME` and `ADMIN_PASSWORD`, open `/admin` and sign in on the dedicated login page. Neither credential is pre-filled or disclosed by the page, and an invalid login returns the same generic error for either field. The browser receives a signed, HttpOnly, SameSite=Strict session cookie that expires after 12 hours; changing either credential invalidates existing sessions. State-changing admin requests are restricted to the deployment's own origin.

Login failures are tracked by a one-way hash of the Cloudflare client IP in the Durable Object. The fifth consecutive failure starts a 30-second block; additional failures double the delay up to 15 minutes. A successful login clears that client's failure state. Deployments without the Durable Object binding use process-local fallback state.

The account page supports append/replace JSON imports, write-only credential replacement, label changes, reordering, and bulk enable/disable/reset/delete operations. Imports use a mandatory preview step that reports input, add, update, removal, duplicate, and format-error counts before the confirmation write. Cookie and SAPISID values are accepted only on writes: the page, preview, account list API, mutation responses, and generated HTML/JavaScript never return them. The first account-list mutation creates a Durable Object-managed snapshot from the currently active credentials, so later secret changes do not silently overwrite admin-managed accounts. Use **Restore Secret configuration** to discard that managed list and resume `GEMINI_COOKIE` / `GEMINI_COOKIES` as the source of truth.

Each account also has a **Test** action. It fetches the Gemini application page with that account and checks for the authenticated page token, returning only availability, latency, normalized issue type, and HTTP status. It does not send a model prompt or expose the page body or credentials.

Routing can be changed from the page without redeploying:

- **Round robin** distributes requests across eligible accounts in order.
- **Fixed priority** always selects the first eligible account, making list order significant.
- **Least used** selects the eligible account with the lowest cumulative request count.

The selected strategy and admin-managed account list persist in `GEMINI_SESSION_POOL`. Without a Durable Object binding, the same controls work only for the lifetime of the current process/isolate.

When a configured cookie contains `__Secure-1PSID`, the Worker lazily calls Google's `RotateCookies` endpoint when the cookie is stale or an authenticated upstream request fails. Refreshed credentials are committed to the `GEMINI_SESSION_POOL` Durable Object with compare-and-swap versioning, so a cold isolate reads the latest stored value instead of reverting to an older secret. Changing the secret replaces the corresponding stored account and re-enables it.

Example pool value:

```json
[
  { "name": "Primary", "secure_1psid": "ACCOUNT_1_PSID", "secure_1psidts": "ACCOUNT_1_TS" },
  { "name": "Backup", "cookie": "__Secure-1PSID=ACCOUNT_2_PSID; __Secure-1PSIDTS=ACCOUNT_2_TS" }
]
```

For single-cookie deployments, use the shortest practical cookie form: `__Secure-1PSID`, `__Secure-1PSIDTS`, and optional `SAPISID`. A fresh private-browser Gemini login that is closed after extracting these values tends to be more stable than copying a full everyday-browser cookie header. If a cold start falls back to an expired `__Secure-1PSIDTS`, the first authenticated request will try to rotate it. If Google rejects that rotation or returns no updated cookie, update the `GEMINI_COOKIE` secret manually.

Short JSON cookie form:

```json
{
  "secure_1psid": "YOUR_SECURE_1PSID",
  "secure_1psidts": "YOUR_SECURE_1PSIDTS",
  "sapisid": "OPTIONAL_SAPISID"
}
```

For local development, use Wrangler environment support or pass bindings through the local Worker environment.

## Authentication

When `API_KEYS` is empty, every route except Cloudflare/Wrangler infrastructure is publicly callable. For any shared deployment, set at least one API key.

`web2gem-plus` accepts:

- `Authorization: Bearer <key>`
- `x-api-key: <key>`
- `x-goog-api-key: <key>`

The health route `GET /` remains unauthenticated so deployment probes can work without secrets.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Pro requests fail or fall back | Confirm `GEMINI_COOKIE` contains current `__Secure-1PSID` and `__Secure-1PSIDTS` values. Update the secret if cookie rotation can no longer recover it. |
| Large-context attachment is not used | Set `GEMINI_COOKIE` and confirm `CURRENT_INPUT_FILE_ENABLED` is not disabled. |
| Shared endpoint returns 401 | Send one configured `API_KEYS` value through `Authorization: Bearer`, `x-api-key`, or `x-goog-api-key`. |
| Gemini returns empty output | Check whether `GEMINI_BL` still matches the current Gemini Web frontend. If Cloudflare egress is restricted, configure a compatible `GEMINI_ORIGIN`. |
| Docker cannot reach the service | Check the `${PORT:-52389}:${PORT:-52389}` mapping and use the configured host port. |
| No pooled account is available | Open `/admin` to inspect cooling or manually disabled accounts. Authentication failures cool down automatically; a changed cookie or a manual reset makes an account immediately eligible. |

## Development

Authored source lives under `src/`. Do not hand-edit generated files under `dist/`.

```sh
pnpm install
pnpm check:static
pnpm typecheck
pnpm check:arch
pnpm unit
pnpm smoke
```

The build script emits two bundles:

| Bundle                | Source              | Purpose                                         |
| --------------------- | ------------------- | ----------------------------------------------- |
| `dist/worker.js`      | `src/index.ts`      | Production Worker deployed by Wrangler.         |
| `dist/worker.test.js` | `src/test-index.ts` | Local test bundle with internal helper exports. |

Maintainers run **Actions → Release Main Edition** for `main` releases.

## Testing

| Command             | Description                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:static` | Run Biome static analysis with warnings treated as errors.                                                                      |
| `pnpm check:worker-types` | Verify generated Cloudflare Worker binding types are current.                                                            |
| `pnpm typecheck`    | Run TypeScript with strict compiler settings.                                                                                   |
| `pnpm check:arch`   | Enforce import boundaries and detect source dependency cycles.                                                                  |
| `pnpm unit:quick`   | Rebuild stale test bundles when needed, then run local unit checks under `tests/unit/` with Vitest.                             |
| `pnpm unit`         | Build both bundles and run local unit checks under `tests/unit/` with Vitest.                                                   |
| `pnpm coverage`     | Build an isolated coverage bundle and write Vitest V8 lcov and JSON summary reports to `coverage/`.                             |
| `pnpm coverage:ci`  | Run Vitest V8 coverage with global thresholds plus source line and branch coverage gates.                                       |
| `pnpm smoke`        | Build both bundles, verify public exports, request-level routing checks, health route, and DSML tool-call parsing.              |
| `pnpm check:bench`  | Run the performance regression gate against representative hot paths.                                                           |
| `pnpm check:size`   | Build the production Worker and enforce the gzip bundle-size budget.                                                            |
| `pnpm docker:smoke` | Build the Docker image, run a temporary container, and verify health, auth, and OpenAI route behavior through the Node adapter. |

Coverage builds write sourcemapped test bundles to `dist-coverage/` so normal `dist/` builds and coverage runs do not share generated artifacts. Vitest discovers `tests/unit/*.test.mjs` wrappers for `pnpm unit`; shared case lists live in `tests/unit/*.cases.mjs`, use Vitest-backed assertions, and coverage uses Vitest's V8 provider against the isolated test bundle. `pnpm coverage` and `pnpm coverage:ci` use a Node runner so environment variables are handled consistently across Windows and Unix shells. `pnpm coverage:ci` also reads `coverage/coverage-summary.json` through `scripts/check-coverage.mjs` to catch regressions in key source directories and selected high-risk branch paths.

Recommended pre-commit gate:

```sh
pnpm check:static
pnpm typecheck
pnpm check:arch
pnpm unit
pnpm coverage:ci
pnpm smoke
# Optional when Docker is available:
pnpm docker:smoke
```

## Project Structure

```text
.
├── scripts/                 # Build, architecture, unit, and smoke scripts
├── src/
│   ├── completion/          # Provider-neutral completion runtime
│   ├── config/              # Runtime configuration parsing
│   ├── gemini/              # Gemini Web client, transport, uploads, provider adapter
│   ├── http/                # HTTP boundary, OpenAI and Google protocol adapters
│   ├── models/              # Exposed model map and model resolution
│   ├── promptcompat/        # API request shapes to Gemini prompt text
│   ├── shared/              # Provider-neutral utilities
│   ├── toolcall/            # Tool-call prompt, policy, parser, formatter
│   └── toolstream/          # Streamed tool-call detection state
├── tests/unit/              # Local unit checks
├── wrangler.jsonc           # Cloudflare Worker deployment config
└── package.json             # Node scripts and dev dependencies
```

## Security Notice

This project adapts Gemini Web behavior and depends on upstream web protocol details that can change without notice. Use it for personal, research, or internal validation scenarios, and review the terms and risk profile of the upstream service before deploying it for shared use.

Never commit Gemini cookies or API keys. Store secrets in Cloudflare Worker secrets, Docker environment management, or another deployment-secret mechanism.

## Acknowledgements

Project source and releases are maintained at [silencoo/web2gem-plus](https://github.com/silencoo/web2gem-plus).

- Watermark removal core vendored from [GargantuaX/gemini-watermark-remover](https://github.com/GargantuaX/gemini-watermark-remover) (see `src/gemini/client/watermark/vendor/`).

## License

[MIT](LICENSE)
