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
