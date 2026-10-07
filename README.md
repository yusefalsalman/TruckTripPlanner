# HOS Trip Planner · FMCSA ELD Log Generator

Plan a property-carrying truck trip (current location → pickup → dropoff) that follows the FMCSA hours-of-service rules, and get a route map, turn-by-turn directions, and filled-in **Driver's Daily Log** sheets for every day of the trip.

**Live app:** https://truck-trip-planner-ten.vercel.app
**API health:** https://truck-trip-planner-api.onrender.com/api/health/
The free Render server sleeps when idle, so the first request can take up to a minute.

---

## Features

**Inputs**
- Current location, pickup, dropoff and current cycle used (hours), plus a departure time.
- Each location can be searched by name, picked by clicking the map, or adjusted by dragging its pin.
- **Sample** fills in a Dallas → Oklahoma City → Denver trip.

**Outputs**
- **Route map** (OpenStreetMap + Leaflet + OSRM) with a distinct marker for each stop: start, pickup, 30-min break, 10-hr sleeper rest, fuel stop, 34-hr restart and dropoff. Clicking a marker shows its arrival and departure times.
- **Trip summary**: an HOS compliance badge, miles, days, driving hours, arrival time, 70-hr cycle usage and a stop-by-stop itinerary.
- **Turn-by-turn directions** for each leg (e.g. "Take exit 42 toward I-135"). The planned breaks, rests and fuel stops appear at the mile where they happen.
- **Driver's Daily Log sheets**, one per calendar day, in the official paper format:
  - the 24-hour graph grid with a continuous duty-status line across Off Duty, Sleeper Berth, Driving and On Duty;
  - per-status totals that always sum to exactly **24.00** hours;
  - remarks with City, ST at every change of duty status;
  - the 70-hour / 8-day recap;
  - day-by-day navigation, and **Print / Save as PDF** for one day or all days.
- **Shareable plans:** every plan is saved, and the `?trip=<id>` URL re-opens it.
- Responsive layout that works on phones.

## Tech stack

| Layer | Tools |
|---|---|
| Backend | Python, **Django 5**, **Django REST Framework**, django-cors-headers, SQLite |
| Frontend | **React 19**, Vite, Tailwind CSS v4, React-Leaflet, lucide-react |
| Maps & routing | OpenStreetMap tiles, **OSRM** (routing and directions), **Nominatim** (geocoding). All free, no API keys. |
| Log sheets | SVG, so they stay sharp when printed |
| Hosting | **Vercel** (frontend), **Render** (API) |

## How it works

```
Trip form ──► POST /api/plan-trip/
                 │
                 ├─ 1. Geocode the locations         (Nominatim, cached, 1 req/s)
                 ├─ 2. Route + turn-by-turn steps     (OSRM)
                 ├─ 3. HOS scheduler                  drive in the longest legal chunk, then insert
                 │                                    the break / rest / fuel / restart the rule needs
                 ├─ 4. Independent validator          re-checks every rule → compliance badge
                 ├─ 5. Split into calendar days       segments, totals, remarks, recap
                 └─ 6. Save the plan, return JSON
                 ▼
Map · Summary · Directions · Daily log sheets
```

## Project structure

```
TruckTripPlanner/
├── backend/                     Django + DRF API
│   ├── config/                  settings (environment-driven), urls, wsgi
│   └── trips/
│       ├── services/
│       │   ├── hos_scheduler.py HOS engine, day splitter, independent validator (pure Python)
│       │   ├── routing.py       OSRM client, turn-by-turn text, point-at-mile interpolation
│       │   ├── geocoding.py     Nominatim search and reverse lookup, cached and throttled
│       │   └── trip_planner.py  orchestration → API payload (stops, logs, directions, summary)
│       ├── models.py            TripPlan (saved result, shareable by id)
│       ├── serializers.py, views.py, urls.py
│       └── tests/               boundary tests, 400-trip randomized test, API tests
├── frontend/                    React + Vite
│   ├── src/components/
│   │   ├── TripForm.jsx         search / map-pick / drag pins, cycle and departure inputs
│   │   ├── RouteMap.jsx         route line, stop markers, popups, auto-fit, pick mode
│   │   ├── TripSummary.jsx      compliance badge, stats, cycle bar, itinerary / directions tabs
│   │   ├── Directions.jsx       turn-by-turn instructions with HOS stops in place
│   │   ├── LogBook.jsx          day pagination, driver/carrier details, print
│   │   ├── LogSheet.jsx         full paper-style daily log page
│   │   └── LogSheetGrid.jsx     SVG 24-hour duty-status grid
│   ├── src/lib/                 API client, constants, formatting helpers
│   └── vercel.json              Vercel build and SPA rewrites
└── render.yaml                  Render blueprint for the API
```

## Run locally

**Backend** (Python 3.12+):

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver        # http://localhost:8000
```

**Frontend** (Node 20.19+), in a second terminal:

```bash
cd frontend
npm install
npm run dev                       # http://localhost:5173
```

Open http://localhost:5173, click **Sample**, then **Plan trip**.

**Using different ports:** the frontend calls `http://localhost:8000` by default. To run the API elsewhere (e.g. `runserver 8001`), create `frontend/.env.development.local` containing `VITE_API_BASE_URL=http://localhost:8001`. The file is git-ignored. Vite uses the `PORT` environment variable if set. In development, the API accepts requests from any `localhost` port.

**Tests:**

```bash
cd backend
python manage.py test trips       # 45 tests
```

## Example trips

| Trip | Cycle used | Result |
|---|---|---|
| Dallas, TX → Oklahoma City, OK → Denver, CO (**Sample**) | 12 h | ~885 mi, 2 log days, one 10-hr rest |
| Chicago, IL → St. Louis, MO → Los Angeles, CA | 30 h | ~2,125 mi, 5 log days, fuel stops, a 30-min break, rests, and a 34-hr restart when the cycle runs out |

## API

`POST /api/plan-trip/`

```json
{
  "current_location":  {"lat": 32.7767, "lon": -96.797, "label": "Dallas, TX"},
  "pickup_location":   "Oklahoma City, OK",
  "dropoff_location":  {"query": "Denver, CO"},
  "current_cycle_used": 12,
  "start_time": "2026-10-05T08:00"
}
```

Each location can be coordinates (from a map click or a picked search result), `{"query": ...}`, or a plain string. The `201` response contains:

- `locations`
- `route`: geometry, plus legs that each carry turn-by-turn `steps`
- `stops`
- `logs`: one entry per day, with segments, totals, remarks and recap
- `summary`: miles, hours, stop counts, `compliant`, `violations`

`GET /api/trips/<id>/` re-opens a saved plan. Helper endpoints used by the form: `GET /api/geocode/search/?q=`, `GET /api/geocode/reverse/?lat=&lon=`, `GET /api/health/`.

## HOS rules and assumptions

Property-carrying driver, 70 hours / 8 days, no adverse driving conditions.

| Rule | How the engine applies it |
|---|---|
| 11-hr driving limit | Max 11 h of driving per duty period. |
| 14-hr window | No driving after hour 14 from the first on-duty activity. |
| 30-min break | Required after 8 h of cumulative driving. Any ≥ 30 consecutive non-driving minutes count (2020 rule), so the 1-hr pickup resets it. Inserted breaks are logged as **Off Duty**. |
| 10-hr rest | Logged as **Sleeper Berth**. Resets the 11- and 14-hr clocks. |
| 70-hr / 8-day | On-duty hours are added to `current_cycle_used`. If the cycle runs out, a **34-hr restart** is inserted. Prior cycle hours are assumed not to roll off during the trip, which is the conservative choice. |
| Fuel | 30 min On Duty at least every 1,000 driven miles. The truck starts with a full tank. |
| Pickup / dropoff | 1 hr On Duty (not driving) each. |
| Driving time | OSRM uses a car profile, so each leg's average speed is capped at **55 mph** (`TRUCK_MAX_AVG_SPEED_MPH`). |
| Time grid | Everything is computed in whole minutes on a 15-minute grid, the resolution of the paper graph. That is why each day totals exactly 24.00. |
| Calendar days | Midnight → departure and dropoff → midnight are logged as Off Duty. Times are home-terminal time. |

`validate_schedule()` re-derives every clock from the finished schedule, independently of the scheduler's own bookkeeping, and drives the compliance badge. The randomized test runs 400 trips through it.

## Deploy

### Backend → Render
1. In Render choose **New → Blueprint** and select this repo. `render.yaml` sets the build (`bash build.sh`), start command, health check and environment.
2. Set `CORS_ALLOWED_ORIGINS` to the Vercel URL, e.g. `https://truck-trip-planner-ten.vercel.app`. Other `*.vercel.app` preview URLs are already allowed by `CORS_ALLOWED_ORIGIN_REGEXES`.
3. Optional: set `NOMINATIM_EMAIL`, which the Nominatim usage policy recommends.

| Variable | Value |
|---|---|
| `DJANGO_DEBUG` | `false` |
| `DJANGO_SECRET_KEY` | generated by Render |
| `CORS_ALLOWED_ORIGINS` | your Vercel URL |
| `CORS_ALLOWED_ORIGIN_REGEXES` | `^https://.*\.vercel\.app$` |
| `PYTHON_VERSION` | `3.12.8` |

SQLite on Render's free plan is wiped on every redeploy or restart, so old `?trip=` links stop working then. Planning new trips is unaffected.

### Frontend → Vercel
1. Import the repo with **Root Directory = `frontend`**. Vite is detected automatically and `vercel.json` handles SPA rewrites.
2. Set `VITE_API_BASE_URL` to the Render URL, e.g. `https://truck-trip-planner-api.onrender.com` (no trailing slash).
3. Deploy. The app calls `/api/health/` on load to wake the sleeping free-tier server.

Every push to `main` redeploys both services.

## Notes
- Place search runs when you press Enter or the search button, not as you type, because Nominatim's usage policy forbids search-as-you-type.
- A cross-country plan takes about 15–25 s the first time while stops are labelled with city names, and is near-instant once cached. Uncached reverse lookups are capped per trip (`REVERSE_GEOCODE_MAX_LOOKUPS`).
- Stops between towns use the place OSM reports for that point, which may be a county (e.g. "Gray County, TX").
- This is a planning aid, not a certified ELD.
