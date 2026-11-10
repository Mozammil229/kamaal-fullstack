# Kamaal Fullstack (Backend API + Admin Panel) — Single Vercel Deployment

## 📁 Structure
- `api/index.js` — Vercel serverless entry (backend API)
- `src/` — Backend source (Express + Mongoose)
- `public/admin.html` — Admin Panel UI
- `vercel.json` — Routes: `/api/*` → backend, rest → static

## 🚀 Deploy (One Project Only)

1. GitHub pe yeh folder push karein
2. Vercel → **Add New Project** → repo select
3. Framework: **Other**, Root: `./`
4. **Environment Variables** set karein:

| Key | Value |
|---|---|
| `MONGODB_URI` | `mongodb+srv://<db_user>:<db_password>@<cluster-host>/<database>?retryWrites=true&w=majority` |
| `JWT_SECRET` | `<generate-a-long-random-secret>` |
| `ADMIN_USER` | `admin` |
| `ADMIN_PASS` | `<choose-a-strong-admin-password>` |
| `ADMIN_JWT_SECRET` | `<generate-a-long-random-secret>` |
| `GEMINI_API_KEY` | (optional) |

5. **Deploy**

## ⚠️ MongoDB Atlas (Zaroori!)
- **Network Access** → IP Whitelist mein `0.0.0.0/0` add karein
- Warna `Disconnected / Standby` aayega

## 🔐 Admin Panel
- URL: `https://aapka-app.vercel.app/admin.html`
- Username: `admin` / Password: `<set-in-environment>`
- No CORS issue (same origin)
- No proxy needed (same origin)

## ✅ Health Check
`https://aapka-app.vercel.app/api/health` → `"database":"Connected"`
