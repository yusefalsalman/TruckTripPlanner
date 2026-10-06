"""
OSRM routing client.

Returns per-leg distance/duration, turn-by-turn instructions and the full
route polyline, and offers ``Route.point_at(mile)`` to place stops (breaks,
fuel, rests) at their exact position along the road.

OSRM returns structured maneuvers (type + modifier + road), not sentences, so
``_instruction`` turns each step into readable English.
"""
from __future__ import annotations

import bisect
import hashlib
import math
import re
from dataclasses import dataclass, field

import requests
from django.conf import settings
from django.core.cache import cache

METERS_PER_MILE = 1609.344
REQUEST_TIMEOUT_SECONDS = 30
CACHE_TTL_SECONDS = 6 * 3600


class RoutingError(Exception):
    """Raised when no route can be produced."""


def haversine_miles(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 3958.7613 * math.asin(math.sqrt(h))


@dataclass
class RouteStep:
    instruction: str
    road: str
    maneuver: str  # OSRM maneuver type, e.g. "turn", "off ramp", "arrive"
    modifier: str  # e.g. "left", "slight right", "uturn" ("" when n/a)
    miles: float  # distance driven *after* this maneuver
    seconds: float
    lat: float  # where the maneuver happens
    lon: float


@dataclass
class RouteLeg:
    miles: float
    seconds: float
    steps: list[RouteStep] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# Turn-by-turn instructions
# --------------------------------------------------------------------------- #
_COMPASS = ("north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest")
_CONTINUE_TYPES = {"new name", "continue", "notification"}


def _interstates(text: str) -> str:
    """'I 35E' -> 'I-35E' (the usual way interstates are written)."""
    return re.sub(r"\bI (\d+)", r"I-\1", re.sub(r"\s+", " ", text))


def _ref(step: dict) -> str:
    """Route numbers, e.g. 'I-35 / US 77' (OSRM gives 'I 35;US 77')."""
    return _interstates((step.get("ref") or "").replace(";", " / ").strip())


def _primary_ref(step: dict) -> str:
    return _ref(step).split(" / ")[0]


def _road(step: dict) -> str:
    """Prefer 'Name (I-35)' style labels; either part may be missing."""
    ref = _ref(step)
    name = (step.get("name") or "").strip()
    if ref and name and ref not in name:
        return f"{name} ({ref})"
    return name or ref


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _side(modifier: str) -> str:
    return "left" if "left" in modifier else "right" if "right" in modifier else "straight"


def _instruction(step: dict, arrive_label: str) -> str:
    """Readable sentence for one OSRM step."""
    m = step.get("maneuver", {})
    kind, mod = m.get("type", ""), m.get("modifier", "")
    road = _road(step)
    onto = f" onto {road}" if road else ""
    toward = _interstates((step.get("destinations") or "").strip())

    if kind == "depart":
        heading = _COMPASS[round((m.get("bearing_after") or 0) / 45) % 8]
        return f"Head {heading}" + (f" on {road}" if road else "")
    if kind == "arrive":
        return f"Arrive at {arrive_label}"
    if kind in ("roundabout", "rotary", "roundabout turn"):
        exit_no = m.get("exit")
        return (f"At the roundabout, take the {_ordinal(exit_no)} exit{onto}"
                if exit_no else f"Enter the roundabout{onto}")
    if kind in ("exit roundabout", "exit rotary"):
        return f"Exit the roundabout{onto}"
    if kind == "off ramp":
        exits = (step.get("exits") or "").split(";")[0].strip()
        text = "Take exit " + exits if exits else "Take the exit"
        return text + (f" toward {toward}" if toward else onto)
    if kind == "on ramp":
        return f"Take the ramp{onto}" + (f" toward {toward}" if toward and not road else "")
    if kind == "merge":
        return f"Merge {_side(mod)}{onto}" if mod else f"Merge{onto}"
    if kind == "fork":
        return f"Keep {_side(mod)} at the fork{onto}"
    if kind == "end of road":
        return f"Turn {_side(mod)} at the end of the road{onto}"
    if kind in _CONTINUE_TYPES or mod == "straight":
        return f"Continue{onto}" if road else "Continue straight"
    if mod == "uturn":
        return f"Make a U-turn{onto}"
    if mod:
        return f"Turn {mod}{onto}"
    return f"Continue{onto}"


def _build_steps(raw_steps: list[dict], arrive_label: str) -> list[RouteStep]:
    """Convert OSRM steps, folding 'continue on the same road' noise into the previous step."""
    steps: list[RouteStep] = []
    prev_ref = ""
    for raw in raw_steps:
        m = raw.get("maneuver", {})
        kind = m.get("type", "")
        road = _road(raw)
        ref = _primary_ref(raw)
        miles = raw.get("distance", 0.0) / METERS_PER_MILE
        seconds = float(raw.get("duration", 0.0))
        # Same road, or just a renamed stretch of the same highway number
        # (memorial highway names change every few miles).
        same_road = not road or road == (steps[-1].road if steps else None) or (ref and ref == prev_ref)
        prev_ref = ref or prev_ref if kind in _CONTINUE_TYPES else ref
        if steps and kind in _CONTINUE_TYPES and same_road:
            steps[-1].miles += miles
            steps[-1].seconds += seconds
            continue
        lon, lat = m.get("location", (0.0, 0.0))
        steps.append(RouteStep(
            instruction=_instruction(raw, arrive_label), road=road, maneuver=kind,
            modifier=m.get("modifier", ""), miles=miles, seconds=seconds, lat=lat, lon=lon,
        ))
    return steps


@dataclass
class Route:
    legs: list[RouteLeg]
    coordinates: list[tuple[float, float]]  # (lat, lon), full resolution
    cumulative_miles: list[float]  # same length as coordinates

    @property
    def total_miles(self) -> float:
        return sum(leg.miles for leg in self.legs)

    @property
    def total_seconds(self) -> float:
        return sum(leg.seconds for leg in self.legs)

    def point_at(self, mile: float) -> tuple[float, float]:
        """Interpolated (lat, lon) ``mile`` miles from the route start."""
        cum = self.cumulative_miles
        if len(cum) == 1 or mile <= 0:
            return self.coordinates[0]
        if mile >= cum[-1]:
            return self.coordinates[-1]
        i = bisect.bisect_right(cum, mile)
        lo, hi = cum[i - 1], cum[i]
        f = 0.0 if hi == lo else (mile - lo) / (hi - lo)
        (lat1, lon1), (lat2, lon2) = self.coordinates[i - 1], self.coordinates[i]
        return lat1 + (lat2 - lat1) * f, lon1 + (lon2 - lon1) * f

    def simplified(self, max_points: int) -> list[list[float]]:
        """Uniformly down-sampled polyline for the browser ([lat, lon] pairs)."""
        coords = self.coordinates
        if len(coords) <= max_points:
            picked = coords
        else:
            step = math.ceil(len(coords) / max_points)
            picked = coords[::step]
            if picked[-1] != coords[-1]:
                picked = [*picked, coords[-1]]
        return [[round(lat, 5), round(lon, 5)] for lat, lon in picked]


def _nearest_index(coords: list[tuple[float, float]], target: tuple[float, float], start: int) -> int:
    best_i, best_d = start, float("inf")
    for i in range(start, len(coords)):
        d = haversine_miles(coords[i], target)
        if d < best_d:
            best_i, best_d = i, d
            if d < 1e-4:  # the geometry passes exactly through snapped waypoints
                break
    return best_i


def _build_cumulative(coords, legs, waypoint_locs) -> list[float]:
    """
    Cumulative mileage per vertex, scaled per leg so that the polyline length
    matches OSRM's official leg distance exactly.
    """
    # Vertex index of every waypoint (start, intermediate..., end)
    split = [0]
    for loc in waypoint_locs[1:-1]:
        split.append(_nearest_index(coords, loc, split[-1]))
    split.append(len(coords) - 1)

    cumulative = [0.0] * len(coords)
    offset = 0.0
    for leg_i, leg in enumerate(legs):
        a, b = split[leg_i], split[leg_i + 1]
        raw = [0.0]
        for i in range(a + 1, b + 1):
            raw.append(raw[-1] + haversine_miles(coords[i - 1], coords[i]))
        scale = leg.miles / raw[-1] if raw[-1] > 0 else 0.0
        for k, i in enumerate(range(a, b + 1)):
            cumulative[i] = offset + raw[k] * scale
        offset += leg.miles
    # Guarantee monotonicity for bisect (OSRM rounding can create tiny dips).
    for i in range(1, len(cumulative)):
        cumulative[i] = max(cumulative[i], cumulative[i - 1])
    return cumulative


def get_route(waypoints: list[tuple[float, float]], labels: list[str] | None = None) -> Route:
    """
    Driving route through ``waypoints`` given as (lat, lon) tuples.
    ``labels`` (one per waypoint) name the arrival in each leg's last instruction.
    """
    if len(waypoints) < 2:
        raise RoutingError("At least two waypoints are required.")

    labels = labels or [f"waypoint {i + 1}" for i in range(len(waypoints))]
    key = "route:v2:" + hashlib.sha1(
        (";".join(f"{lat:.5f},{lon:.5f}" for lat, lon in waypoints) + "|" + "|".join(labels)).encode()
    ).hexdigest()
    cached = cache.get(key)
    if cached is not None:
        return cached

    coord_str = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in waypoints)
    url = f"{settings.OSRM_BASE_URL.rstrip('/')}/route/v1/driving/{coord_str}"
    params = {"overview": "full", "geometries": "geojson", "steps": "true", "alternatives": "false"}
    try:
        response = requests.get(url, params=params, timeout=REQUEST_TIMEOUT_SECONDS,
                                headers={"User-Agent": settings.NOMINATIM_USER_AGENT})
    except requests.RequestException as exc:
        raise RoutingError("The routing service is unreachable. Try again shortly.") from exc

    try:
        data = response.json()
    except ValueError as exc:
        raise RoutingError(f"The routing service returned HTTP {response.status_code}.") from exc

    if data.get("code") != "Ok" or not data.get("routes"):
        code = data.get("code", f"HTTP {response.status_code}")
        if code in ("NoRoute", "NoSegment"):
            raise RoutingError("No drivable route connects these locations.")
        raise RoutingError(f"The routing service could not build a route ({code}).")

    best = data["routes"][0]
    legs = [RouteLeg(miles=leg["distance"] / METERS_PER_MILE, seconds=float(leg["duration"]),
                     steps=_build_steps(leg.get("steps", []), labels[i + 1]))
            for i, leg in enumerate(best["legs"])]
    coords = [(lat, lon) for lon, lat in best["geometry"]["coordinates"]]
    if not coords:
        coords = [waypoints[0], waypoints[-1]]
    waypoint_locs = [(wp["location"][1], wp["location"][0]) for wp in data["waypoints"]]

    route = Route(legs=legs, coordinates=coords,
                  cumulative_miles=_build_cumulative(coords, legs, waypoint_locs))
    cache.set(key, route, CACHE_TTL_SECONDS)
    return route
