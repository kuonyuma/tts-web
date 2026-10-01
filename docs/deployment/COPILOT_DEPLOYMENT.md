# AI Reading Copilot deployment

The Copilot uses server-owned provider credentials. Browser requests cannot supply or override an
LLM key. Gemini BYOK remains available only to the separate Gemini TTS engine.

## Model catalog

| Product ID | Upstream model | Availability | Reasoning modes |
|---|---|---|---|
| `deepseek-flash` | `deepseek-flash` | Enabled when configured | `direct`, `low`, `deep`, `max` |
| `qwen-3.7-flash` | `qwen3.7-flash-2026-07-15` | Enabled when configured | `direct`, `brief`, `balanced`, `deep` |
| `glm-5.3-flash` | `glm-5.3-flash` | Disabled until capability validation | Candidate: `direct`, `balanced`, `deep`, `max` |

The backend owns the catalog and returns only configured, enabled products from
`GET /api/copilot/models`. The browser therefore cannot invent an upstream model or reasoning
parameter. There is no automatic provider fallback.

## Local development

Copy `backend/.env.example` to `backend/.env`, configure one provider key, and leave:

```dotenv
APP_ENV=development
COPILOT_AUTH_MODE=development
```

In this mode only, the existing `X-Client-ID` identifies local sessions and Redis is optional.

## Required production boundary

Production startup fails unless all of these conditions are met:

- `APP_ENV=production`
- `COPILOT_AUTH_MODE=trusted_proxy`
- `AUTH_PROXY_SECRET` contains at least 32 random characters
- `REDIS_URL` is configured
- every configured cross-origin origin uses HTTPS and no wildcard is present

The public TLS/WAF/reverse proxy must authenticate the user, remove any inbound
`X-Authenticated-User` and `X-Auth-Proxy-Secret` headers, and inject both headers on the private
upstream request. The application port must remain private; the supplied Compose mapping binds it
to `127.0.0.1`. Rotate the proxy secret and model credentials through the deployment secret manager.
Prefer `DEEPSEEK_API_KEY_FILE`, `ZHIPU_API_KEY_FILE`, `QWEN_API_KEY_FILE`, and
`AUTH_PROXY_SECRET_FILE` over plaintext environment values.

Redis atomically reserves weighted quotas after cache lookup and before each billable model call:
per-user/minute, per-user/day, and global/day. Provider failures do not refund admission units.
Tune the three `COPILOT_*_UNITS` values only after observing real token cost.
Redis also provides a token-owned distributed lock around each explanation/chat session so parallel
workers cannot turn one cache miss or duplicate submission into multiple provider charges.
Use `/health` for liveness and `/ready` for traffic readiness. Readiness stays unavailable when no
model is configured or the quota backend cannot be reached.

## Data and output handling

- Prompts are sent as structured system/user messages.
- Provider URLs are compile-time allowlisted; redirects and retries are disabled.
- Response bodies, final output lengths, timeouts, queues, and concurrency are bounded.
- Follow-up context is capped by turns, per-message size, and a total character budget.
- `reasoning_content` is ignored. Only the final answer is returned or stored.
- The database stores explanation/chat text plus aggregate daily call/token accounting. It does not
  store API keys or model reasoning traces.
- Cache keys include model product, upstream model, reasoning mode, profile revision, and prompt
  version. Bump `COPILOT_PROMPT_VERSION` when prompt behavior changes.
- Public errors never include provider response bodies, URLs, credentials, or upstream status codes.
- CSP, anti-framing, MIME sniffing, referrer, permissions, cross-origin, and production HSTS headers
  are applied by the application.
- Frontend fonts use the local system stack; no third-party font origin is required by the CSP.

## GLM 5.3 Flash release gate

Do not set `COPILOT_ENABLE_UNVERIFIED_GLM53=true` in production until the real account endpoint has
passed contract tests for its exact model ID, reasoning fields, output shape, token accounting,
timeouts, and error behavior. After validation, update the profile revision and add captured mock
fixtures without committing provider responses that contain user data.

## Remaining infrastructure work before public launch

This repository now has application-level controls, but a serious public launch still needs the
external infrastructure that code cannot provision by itself: a selected identity provider and
edge auth configuration, managed Redis, managed database/backups, WAF/bot controls, centralized
redacted logs/alerts, provider billing alerts and hard caps, secret rotation, vulnerability scanning,
load tests, abuse tests, and a rollback drill. SQLite remains suitable for local/single-instance use;
migrate Copilot records and the aggregate ledger to PostgreSQL before horizontal scaling.
