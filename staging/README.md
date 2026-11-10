# Staging (4A)

- Staging backend: same code as production (frozen tag `backend-v2.0.0-known-good`
  + 4A fixes commit), different env, different database.
- Staging DB: a SEPARATE Atlas database (never the production database).
  Create it in Atlas, allowlist the staging host's outbound IP, and put its
  connection string in `staging/.env.staging` (copied from `.env.staging.example`).
- No staging host exists yet — the staging backend is deployed to the real host
  once H-01–H-12 are answered, or to Vercel as a separate preview deployment.
  Until then, staging runs locally (`NODE_ENV=staging node src/server.js`)
  against the staging DB.
- The T3 contract suite (`tests/4a-regressions.test.js` seed + 4E suite) runs
  against staging, never against production data.

## 4F fail-fast env validation (W1)

`src/server.js` now validates the environment BEFORE booting
(`src/config/validateEnv.js`, wired at `src/server.js:1-8`). In
`NODE_ENV=staging` or `production` the server REFUSES to start
(exit 1, clear message, no stack trace, no secret values echoed) when
any of these hold — ALL problems are listed at once, never one at a
time (STAGING_CHECKLIST.md S-05):

- `NODE_ENV` is unset, blank, or not one of `development | test |
  staging | production` (e.g. `Staging`, `qa`). The boot mode must be
  declared explicitly; a bare `npm start` / `node src/server.js`
  with no `NODE_ENV` now refuses. Use `npm run dev`
  (`NODE_ENV=development`) locally or `npm run staging`
  (`NODE_ENV=staging`) for the rehearsal.
- `MONGODB_URI` is missing, points at `localhost` / `127.0.0.1` /
  `::1`, names no database (the driver would default to `test`), or
  names a test database (`test`, `test-*`, `*_test`, `*-test`).
- `JWT_SECRET` / `ADMIN_JWT_SECRET` is missing, looks like a
  placeholder (`<...>`, `changeme`, `dummy`, `test`, `password`, …),
  or shorter than 32 characters.
- Any optional secret, when set, is a placeholder or shorter than its
  minimum: `WEB_JWT_SECRET` 32, `ADMIN_PASS` 12, `CRON_SECRET` /
  `OPS_INTERNAL_KEY` / `APIKEY_ENCRYPTION_KEY` / `MEMORY_ENC_KEY` /
  `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` /
  `BLOB_READ_WRITE_TOKEN` / `YOUTUBE_API_KEY` 16. Unset optional keys
  stay allowed (each feature degrades by design — e.g. unset
  `ADMIN_PASS` disables direct-key admin login); they only warn.
- `CORS_ALLOWED_ORIGINS` contains `*` or a malformed (non-bare-origin)
  entry. Unset is allowed (default allowlist applies) with a warning.
- `RSA_PRIVATE_KEY_PEM`, when set, must look like a PEM private key.

In `development` / `test` none of the strict checks apply — the
existing dummy-env behaviour keeps working (`npm test` boots with
dummy secrets and no MongoDB). Regression tests:
`tests/4f-staging-env.test.js` (17 tests: unit checks per rule + real
`node src/server.js` subprocess boots proving each refusal and both
valid boots).

Local rehearsal harness (PWA repo): `~/workspace/kamaal-pwa/staging/server.mjs`
boots this backend with `NODE_ENV=staging` against
`~/workspace/kamaal-pwa/staging/.env.staging` (staging-only dummy
values; MongoDB host `staging.invalid` can never resolve, so the
backend honestly reports DB-down, `GET /api/health` → 503) and serves
the built PWA shell with SPA fallback + production CSP headers. See
`~/workspace/kamaal-pwa/staging/README.md`.
