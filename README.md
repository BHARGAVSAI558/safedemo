# 🛡️ SafeNet — AI Income Protection for Gig Workers

> **Guidewire DevTrails 2026 — Phase 3 Final** | Team AlphaNexus
>
> *"SafeNet doesn't ask you to prove anything. It proves it for you."*

---

## 🚀 Live Demo — Try It Now

| | URL |
|--|--|
| 📱 **Worker App** | **[https://safenet-sage.vercel.app](https://safenet-sage.vercel.app)** |
| 🔗 **Unified Entry** | **[https://safenet-admin-wine.vercel.app/login](https://safenet-admin-wine.vercel.app/login)** |
| 🖥️ **Admin Dashboard** | **[https://safenet-admin-wine.vercel.app/admin-login](https://safenet-admin-wine.vercel.app/admin-login)** |
| ⚙️ **Backend API** | [https://safenet-api-y4se.onrender.com](https://safenet-api-y4se.onrender.com) |
| ❤️ **Health Check** | [https://safenet-api-y4se.onrender.com/health](https://safenet-api-y4se.onrender.com/health) |
| 💻 **GitHub** | [devtrails-2026-alphanexus-phase2](https://github.com/BHARGAVSAI558/devtrails-2026-alphanexus-phase2) |

---

## ⚡ 2-Minute Judge Demo Flow

### As a Worker (phone or browser):

1. Open **[https://safenet-sage.vercel.app](https://safenet-sage.vercel.app)**
2. Enter any 10-digit mobile number → OTP shown on screen → enter it
3. Select platform (Zomato / Swiggy / Zepto) → search your delivery area or tap GPS → coverage tier
4. Dashboard shows **live weather**, **real AQI**, **your Earnings DNA heatmap**, and zone risk
5. Tap **"Simulate disruption"** → pick Heavy Rain → watch the 6-step claim pipeline execute live → see payout amount credited

### As an Admin (same time, on laptop):

1. Open **[https://safenet-admin-wine.vercel.app/admin-login](https://safenet-admin-wine.vercel.app/admin-login)**
2. Login: `admin` / `admin123`
3. Watch the claim from step 5 above arrive **live in the dashboard feed** via WebSocket — no refresh needed

---

## 💡 The Problem We Solve

India has 15M+ platform delivery workers (Zomato, Swiggy, Zepto, Amazon, Blinkit). They earn per trip, not per month. When external disruptions hit, they have no fallback:

| Disruption | Impact |
|-----------|--------|
| Heavy rain | Roads unsafe, order cancellations surge |
| Extreme heat >42°C | Health risk, forced to go offline |
| AQI >300 | Hazardous outdoor exposure |
| Curfews / strikes | Zone completely locked |
| Platform outages | Zero orders despite availability |

Traditional insurance ignores them. Government schemes exclude informal workers. Every existing system either demands proof the worker cannot provide, or pays a flat amount disconnected from their actual loss.

---

## 🎯 What SafeNet Does Differently

```
Every other system:   disruption happens → pay a fixed flat amount
SafeNet:              learn each worker's earning reality → pay what they actually lost
```

**The core insight:** Ravi works Thursday evenings and earns ₹87/hour during that window. When flooding hits at 8 PM Thursday, the right payout is ₹87 × disruption hours — not a generic ₹500 everyone gets. SafeNet builds this personal earning fingerprint automatically from the worker's own history.

---

## 🧬 Earnings DNA — Core Innovation

Every worker gets a personal 7×24 earning matrix that captures their real income pattern by day and hour.

```
           6A  8A  10A  12P  2P  4P  6P  8P  10P
Monday   [ ░   ▒   ▒   ▓   ▓   ▒   ▒   ▓   ▒  ]
Tuesday  [ ░   ▒   ▒   ▓   ▓   ▒   ▓   █   ▒  ]
Wednesday[ ░   ▒   ▒   ▓   ▒   ▒   ▒   ▓   ▒  ]
Thursday [ ░   ▒   ▒   ▓   ▓   ▒   ▓   █   ▓  ] ← Peak 7–10 PM
Friday   [ ░   ▒   ▒   ▓   ▓   ▒   ▓   █   ▒  ]
Saturday [ ░   ▒   ▓   █   ▓   ▒   ▓   █   ▒  ]
Sunday   [ ░   ▒   ▓   █   █   ▒   ▒   ▓   ░  ] ← Peak 12–2 PM

░ low   ▒ medium   ▓ high   █ peak
```

**Payout formula:** `DNA hourly rate × disruption hours × coverage multiplier`, capped at tier maximum.

For new workers: zone baseline rates apply (₹80–₹120/hr by risk level) until enough claim history accumulates.

**What the worker sees on their dashboard:**
- Live demand level: High / Moderate / Low for current hour
- Expected earnings: ₹85–₹110/hr right now in your zone
- Next peak window prediction
- Weekly progress: ₹649 / ₹8,929 expected this week

---

## 🛡️ Forecast Shield — Proactive Protection

SafeNet checks the 48-hour weather forecast every 6 hours. When elevated risk is predicted, coverage auto-upgrades **before** the disruption hits — at no extra cost to the worker.

```
18 hours before:
  System detects heavy rain predicted tomorrow 3 PM–7 PM (82% confidence)
  Action: coverage tier auto-upgraded to Pro for that window
  Worker notified: "Forecast Shield Active — you're already protected"

During disruption:
  Payout calculated at upgraded Pro tier automatically
  Message: "SafeNet predicted this 18 hours ago and upgraded your cover"
```

This is the opposite of how traditional insurance works. Protection upgrades itself.

---

## 🔄 Zero-Touch Claim Pipeline

No forms. No proof. No calls. The worker does nothing.

```
Background Scheduler (every 30 min, 6 AM–11 PM IST)
         │
         ▼
Confidence Engine — Weather + AQI + Social alerts → HIGH / MIXED / LOW
         │ HIGH
         ▼
Behavioral Engine — GPS trail vs baseline → deviation score 0–100
         │ deviation > threshold
         ▼
Fraud Pipeline — 4 layers → CLEAN / FLAGGED / BLOCK
         │ CLEAN
         ▼
Decision Engine — All signals + trust score → APPROVE / REJECT
         │ APPROVE
         ▼
Payout Engine — DNA-based calculation → ₹ amount determined
         │
         ▼
Razorpay payout recorded + WebSocket push to worker app + admin dashboard
```

**What the worker sees in real time:**

```
Disruption Detected ● → Verifying Signals ● → Fraud Check ● → Decision ● → ₹ Credited ●
```

Each step updates live on screen. Zero action required.

---

## 🕵️ 4-Layer Fraud Engine

Stops coordinated spoofing rings before any payout is processed.

```
LAYER 4 — Enrollment Timing Anomaly
  Mass sign-ups detected before a predicted storm → elevated scrutiny applied
              ↓
LAYER 1 — GPS Signal Integrity
  Teleportation check (3 km in 20 sec?)
  Static spoof check (variance exactly zero = machine GPS)
  Cell tower mismatch validation
              ↓
LAYER 2 — Cross-Signal Corroboration (4 independent signals)
  S1: Is worker GPS inside disrupted zone?
  S2: Do weather/AQI APIs confirm active disruption?
  S3: Is app activity low/absent (not working)?
  S4: Did platform order volume drop in this zone?
  4/4 → APPROVE · 3/4 → APPROVE · 2/4 → FLAG · 1/4 → BLOCK
              ↓
LAYER 3 — Fraud Ring Detection
  Zone density spike (8+ flagged claims in 1 hour)
  Timestamp synchrony (5+ submissions within 3 minutes)
  Pattern homogeneity (identical inactivity durations)
  → CONFIRMED ring → freeze cluster payouts → admin alert
```

**Honest-worker-first principle:** 3 of 4 signals still approves. A temporary API delay should never punish a genuine worker. SafeNet delays before it denies.

---

## 📍 Location System

Workers search any place in India (powered by Nominatim / OpenStreetMap — no API key restrictions) or use device GPS. Location is reverse-geocoded and matched to the nearest SafeNet zone using the Haversine formula. Works anywhere in India, not just preset cities.

- Search "Gachibowli" → suggestions appear as you type → select → zone + risk level shown instantly
- "Detect my location" → device GPS → reverse geocode → zone assigned
- If no zone found within 50 km: nearest available zone auto-assigned with a notification

---

## 💬 Support Assistant — Multilingual

Floating assistant accessible from every screen with no navigation required.

- **Predefined queries:** Why didn't I get paid? What is my claim status? Is there a disruption now?
- **Raise Ticket:** generates unique ticket ID (TKT-000001), tracked in admin queue
- **Languages:** English / हिंदी / తెలుగు — all built-in, no external translation API
- **Voice input:** browser Speech Recognition (Chrome/Edge on web); expo-speech-recognition on native; graceful text fallback in Expo Go
- **Admin reply loop:** admin responds from dashboard → reply pushed to worker's chat via WebSocket → notification triggered

---

## 🖥️ Admin Dashboard

| Page | What it shows |
|------|--------------|
| Dashboard | Live KPIs: active workers, claims today, fraud blocked, pool utilization %, weekly premiums collected vs paid out |
| Zone Heatmap | All zones on map — color by risk level, size by worker count, click for zone stats |
| Fraud Insights | Fraud queue with layer breakdown, score distribution chart, enrollment vs weather signal timeline |
| Workers | Searchable registry — trust score, tier, premium, claims count, fraud flags; click any worker for full profile + claim history |
| Simulations | Run any disruption scenario from admin side and inspect pipeline outcomes |
| Support | All user tickets with admin reply interface, resolve/open status toggle, multilingual messages |

---

## 💰 Bank & UPI Payout Details

Workers add their bank account (holder name, IFSC, account number) or UPI ID in their Profile. Claims screen includes a quick "View bank details" shortcut. Approved payouts are recorded via Razorpay test mode and linked to the claim record with payout ID and status.

---

## 🏗️ Architecture

```
┌──────────────────────────┐    ┌──────────────────────────┐
│   Worker App             │    │   Admin Dashboard         │
│   safenet-sage.vercel.app│    │   safenet-admin-wine      │
│                          │    │   .vercel.app             │
│  React Native + Expo Web │    │   React + TypeScript      │
│  WebSocket client        │    │   WebSocket client        │
└──────────┬───────────────┘    └──────────┬────────────────┘
           │ HTTPS + WSS                   │ HTTPS + WSS
           └──────────────┬────────────────┘
                          ▼
           ┌──────────────────────────────┐
           │   FastAPI Backend            │
           │   safenet-api-y4se.onrender  │
           │                              │
           │  /api/v1/auth  /api/v1/zones │
           │  /api/v1/workers             │
           │  /api/v1/policies            │
           │  /api/v1/claims              │
           │  /ws/worker/{id}  /ws/admin  │
           └──┬────────────┬─────────────┘
              │            │
        ┌─────▼──┐   ┌─────▼──────────────────┐
        │Postgres│   │ External APIs           │
        │        │   │ OpenWeatherMap (live)   │
        │Workers │   │ OpenAQ (live AQI)       │
        │Policies│   │ Razorpay (test mode)    │
        │Claims  │   │ APScheduler (30-min)    │
        └────────┘   └────────────────────────┘
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Worker App | React Native, Expo, Expo Web |
| Admin Dashboard | React, Vite, TypeScript, Tailwind CSS, Recharts, Leaflet |
| Backend | FastAPI, Python, SQLAlchemy, Alembic, PostgreSQL |
| ML | XGBoost, scikit-learn — dynamic premium model |
| Real-time | WebSockets, Redis pub/sub |
| Location | Nominatim / OpenStreetMap (search + reverse geocode), expo-location (GPS) |
| External APIs | OpenWeatherMap (weather + forecast), OpenAQ (live AQI), Razorpay test |
| Background Jobs | APScheduler — zone polling every 30 min, 6 AM–11 PM IST |
| Deployment | Render (backend + PostgreSQL), Vercel (admin + worker web app) |
| i18n | LocalizationContext + locales/en.json, hi.json, te.json |

---

## ✅ What's Real vs Simulated

| Component | Status | Detail |
|-----------|--------|--------|
| Weather data | ✅ Live | OpenWeatherMap API — real current readings |
| AQI data | ✅ Live | OpenAQ API — real PM2.5 values |
| Location search | ✅ Real | Nominatim — works anywhere in India |
| GPS detection | ✅ Real | Device GPS + reverse geocode + zone mapping |
| OTP system | ✅ Real (demo-safe) | Random 6-digit OTP shown on screen |
| Fraud engine | ✅ Fully coded | All 4 layers execute on every claim |
| ML premium | ✅ Real model | XGBoost trained on risk features |
| WebSockets | ✅ Real | Live bidirectional push updates |
| Earnings DNA | ✅ Real | Computed from claim history + zone baselines |
| Forecast Shield | ✅ Real | 48-hour forecast from OpenWeatherMap |
| Multilingual | ✅ Real | Built-in EN / HI / TE — no translation API |
| Payouts | ✅ Real logic | DNA formula + Razorpay test-mode records |
| Payment collection | 🔶 Test mode | Razorpay Checkout in test — no real money |

---

## 📱 Worker App — Access Options

**Browser (no install):** [https://safenet-sage.vercel.app](https://safenet-sage.vercel.app) — works on any phone or desktop

**Expo Go (native):** Install Expo Go → scan QR or open:
```
exp://u.expo.dev/2d45889e-9415-4966-be7f-ba2711a57f13/group/278ac272-c5ef-40dc-beb2-25d1c58cae8e
```

**Local run:**
```bash
git clone https://github.com/BHARGAVSAI558/devtrails-2026-alphanexus-phase2
cd devtrails-2026-alphanexus-phase2/SafeNetFresh
npm install && npm start
```

---

## 📁 Project Structure

```
devtrails-2026-alphanexus-phase2/
│
├── SafeNetFresh/                    ← Expo app (mobile + web)
│   ├── screens/                     ← Onboarding, Dashboard, Claims,
│   │                                   Coverage, Account, Support flows
│   ├── components/                  ← AppModal, AssistantModal,
│   │                                   WebSocketBridge, LocationGate
│   ├── contexts/                    ← Auth, Claims, Policy,
│   │                                   Localization, WebSocket
│   ├── locales/                     ← en.json, hi.json, te.json
│   ├── services/                    ← api.js, websocket,
│   │                                   notifications, fingerprint
│   ├── utils/                       ← i18n, Razorpay checkout,
│   │                                   location display, IST formatting
│   └── hooks/                       ← worker profile, GPS zone,
│                                       payouts, DNA
│
└── safenet_v2/
    ├── backend/                     ← FastAPI (Render)
    │   └── app/
    │       ├── engines/             ← confidence, fraud (L1–L4),
    │       │                           premium, payout, behavioral
    │       ├── services/            ← weather, AQI, OTP, realtime,
    │       │                           notifications
    │       ├── models/              ← PostgreSQL schemas
    │       ├── tasks/               ← APScheduler background jobs
    │       └── ml/                  ← XGBoost premium model
    │
    └── admin/                       ← React dashboard (Vercel)
        └── src/
            ├── pages/               ← Dashboard, Zones, Fraud,
            │                           Workers, Simulations, Support
            ├── stores/              ← Zustand real-time state
            └── services/            ← WebSocket admin feed
```

---

## 🚀 Local Development

### Backend
```bash
cd safenet_v2/backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
# Health: http://127.0.0.1:8000/health
```

### Admin Dashboard
```bash
cd safenet_v2/admin
npm install && npm run dev
# http://localhost:5173 — login: admin / admin123
```

### Worker App
```bash
cd SafeNetFresh
npm install
npm start                  # Expo Go via QR (LAN)
npm run start:tunnel       # Phone on cellular / different network
npx expo start --web       # Browser at http://localhost:8081
```

### Environment Variables (backend)
```env
JWT_SECRET=your-secret
ADMIN_JWT_SECRET=your-admin-secret
OPENWEATHER_API_KEY=your-key
DEMO_MODE=false
ALLOWED_ORIGINS=*
DATABASE_URL=postgresql+asyncpg://user:pass@host/dbname
```

---

*DevTrails 2026 — Team AlphaNexus*