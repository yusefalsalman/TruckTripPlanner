"""API tests with the external services (Nominatim, OSRM) mocked out."""
from unittest import mock

from django.test import TestCase
from rest_framework.test import APIClient

from trips.models import TripPlan
from trips.services.routing import Route, RouteLeg, RouteStep, _build_cumulative, _build_steps

DALLAS = (32.7767, -96.7970)
OKC = (35.4676, -97.5164)
DENVER = (39.7392, -104.9903)


def fake_route(waypoints, labels=None):
    coords = [tuple(w) for w in waypoints]
    steps = [RouteStep("Head north on I-35", "I-35", "depart", "", 206.0, 3 * 3600, *coords[0]),
             RouteStep("Arrive at pickup", "", "arrive", "", 0.0, 0, *coords[1])]
    legs = [RouteLeg(miles=206.0, seconds=3 * 3600, steps=steps),
            RouteLeg(miles=620.0, seconds=9 * 3600)]
    return Route(legs=legs, coordinates=coords,
                 cumulative_miles=_build_cumulative(coords, legs, coords))


def fake_reverse(lat, lon):
    return f"Town {lat:.1f}, ST"


@mock.patch("trips.services.trip_planner.geocoding.try_reverse_label", side_effect=fake_reverse)
@mock.patch("trips.services.trip_planner.geocoding.is_cached_reverse", return_value=False)
@mock.patch("trips.services.trip_planner.routing.get_route", side_effect=fake_route)
class PlanTripApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.payload = {
            "current_location": {"lat": DALLAS[0], "lon": DALLAS[1], "label": "Dallas, TX"},
            "pickup_location": {"lat": OKC[0], "lon": OKC[1], "label": "Oklahoma City, OK"},
            "dropoff_location": {"lat": DENVER[0], "lon": DENVER[1], "label": "Denver, CO"},
            "current_cycle_used": 10,
            "start_time": "2026-10-05T08:00",
        }

    def test_plan_trip_success(self, *_):
        resp = self.client.post("/api/plan-trip/", self.payload, format="json")
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertTrue(body["summary"]["compliant"], body["summary"]["violations"])
        self.assertAlmostEqual(body["summary"]["total_miles"], 826.0, places=1)
        self.assertEqual(body["stops"][0]["type"], "start")
        self.assertIn("pickup", [s["type"] for s in body["stops"]])
        self.assertEqual(body["stops"][-1]["type"], "dropoff")
        for log in body["logs"]:
            self.assertEqual(log["total_hours"], 24.0)
            self.assertAlmostEqual(sum(log["totals"].values()), 24.0, places=6)
            self.assertTrue(log["remarks"])
        self.assertEqual(body["logs"][0]["date"], "2026-10-05")
        self.assertEqual(TripPlan.objects.count(), 1)

        detail = self.client.get(f"/api/trips/{body['id']}/")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["summary"], body["summary"])

    def test_directions_included_with_mile_markers(self, *_):
        body = self.client.post("/api/plan-trip/", self.payload, format="json").json()
        steps = body["route"]["legs"][0]["steps"]
        self.assertEqual([s["instruction"] for s in steps], ["Head north on I-35", "Arrive at pickup"])
        self.assertEqual([s["mile"] for s in steps], [0.0, 206.0])

    def test_recap_accumulates_cycle(self, *_):
        body = self.client.post("/api/plan-trip/", self.payload, format="json").json()
        first = body["logs"][0]["recap"]
        self.assertEqual(first["cycle_at_start_of_day"], 10.0)
        self.assertAlmostEqual(first["total_last_8_days"], 10.0 + first["on_duty_today"])
        self.assertAlmostEqual(first["available_tomorrow"], 70 - first["total_last_8_days"])

    def test_validation_errors(self, *_):
        bad = {**self.payload, "current_cycle_used": 71}
        resp = self.client.post("/api/plan-trip/", bad, format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("current_cycle_used", resp.json()["details"])

        bad = {**self.payload, "pickup_location": {"label": "nowhere"}}
        resp = self.client.post("/api/plan-trip/", bad, format="json")
        self.assertEqual(resp.status_code, 400)

        bad = {**self.payload, "start_time": "tomorrow-ish"}
        resp = self.client.post("/api/plan-trip/", bad, format="json")
        self.assertEqual(resp.status_code, 400)

    @mock.patch("trips.services.trip_planner.geocoding.geocode",
                return_value={"lat": OKC[0], "lon": OKC[1], "label": "Oklahoma City, OK"})
    def test_text_location_is_geocoded(self, geocode, *_):
        payload = {**self.payload, "pickup_location": "Oklahoma City"}
        resp = self.client.post("/api/plan-trip/", payload, format="json")
        self.assertEqual(resp.status_code, 201, resp.content)
        geocode.assert_called_once_with("Oklahoma City")
        self.assertEqual(resp.json()["locations"]["pickup"]["label"], "Oklahoma City, OK")

    def test_routing_failure_is_502(self, get_route, *_):
        from trips.services.routing import RoutingError
        get_route.side_effect = RoutingError("No drivable route connects these locations.")
        resp = self.client.post("/api/plan-trip/", self.payload, format="json")
        self.assertEqual(resp.status_code, 502)
        self.assertIn("No drivable route", resp.json()["error"])


class RouteGeometryTests(TestCase):
    def test_point_at_interpolates_and_scales(self):
        coords = [(0.0, 0.0), (0.0, 1.0), (0.0, 2.0)]
        legs = [RouteLeg(100, 0), RouteLeg(100, 0)]
        route = Route(legs, coords, _build_cumulative(coords, legs, coords))
        self.assertEqual(route.cumulative_miles, [0.0, 100.0, 200.0])
        lat, lon = route.point_at(50)
        self.assertAlmostEqual(lon, 0.5)
        self.assertEqual(route.point_at(500), (0.0, 2.0))

    def test_simplified_keeps_endpoints(self):
        coords = [(0.0, i / 1000) for i in range(10_001)]
        legs = [RouteLeg(1, 0), RouteLeg(1, 0)]
        route = Route(legs, coords, [0.0] * len(coords))
        simple = route.simplified(100)
        self.assertLessEqual(len(simple), 102)
        self.assertEqual(simple[0], [0.0, 0.0])
        self.assertEqual(simple[-1], [0.0, 10.0])


class MiscEndpointTests(TestCase):
    def test_health(self):
        self.assertEqual(self.client.get("/api/health/").json(), {"status": "ok"})

    def test_reverse_requires_coords(self):
        self.assertEqual(self.client.get("/api/geocode/reverse/").status_code, 400)

    @mock.patch("trips.views.geocoding.search", return_value=[{"lat": 1, "lon": 2, "label": "X"}])
    def test_search(self, _):
        resp = self.client.get("/api/geocode/search/?q=Dallas")
        self.assertEqual(resp.json()["results"][0]["label"], "X")


def _osrm_step(kind, modifier="", name="", ref="", meters=1609.344, **extra):
    maneuver = {"type": kind, "location": [-97.0, 35.0], **extra.pop("maneuver", {})}
    if modifier:
        maneuver["modifier"] = modifier
    return {"maneuver": maneuver, "name": name, "ref": ref, "distance": meters, "duration": 60, **extra}


class InstructionTests(TestCase):
    def texts(self, raw):
        return [s.instruction for s in _build_steps(raw, "dropoff: Denver, CO")]

    def test_common_maneuvers(self):
        raw = [
            _osrm_step("depart", name="Main Street", maneuver={"bearing_after": 0}),
            _osrm_step("turn", "left", name="Elm Street"),
            _osrm_step("on ramp", "slight right", ref="I 35"),
            _osrm_step("fork", "slight left", name="Interstate 35", ref="I 35"),
            _osrm_step("off ramp", "right", exits="214A", destinations="I 35E North, Downtown"),
            _osrm_step("roundabout", "right", name="Oak Avenue", maneuver={"exit": 2}),
            _osrm_step("end of road", "sharp right", name="Pine Road"),
            _osrm_step("arrive", meters=0),
        ]
        self.assertEqual(self.texts(raw), [
            "Head north on Main Street",
            "Turn left onto Elm Street",
            "Take the ramp onto I-35",
            "Keep left at the fork onto Interstate 35 (I-35)",
            "Take exit 214A toward I-35E North, Downtown",
            "At the roundabout, take the 2nd exit onto Oak Avenue",
            "Turn right at the end of the road onto Pine Road",
            "Arrive at dropoff: Denver, CO",
        ])

    def test_same_road_continuations_are_merged(self):
        raw = [
            _osrm_step("depart", name="I 40", maneuver={"bearing_after": 90}),
            _osrm_step("new name", name="I 40"),
            _osrm_step("continue", "straight", name="I 40"),
            _osrm_step("new name", name="Route 66"),
        ]
        steps = _build_steps(raw, "x")
        self.assertEqual([s.instruction for s in steps], ["Head east on I 40", "Continue onto Route 66"])
        self.assertAlmostEqual(steps[0].miles, 3.0)

    def test_renamed_stretches_of_same_highway_are_merged(self):
        raw = [
            _osrm_step("depart", name="Main St", maneuver={"bearing_after": 180}),
            _osrm_step("merge", "right", name="Stemmons Fwy", ref="I 35E"),
            _osrm_step("new name", name="Veterans Memorial Hwy", ref="I 35E;US 77"),
            _osrm_step("new name", name="Kansas Turnpike", ref="I 35"),
        ]
        steps = _build_steps(raw, "x")
        self.assertEqual([s.instruction for s in steps], [
            "Head south on Main St",
            "Merge right onto Stemmons Fwy (I-35E)",
            "Continue onto Kansas Turnpike (I-35)",
        ])
        self.assertAlmostEqual(steps[1].miles, 2.0)
