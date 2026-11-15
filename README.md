# LIFE-LINE AI — Agentic Safety & Emergency Response Intelligence Platform

> *"Your Safety. Your Support. One Intelligent Lifeline."*  
> Hackathon Theme: **Youth and Women Safety** · Domain: **Artificial Intelligence + Agentic AI + Real-Time Systems + Public Safety**

---

## Important Safety & Operational Transparency Notice

LIFE-LINE AI is a personal safety, community support, and incident coordination platform. **It is NOT directly connected to official municipal 911 / 112 / 999 emergency dispatch centers.** Never claim or assume police, ambulances, or fire services have been contacted unless an authorized real-world integration explicitly confirms delivery. In immediate physical danger, always dial your local official emergency number directly.

---

## Core Architecture

- **Frontend:** React 19 + TypeScript + Tailwind CSS v4 + `@vis.gl/react-google-maps` + `recharts` + `lucide-react`
- **Backend:** Node.js + Express (`server.ts` on port `3000`) + WebSockets (`/ws/realtime` & `/ws/live`)
- **AI Engine (`@google/genai` server-side):**
  1. **Emergency Assessment Agent** (`gemini-4-hydrogen` + `ThinkingLevel.HIGH` + structured JSON schema, supports image triage)
  2. **Safety Intelligence Agent** (`gemini-4-hydrogen` + optional `googleSearch` grounding + uncertainty disclosures)
  3. **Resource Discovery Agent** (`gemini-4-hydrogen` + `googleMaps` grounding returning verified Google Maps links)
  4. **Emergency Coordination Agent** (`gemini-4-hydrogen` + `FunctionDeclaration` tool drafts gated by human confirmation)
  5. **AI Support & Live Voice Companion** (`gemini-4-hydrogen` chat, `gemini-3.1-flash-lite` fast mode, `gemini-3.5-transcribe` audio transcription, `gemini-3.8-flash-lite-tts` calm voice readout, and `gemini-3.8-live` two-way audio WebSocket companion)
- **Database & Persistence (14 Relational Tables):**
  - `users`, `user_profiles`, `user_preferences`, `trusted_contacts`, `emergency_incidents`, `incident_updates`, `incident_assignments`, `support_organizations`, `support_locations`, `notifications`, `notification_delivery_logs`, `ai_assessments`, `ai_recommendations`, `audit_logs`
  - Configured with Drizzle ORM (`src/db/schema.ts`, `src/db/drizzle.config.ts`) for PostgreSQL / Cloud SQL and automatic `node:sqlite` (`.data/lifeline.db`) relational fallback when the Cloud SQL socket is unavailable.
- **Google Maps Platform:**
  - Interactive `<Map>` with `<AdvancedMarker>` + `<Pin>` + `<InfoWindow>`
  - Modern Places API (New): `AutocompleteSuggestion` + server-proxied `places:searchNearby` & `places:searchText`
  - Modern Routes API: `Route.computeRoutes()` + `createPolylines()`
- **Google Workspace & Firebase Auth:**
  - Google Sign-In + client-side Workspace OAuth (in-memory token only, explicit confirmation modal before any mutating call) for Gmail, Contacts, Calendar, Sheets, Docs, Drive, and Tasks.

---

## Environment Variables (`.env.example`)

Copy `.env.example` to `.env` for local runs outside AI Studio:
- `GEMINI_API_KEY`: Required for server-side Gemini AI agents & Live Voice Companion (falls back cleanly to deterministic guidance if unset).
- `VITE_GOOGLE_MAPS_API_KEY` / `GOOGLE_MAPS_API_KEY`: Google Maps Platform key for interactive maps, Places, Routes, and Geocoding.
- `SQL_HOST`, `SQL_DB_NAME`, `SQL_USER`, `SQL_PASSWORD`, `SQL_ADMIN_USER`, `SQL_ADMIN_PASSWORD`: Cloud SQL PostgreSQL connection credentials.
- `RESEND_API_KEY` / `TWILIO_*`: Optional external email/SMS providers.

---

## Scripts

```bash
npm install
npm run lint     # TypeScript check (tsc --noEmit)
npm run build    # Production Vite bundle
npm run dev      # Starts Express + Vite middleware + WebSockets on port 3000
npm start        # Production server entry point
```

---

## Hackathon Demonstration Mode & Judge Walkthrough

Demo sandbox accounts are clearly labeled `[SIMULATED]` and isolated from live operational metrics in Analytics:

- **Regular User:** `maya.demo@lifeline-ai.demo`
- **Emergency Operator:** `operator.demo@lifeline-ai.demo`
- **Verified Support Org:** `partner.demo@lifeline-ai.demo`
- **Admin Sandbox:** `admin.demo@lifeline-ai.demo`
- **Shared Demo Password:** `LifelineDemo2026!` (or click any **Judge Sandbox** card in Sign In)

### Testing Flow
1. Open the landing page and click **Explore Platform** (or **Sign In / Judge Sandbox**).
2. On the **User Dashboard**, verify Trusted Contacts, check Live Location Status, and press **Emergency SOS** to walk through the 5-second cancellable SOS dispatch.
3. Open **Operator Desk** (via Demo Operator role) to see the incident arrive over WebSockets in real time, inspect the incident map, Acknowledge -> Mark Assistance in Progress -> Resolve, and inspect **Analytics** (Live vs Simulated metrics) + **Audit Logs**.
4. Open **Live Map** to search locations via Places Autocomplete, scan nearby support services, and compute walking/driving/transit routes.
5. Open **AI Agents** to test all 5 agents, audio transcription, calm voice readout, and the real-time Voice Safety Companion.
