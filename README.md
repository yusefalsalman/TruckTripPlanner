# HOS Trip Planner · FMCSA ELD Log Generator

Plan a property-carrying truck trip (current → pickup → dropoff) and get:

- an **interactive route map** (OpenStreetMap + Leaflet + OSRM) with markers for the start, pickup, 30-min breaks, 10-hr sleeper rests, fuel stops, 34-hr restarts and dropoff;
- **FMCSA Driver's Daily Log sheets**, one per calendar day, with the 24-hour duty-status graph, remarks (City, ST at every status change), per-status totals that sum to exactly 24.00 h, and a 70-hr / 8-day recap. You can page through the days and print or save the sheets as PDF.

```
TruckTripPlanner/
├── backend/                     Django 5 + DRF API
│   ├── config/                  settings (env driven), urls, wsgi
│   └── trips/
│       ├── services/
│       │   ├── hos_scheduler.py HOS engine + day splitter + independent validator (pure Python)
│       │   ├── routing.py       OSRM client, per-leg distances, point-at-mile interpolation
│       │   ├── geocoding.py     Nominatim search/reverse, cached + 1 req/s throttle
│       │   └── trip_planner.py  orchestration → API payload (stops, logs, summary)
│       ├── models.py            TripPlan (persisted result, shareable by id)
│       ├── serializers.py, views.py, urls.py
│       └── tests/               boundary tests, 400-trip randomized property test, API tests
├── frontend/                    React 19 + Vite + Tailwind v4 + React-Leaflet + lucide-react
│   └── src/components/
│       ├── TripForm.jsx         search / map-pick / drag pins, cycle + departure inputs
│       ├── RouteMap.jsx         route polyline, stop markers, popups, auto-fit, pick mode
│       ├── TripSummary.jsx      compliance badge, stats, cycle bar, itinerary
│       ├── LogBook.jsx          day pagination, driver/carrier details, print
│       ├── LogSheet.jsx         full paper-style daily log page
│       └── LogSheetGrid.jsx     SVG 24-hour duty-status grid
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
python manage.py test trips       # 41 tests
```

**Frontend** (Node 20.19+):

```bash
cd frontend
npm install
npm run dev                       # http://localhost:5173  (talks to http://localhost:8000)
```

Click **Sample** to fill in a Dallas → Oklahoma City → Denver trip, then **Plan trip**.

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

Each location can be given as coordinates (from a map click or a picked search result), as `{"query": ...}`, or as a plain string. The response (`201`) contains `locations`, `route` (geometry and legs), `stops`, `logs` (one entry per day, with segments, totals, remarks and recap) and `summary` (miles, hours, counts, `compliant`, `violations`). The plan is also saved, so `GET /api/trips/<id>/` re-opens it; the UI keeps that id in `?trip=` so you can share the link.

Helper endpoints used by the form: `GET /api/geocode/search/?q=`, `GET /api/geocode/reverse/?lat=&lon=`, `GET /api/health/`.

## HOS rules and assumptions

| Rule | How the engine applies it |
|---|---|
| 11-hr driving limit | Max 11 h of driving per duty period. |
| 14-hr window | No driving after hour 14 from the first on-duty activity. |
| 30-min break | Required after 8 h of cumulative driving. Any ≥ 30 consecutive non-driving minutes count (2020 rule), so the 1-hr pickup resets it. The inserted break is logged as **Off Duty**. |
| 10-hr rest | Logged as **Sleeper Berth**. Resets the 11/14-hr clocks. |
| 70-hr / 8-day | On-duty hours are added to `current_cycle_used`. If the cycle runs out, a **34-hr restart** is inserted. Prior cycle hours are assumed not to roll off during the trip, which is the conservative choice. |
| Fuel | 30 min On Duty at least every 1,000 driven miles. The truck starts with a full tank. |
| Pickup / dropoff | 1 hr On Duty (not driving) each. |
| Driving time | OSRM uses a car profile, so each leg is slowed to at most **55 mph** (`TRUCK_MAX_AVG_SPEED_MPH`). |
| Time grid | Everything is computed in integer minutes on a 15-minute grid, the resolution of the paper graph. Departure rounds down to the quarter hour and leg durations round up. That is why each day totals exactly 24.00. |
| Calendar days | Midnight → departure and dropoff → midnight are logged as Off Duty. Times are home-terminal wall-clock time. |

`validate_schedule()` re-derives every clock from the finished schedule, independently of the scheduler's own bookkeeping, and drives the compliance badge. The randomized test runs 400 trips through it.

## Deploy

### Backend → Render
1. Push the repo to GitHub, then in Render choose **New → Blueprint** and select the repo (`render.yaml` is picked up).
2. Set `CORS_ALLOWED_ORIGINS` to your Vercel URL, e.g. `https://your-app.vercel.app`. Preview deploys on `*.vercel.app` are already allowed by `CORS_ALLOWED_ORIGIN_REGEXES`.
3. Optional: set `NOMINATIM_EMAIL` (recommended by the Nominatim usage policy).

SQLite on Render's free plan is ephemeral, so saved plans (`/api/trips/<id>/`) are lost on redeploy. Plan generation itself is stateless.

### Frontend → Vercel
1. Import the repo with **Root Directory = `frontend`**. The framework is detected as Vite and `vercel.json` handles SPA rewrites.
2. Set the environment variable `VITE_API_BASE_URL=https://<your-render-service>.onrender.com`.
3. Deploy. The app pings `/api/health/` on load to wake a sleeping free-tier dyno.

## Notes
- Searching is explicit (Enter or the search button) because Nominatim's policy forbids search-as-you-type. Uncached reverse lookups for remarks are capped per trip (`REVERSE_GEOCODE_MAX_LOOKUPS`). A cross-country plan takes about 15–25 s the first time and is near-instant once cached.
- Remarks between towns use the place OSM reports for that point, which may be a county (e.g. "Gray County, TX").
- This is a planning aid, not a certified ELD.
