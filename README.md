# LIFE-LINE AI — Agentic Safety & Emergency Response Intelligence Platform

> *"Your Safety. Your Support. One Intelligent Lifeline."*  
> Hackathon Theme: **Youth and Women Safety** · Domain: **Artificial Intelligence + Agentic AI + Real-Time Systems + Public Safety**

---

## Important Safety & Operational Transparency Notice

LIFE-LINE AI is a personal safety, community support, and incident coordination platform. **It is NOT directly connected to official municipal 911 / 112 / 999 emergency dispatch centers.** Never claim or assume police, ambulances, or fire services have been contacted unless an authorized real-world integration explicitly confirms delivery. In immediate physical danger, always dial your local official emergency number directly.

---

## Core Architecture

- **Frontend:** React 19 + TypeScript + Tailwind CSS v4 + `@vis.gl/react-google-maps` + `recharts` + `lucide-react`
- **Backend:** Node.js + Express (`server.ts` on port `3000`) + authenticated WebSockets (`/ws/realtime` & `/ws/live`) with heartbeat, connection caps, and missed-event replay (`?since=<seq>`)
- **Authentication & RBAC:**
  - Public email registration is strictly locked to `regular_user` accounts.
  - `emergency_operator`, `support_organization`, and `administrator` roles can only be assigned by an Administrator (with last-admin protection).
  - Production mode requires a strong `SESSION_SECRET` (minimum 32 random characters).
  - Sliding-window rate limiting and 15-minute TTL / 5-attempt lockout protect login, registration, email verification, and password-reset endpoints.
- **Database & Migrations (Authoritative Single-Backend Architecture):**
  - 14+ relational tables (`schema_migrations`, `users`, `user_profiles`, `user_preferences`, `trusted_contacts`, `emergency_incidents`, `incident_updates`, `incident_assignments`, `support_organizations`, `support_locations`, `notifications`, `notification_delivery_logs`, `ai_assessments`, `ai_recommendations`, `audit_logs`).
  - Configured with Drizzle ORM (`src/db/schema.ts`) for PostgreSQL / Cloud SQL and SQLite (`node:sqlite` at `.data/lifeline.db`) for local development. No split-brain fallback: `initializeDatabase()` locks one authoritative dialect at startup and fails fast in production if PostgreSQL is required and unreachable.
- **Reliable & Truthful SOS Delivery:**
  - Offline SOS alerts are bound to `{ userId, userUid }`, deduplicated with unique `idempotencyKey` values, expire after 24 hours, and retry with exponential backoff.
  - Incident delivery state tracks `queued`, `submitted`, `delivered`, and `failed` truthfully based on real provider confirmation IDs (`gmail_workspace`, `resend`, `twilio`).
- **AI Engine (`@google/genai` server-side):**
  - Five safety agents with explicit timeouts, quota/malformed-response handling, deterministic fallbacks, and strict `isAiAdvisory` separation from verified directory facts.
- **Google Maps Platform & Key Restrictions:**
  - `VITE_GOOGLE_MAPS_API_KEY` (client Map/Places/Routes) is kept separate from `GOOGLE_MAPS_API_KEY` (server-side proxy) and `/api/config/public` never leaks the server key.
- **PWA Security:**
  - Workbox runtime caching caches only public non-authenticated endpoints (`/api/support-directory`, `/api/health`). Private user data is never cached in shared Workbox storage.

---

## Environment Variables (`.env.example`)

Copy `.env.example` to `.env` for local runs or configure secrets in Cloud Run / AI Studio:
- `SESSION_SECRET`: **Required in production** (minimum 32 random characters, e.g. `openssl rand -hex 32`).
- `DB_DRIVER`: `auto` | `postgres` | `sqlite`.
- `ALLOW_DEMO_LOGIN`: Set `"true"` only if demo sandbox login should be permitted in production (default disabled in production).
- `GEMINI_API_KEY`: Server-side Gemini AI key.
- `VITE_GOOGLE_MAPS_API_KEY`: Client-only Maps key — restrict in Google Cloud Console by **HTTP Referrers** and **Maps JavaScript / Places / Routes APIs**.
- `GOOGLE_MAPS_API_KEY`: Server-only Maps key — restrict by **Server IP / VPC** and **Places / Geocoding Web Service APIs**.
- `SQL_HOST`, `SQL_DB_NAME`, `SQL_USER`, `SQL_PASSWORD`, `SQL_ADMIN_USER`, `SQL_ADMIN_PASSWORD`: Cloud SQL PostgreSQL connection credentials.
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`: Optional external email/SMS providers.

---

## Scripts

```bash
npm install
npm run lint     # TypeScript check (tsc --noEmit)
npm test         # Automated security, DB, SOS, WebSocket, AI & PWA test suite
npm run build    # Production Vite bundle
npm run dev      # Starts Express + Vite middleware + WebSockets on port 3000
npm start        # Production server entry point
```

---

## Deployment Checklist

1. Generate and set a strong `SESSION_SECRET` (>= 32 chars) and set `NODE_ENV=production`.
2. Ensure Cloud SQL PostgreSQL is reachable (`SQL_HOST`, `SQL_DB_NAME`, `SQL_USER`, `SQL_PASSWORD`) and `DB_DRIVER=postgres` (or `auto`).
3. Set `ALLOW_DEMO_LOGIN=false` in live production deployments unless intentionally running an evaluation sandbox.
4. Configure HTTP-referrer restrictions on `VITE_GOOGLE_MAPS_API_KEY` and IP/service restrictions on `GOOGLE_MAPS_API_KEY`.
5. Run `npm run lint && npm test && npm run build`.
6. Start with `NODE_ENV=production npm start` and verify `GET /api/health` returns HTTP `200` with `database.ok: true`.
