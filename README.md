# 🛡️ SafeNet — AI Income Protection for Gig Workers

> Built for **DevTrails 2026 — Scale (Phase 2)** | Team AlphaNexus

---

## 🚀 Live Links

| What | URL |
|------|-----|
| 🌐 **Admin Dashboard** | [https://devtrails-2026-alphanexus-phase-scale.vercel.app](https://devtrails-2026-alphanexus-phase-scale.vercel.app) |
| ⚙️ **Backend API** | [https://devtrails2026-alphanexus-phase2-2.onrender.com](https://devtrails2026-alphanexus-phase2-2.onrender.com) |
| ❤️ **Health Check** | [https://devtrails2026-alphanexus-phase2-2.onrender.com/health](https://devtrails2026-alphanexus-phase2-2.onrender.com/health) |
| 📱 **Mobile App** | Scan QR below with Expo Go |
| 💻 **GitHub** | [https://github.com/BHARGAVSAI558/devtrails-2026-alphanexus-phase-scale](https://github.com/BHARGAVSAI558/devtrails-2026-alphanexus-phase-scale) |

---

## 📱 Try the Mobile App — 3 Steps

### Step 1 — Install Expo Go on your phone

| Platform | Link |
|----------|------|
| 🍎 iPhone | [App Store → search "Expo Go"](https://apps.apple.com/app/expo-go/id982107779) |
| 🤖 Android | [Play Store → search "Expo Go"](https://play.google.com/store/apps/details?id=host.exp.exponent) |

---

### Step 2 — Scan this QR code

Open **Expo Go** on your phone → tap **"Scan QR Code"** → scan below:

```
exp://u.expo.dev/safenet
```

> **OR** — run it yourself in 30 seconds:
> ```bash
> git clone https://github.com/BHARGAVSAI558/devtrails-2026-alphanexus-phase-scale
> cd devtrails-2026-alphanexus-phase-scale/SafeNetFresh
> npm install
> npx expo start
> ```
> Then scan the QR that appears in your terminal with Expo Go.

---

### Step 3 — App loads instantly

- Enter your phone number → receive OTP → verify
- Set up your gig worker profile (platform, zone, coverage tier)
- Dashboard shows live zone status, coverage, and earnings protection
- Tap **"Simulate Disruption"** to see a live claim → payout in ~9 seconds

---

## 🌐 Try the Admin Dashboard

1. Open [https://devtrails-2026-alphanexus-phase-scale.vercel.app](https://devtrails-2026-alphanexus-phase-scale.vercel.app)
2. Login with admin OTP
3. See live claims feed, fraud queue, zone heatmap, worker analytics

---

## 💡 What is SafeNet?

SafeNet protects gig workers (Zomato/Swiggy delivery riders) from income loss caused by disruptions — heavy rain, extreme heat, curfew, or AQI spikes.

When a disruption hits:
1. 🔍 **Detected** — weather/AQI/event signals trigger automatically
2. ✅ **Verified** — 4-layer fraud engine checks GPS, behavior, cluster, enrollment
3. 💰 **Paid** — payout credited to worker wallet in seconds

---

## 🏗️ Architecture

```mermaid
flowchart TB
  subgraph Mobile["📱 SafeNetFresh (Expo)"]
    RN[React Native UI]
    API_JS[services/api.js]
    WS_M[WebSocket Client]
  end

  subgraph Admin["🖥️ Admin Dashboard (Vite + React)"]
    ADM_UI[Live Feed + Analytics]
    WS_A[WebSocket Client]
  end

  subgraph Backend["⚙️ FastAPI Backend (Render)"]
    REST[REST /api/v1/*]
    WSS[WebSockets /ws/*]
    ENG[ML Engines: fraud, premium, payout]
    PG[(PostgreSQL)]
  end

  RN --> API_JS --> REST
  WS_M --> WSS
  WS_A --> WSS
  ADM_UI --> REST
  REST --> ENG --> PG
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Mobile | React Native, Expo, Zustand, TanStack Query |
| Admin | React, Vite, TypeScript, TailwindCSS, Recharts |
| Backend | FastAPI, SQLAlchemy, PostgreSQL, Alembic |
| ML | scikit-learn, XGBoost, joblib |
| Real-time | WebSockets, Redis pub/sub |
| Deployment | Render (backend), Vercel (admin) |

---

## 📁 Project Structure

```
/
├── safenet_v2/
│   ├── backend/        ← FastAPI backend (deployed on Render)
│   └── admin/          ← React admin dashboard (deployed on Vercel)
└── SafeNetFresh/       ← Expo mobile app
```

---

## ⚡ Key Features

- **OTP Auth** — phone number login, no passwords
- **Live Zone Status** — weather, AQI, active alerts per zone
- **4-Layer Fraud Engine** — GPS, behavioral, cluster, enrollment checks
- **ML Premium Engine** — dynamic weekly premium based on zone risk + tenure
- **Real-time WebSockets** — claim status updates pushed live to mobile + admin
- **Forecast Shield** — proactive coverage upgrade before predicted disruptions
- **Earnings DNA** — 7×24 heatmap of worker earning patterns

---

*DevTrails 2026 — AlphaNexus Team*

---

---

# SafeNet (ALPHA workspace) — project map

This repository contains three applications that work together:

| Area | Path | Role |
|------|------|------|
| **API** | `safenet_v2/backend/` | FastAPI backend: auth, policies, claims, fraud/ML engines, WebSockets, schedulers |
| **Admin** | `safenet_v2/admin/` | Vite + React + TypeScript dashboard (OTP login, live feed, zones, workers, simulations) |
| **Mobile** | `SafeNetFresh/` | Expo / React Native worker app (dashboard, claims, telemetry) |

---

## High-level architecture

```mermaid
flowchart TB
  subgraph Mobile["SafeNetFresh (Expo)"]
    RN[React Native UI]
    API_JS[services/api.js]
    WS_M[services/websocket.service.js]
    TELEM[device_fingerprint.service.js]
  end

  subgraph Admin["safenet_v2/admin (Vite + React)"]
    ADM_UI[Pages + Zustand]
    WS_A[services/admin_websocket.ts]
  end

  subgraph Backend["safenet_v2/backend (FastAPI)"]
    REST[REST /api/v1/*]
    WSS[WebSockets /ws/*]
    ENG[Engines: confidence, fraud, premium, payout, ...]
    SVC[Services: weather, AQI, events, realtime]
    PG[(PostgreSQL)]
    RD[(Redis)]
    MG[(MongoDB)]
  end

  RN --> API_JS --> REST
  TELEM --> REST
  WS_M --> WSS
  WS_A --> WSS
  ADM_UI --> REST
  ENG --> PG
  ENG --> MG
  SVC --> RD
  REST --> ENG
```

---

## ASCII folder tree (source layout)

> **Note:** `node_modules/`, `.expo/`, `dist/`, `__pycache__/`, and `.venv/` are build/cache folders and are omitted below.

```
ALPHA/
├── README.md                          ← this file
├── package-lock.json                  ← root lockfile (if present)
│
├── safenet_v2/
│   ├── backend/
│   │   ├── .env                       ← local secrets (do not commit)
│   │   ├── alembic.ini
│   │   ├── requirements.txt
│   │   ├── alembic/versions/
│   │   │   ├── c002_perf_security_indexes.py
│   │   │   └── c003_device_fingerprints.py
│   │   ├── app/
│   │   │   ├── main.py
│   │   │   ├── __init__.py
│   │   │   ├── api/
│   │   │   │   ├── deps.py
│   │   │   │   └── v1/routes/
│   │   │   │       ├── admin.py
│   │   │   │       ├── auth.py
│   │   │   │       ├── claims.py
│   │   │   │       ├── policies.py
│   │   │   │       ├── simulation.py
│   │   │   │       ├── websockets.py
│   │   │   │       ├── workers.py
│   │   │   │       └── zones.py
│   │   │   ├── core/
│   │   │   │   ├── config.py
│   │   │   │   ├── exceptions.py
│   │   │   │   ├── middleware.py
│   │   │   │   ├── rate_limit.py
│   │   │   │   ├── security.py
│   │   │   │   └── ws_manager.py
│   │   │   ├── data/
│   │   │   │   ├── government_alerts_seed.json
│   │   │   │   └── zone_coordinates.json
│   │   │   ├── db/
│   │   │   │   ├── base.py
│   │   │   │   ├── mongo.py
│   │   │   │   ├── session.py
│   │   │   │   └── migrations/
│   │   │   │       ├── env.py
│   │   │   │       ├── script.py.mako
│   │   │   │       └── versions/
│   │   │   │           ├── c001_baseline.py
│   │   │   │           ├── c002_perf_security_indexes.py
│   │   │   │           └── c003_device_fingerprints.py
│   │   │   ├── engines/
│   │   │   │   ├── behavioral_engine.py
│   │   │   │   ├── confidence_engine.py
│   │   │   │   ├── decision_engine.py
│   │   │   │   ├── fraud_engine.py
│   │   │   │   ├── payout_engine.py
│   │   │   │   ├── premium_engine.py
│   │   │   │   ├── trust_engine.py
│   │   │   │   └── fraud/
│   │   │   │       ├── pipeline.py
│   │   │   │       ├── types.py
│   │   │   │       ├── helpers.py
│   │   │   │       ├── layer1_gps.py
│   │   │   │       ├── layer2_corroboration.py
│   │   │   │       ├── layer3_cluster.py
│   │   │   │       └── layer4_enrollment.py
│   │   │   ├── ml/
│   │   │   │   ├── premium_model.py
│   │   │   │   ├── behavioral_model_trainer.py
│   │   │   │   └── city_baselines.json
│   │   │   ├── ml_models/
│   │   │   │   ├── premium_model.pkl
│   │   │   │   └── feature_importance.png
│   │   │   ├── models/
│   │   │   │   ├── auth_token.py
│   │   │   │   ├── claim.py
│   │   │   │   ├── device_fingerprint.py
│   │   │   │   ├── fraud.py
│   │   │   │   ├── payout.py
│   │   │   │   ├── policy.py
│   │   │   │   ├── pool_balance.py
│   │   │   │   ├── worker.py
│   │   │   │   └── zone.py
│   │   │   ├── schemas/
│   │   │   │   ├── admin.py
│   │   │   │   ├── auth.py
│   │   │   │   ├── claim.py
│   │   │   │   ├── policy.py
│   │   │   │   └── worker.py
│   │   │   ├── services/
│   │   │   │   ├── aqi_service.py
│   │   │   │   ├── cache_service.py
│   │   │   │   ├── cpcb_aqi.py
│   │   │   │   ├── dependencies.py
│   │   │   │   ├── event_service.py
│   │   │   │   ├── notification_service.py
│   │   │   │   ├── otp_service.py
│   │   │   │   ├── protocols.py
│   │   │   │   ├── realtime_service.py
│   │   │   │   ├── signal_types.py
│   │   │   │   ├── weather_service.py
│   │   │   │   └── zone_resolver.py
│   │   │   ├── tasks/
│   │   │   │   ├── background_scheduler.py
│   │   │   │   ├── claim_processor.py
│   │   │   │   └── premium_recalculator.py
│   │   │   └── utils/
│   │   │       ├── crypto.py
│   │   │       ├── geo_utils.py
│   │   │       ├── logger.py
│   │   │       └── validators.py
│   │   ├── scripts/
│   │   │   └── set_admin_user.py
│   │   └── tests/
│   │       └── test_cpcb_aqi.py
│   │
│   └── admin/
│       ├── index.html
│       ├── package.json
│       ├── package-lock.json
│       ├── vite.config.js
│       ├── tsconfig.json
│       ├── tailwind.config.ts
│       ├── postcss.config.js
│       ├── eslint.config.js
│       ├── README.md
│       ├── public/
│       │   ├── favicon.svg
│       │   └── icons.svg
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── App.css
│           ├── index.css
│           ├── api.ts
│           ├── components/
│           │   └── Layout.tsx
│           ├── pages/
│           │   ├── Login.tsx
│           │   ├── Dashboard.tsx
│           │   ├── ZoneHeatmap.tsx
│           │   ├── FraudInsights.tsx
│           │   ├── Workers.tsx
│           │   ├── Simulations.tsx
│           │   └── Users.tsx
│           ├── services/
│           │   └── admin_websocket.ts
│           ├── stores/
│           │   ├── auth.ts
│           │   ├── adminConnection.ts
│           │   ├── adminUi.ts
│           │   ├── claimsFeed.ts
│           │   ├── fraudQueue.ts
│           │   ├── poolHealth.ts
│           │   └── zoneEvents.ts
│           └── assets/
│               ├── hero.png
│               ├── react.svg
│               └── vite.svg
│
└── SafeNetFresh/
    ├── App.js
    ├── index.js
    ├── app.json
    ├── babel.config.js
    ├── metro.config.js
    ├── package.json
    ├── package-lock.json
    ├── .gitignore
    ├── assets/
    │   ├── adaptive-icon.png
    │   ├── favicon.png
    │   ├── icon.png
    │   └── splash-icon.png
    ├── components/
    │   ├── DisruptionModal.js
    │   ├── LocationGate.js
    │   ├── NotificationInitializer.js
    │   ├── PolicyBootstrap.js
    │   ├── PremiumDueModal.js
    │   └── WebSocketBridge.js
    ├── contexts/
    │   ├── AuthContext.js
    │   ├── ClaimContext.js
    │   └── PolicyContext.js
    ├── hooks/
    │   ├── useActiveClaims.js
    │   ├── usePayoutHistory.js
    │   ├── usePoolHealth.js
    │   └── useWorkerProfile.js
    ├── screens/
    │   ├── SplashScreen.js
    │   ├── OnboardingScreen.js
    │   ├── OTPVerifyScreen.js
    │   ├── ProfileSetupScreen.js
    │   ├── DashboardScreen.js
    │   ├── PolicyScreen.js
    │   ├── ClaimsScreen.js
    │   └── ProfileScreen.js
    └── services/
        ├── api.js
        ├── tokenStore.js
        ├── websocket.service.js
        ├── location.service.js
        ├── notification.service.js
        ├── navigationService.js
        └── device_fingerprint.service.js
```

**Cleanup note:** If you see a stray file named `SafeNetFresh/com.facebook.react.modules.core.ReactChoreographer` (no extension), it is not part of the app source; it is safe to delete.

---

## Flat file index (tracked source files)

Alphabetical list of project files **excluding** `node_modules`, `.git`, `__pycache__`, `.expo`, `dist`, and virtualenvs.

### Root

- `package-lock.json`

### `safenet_v2/admin/`

- `eslint.config.js`
- `index.html`
- `package.json`
- `package-lock.json`
- `postcss.config.js`
- `README.md`
- `tailwind.config.ts`
- `tsconfig.json`
- `vite.config.js`
- `public/favicon.svg`
- `public/icons.svg`
- `src/api.ts`
- `src/App.css`
- `src/App.tsx`
- `src/index.css`
- `src/main.tsx`
- `src/assets/hero.png`
- `src/assets/react.svg`
- `src/assets/vite.svg`
- `src/components/Layout.tsx`
- `src/pages/Dashboard.tsx`
- `src/pages/FraudInsights.tsx`
- `src/pages/Login.tsx`
- `src/pages/Simulations.tsx`
- `src/pages/Users.tsx`
- `src/pages/Workers.tsx`
- `src/pages/ZoneHeatmap.tsx`
- `src/services/admin_websocket.ts`
- `src/stores/adminConnection.ts`
- `src/stores/adminUi.ts`
- `src/stores/auth.ts`
- `src/stores/claimsFeed.ts`
- `src/stores/fraudQueue.ts`
- `src/stores/poolHealth.ts`
- `src/stores/zoneEvents.ts`

### `safenet_v2/backend/`

- `.env` *(local only; use your own secrets)*
- `alembic.ini`
- `requirements.txt`
- `alembic/versions/c002_perf_security_indexes.py`
- `alembic/versions/c003_device_fingerprints.py`
- `app/__init__.py`
- `app/main.py`
- `app/api/__init__.py`
- `app/api/deps.py`
- `app/api/v1/__init__.py`
- `app/api/v1/routes/__init__.py`
- `app/api/v1/routes/admin.py`
- `app/api/v1/routes/auth.py`
- `app/api/v1/routes/claims.py`
- `app/api/v1/routes/policies.py`
- `app/api/v1/routes/simulation.py`
- `app/api/v1/routes/websockets.py`
- `app/api/v1/routes/workers.py`
- `app/api/v1/routes/zones.py`
- `app/core/__init__.py`
- `app/core/config.py`
- `app/core/exceptions.py`
- `app/core/middleware.py`
- `app/core/rate_limit.py`
- `app/core/security.py`
- `app/core/ws_manager.py`
- `app/data/government_alerts_seed.json`
- `app/data/zone_coordinates.json`
- `app/db/__init__.py`
- `app/db/base.py`
- `app/db/mongo.py`
- `app/db/session.py`
- `app/db/migrations/env.py`
- `app/db/migrations/script.py.mako`
- `app/db/migrations/versions/c001_baseline.py`
- `app/db/migrations/versions/c002_perf_security_indexes.py`
- `app/db/migrations/versions/c003_device_fingerprints.py`
- `app/engines/__init__.py`
- `app/engines/behavioral_engine.py`
- `app/engines/confidence_engine.py`
- `app/engines/decision_engine.py`
- `app/engines/fraud_engine.py`
- `app/engines/payout_engine.py`
- `app/engines/premium_engine.py`
- `app/engines/trust_engine.py`
- `app/engines/fraud/__init__.py`
- `app/engines/fraud/helpers.py`
- `app/engines/fraud/layer1_gps.py`
- `app/engines/fraud/layer2_corroboration.py`
- `app/engines/fraud/layer3_cluster.py`
- `app/engines/fraud/layer4_enrollment.py`
- `app/engines/fraud/pipeline.py`
- `app/engines/fraud/types.py`
- `app/ml/__init__.py`
- `app/ml/behavioral_model_trainer.py`
- `app/ml/city_baselines.json`
- `app/ml/premium_model.py`
- `app/ml_models/feature_importance.png`
- `app/ml_models/premium_model.pkl`
- `app/models/__init__.py`
- `app/models/auth_token.py`
- `app/models/claim.py`
- `app/models/device_fingerprint.py`
- `app/models/fraud.py`
- `app/models/payout.py`
- `app/models/policy.py`
- `app/models/pool_balance.py`
- `app/models/worker.py`
- `app/models/zone.py`
- `app/schemas/__init__.py`
- `app/schemas/admin.py`
- `app/schemas/auth.py`
- `app/schemas/claim.py`
- `app/schemas/policy.py`
- `app/schemas/worker.py`
- `app/services/__init__.py`
- `app/services/aqi_service.py`
- `app/services/cache_service.py`
- `app/services/cpcb_aqi.py`
- `app/services/dependencies.py`
- `app/services/event_service.py`
- `app/services/notification_service.py`
- `app/services/otp_service.py`
- `app/services/protocols.py`
- `app/services/realtime_service.py`
- `app/services/signal_types.py`
- `app/services/weather_service.py`
- `app/services/zone_resolver.py`
- `app/tasks/__init__.py`
- `app/tasks/background_scheduler.py`
- `app/tasks/claim_processor.py`
- `app/tasks/premium_recalculator.py`
- `app/utils/__init__.py`
- `app/utils/crypto.py`
- `app/utils/geo_utils.py`
- `app/utils/logger.py`
- `app/utils/validators.py`
- `scripts/set_admin_user.py`
- `tests/test_cpcb_aqi.py`

### `SafeNetFresh/`

- `App.js`
- `index.js`
- `app.json`
- `babel.config.js`
- `metro.config.js`
- `package.json`
- `package-lock.json`
- `.gitignore`
- `assets/adaptive-icon.png`
- `assets/favicon.png`
- `assets/icon.png`
- `assets/splash-icon.png`
- `components/DisruptionModal.js`
- `components/LocationGate.js`
- `components/NotificationInitializer.js`
- `components/PolicyBootstrap.js`
- `components/PremiumDueModal.js`
- `components/WebSocketBridge.js`
- `contexts/AuthContext.js`
- `contexts/ClaimContext.js`
- `contexts/PolicyContext.js`
- `hooks/useActiveClaims.js`
- `hooks/usePayoutHistory.js`
- `hooks/usePoolHealth.js`
- `hooks/useWorkerProfile.js`
- `screens/ClaimsScreen.js`
- `screens/DashboardScreen.js`
- `screens/OnboardingScreen.js`
- `screens/OTPVerifyScreen.js`
- `screens/PolicyScreen.js`
- `screens/ProfileScreen.js`
- `screens/ProfileSetupScreen.js`
- `screens/SplashScreen.js`
- `services/api.js`
- `services/device_fingerprint.service.js`
- `services/location.service.js`
- `services/navigationService.js`
- `services/notification.service.js`
- `services/tokenStore.js`
- `services/websocket.service.js`

---

## How the pieces connect (quick reference)

- **Backend entry:** `safenet_v2/backend/app/main.py` — mounts REST v1 routes, middleware, health, WebSockets.
- **Worker mobile API client:** `SafeNetFresh/services/api.js` — JWT, retries, base URL from `app.json` / Constants.
- **Live updates:** `SafeNetFresh/services/websocket.service.js` and `safenet_v2/admin/src/services/admin_websocket.ts` talk to `app/api/v1/routes/websockets.py` via Redis pub/sub (`app/services/realtime_service.py`).
- **Domain logic:** `app/engines/*` (confidence, fraud layers, premium ML, payout, etc.) with `app/services/*` for external data.
- **Persistence:** SQLAlchemy models under `app/models/`, Alembic migrations under `app/db/migrations/versions/` and mirrored `alembic/versions/` for discovery.

---

## Regenerating the file list

From the repo root (PowerShell), you can refresh a full list (still excluding heavy folders):

```powershell
Get-ChildItem -Path . -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch 'node_modules|\\.git|__pycache__|\\.expo|dist\\|\\.venv' } |
  ForEach-Object { $_.FullName.Substring((Get-Location).Path.Length + 1) } |
  Sort-Object
```

---

*Generated for the ALPHA workspace layout. Adjust paths if you add new packages or split services.*
