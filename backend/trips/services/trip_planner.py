"""
Trip planning orchestrator.

Glues the three services together and shapes the API payload:

    geocoded locations --> OSRM route --> HOS schedule --> day logs, stops, summary

The HOS engine works in "schedule miles" (distance actually driven); this
module maps those miles onto the route polyline to place every stop on the
map and to label every duty-status change with a "City, ST" remark.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, time, timedelta

from django.conf import settings

from . import geocoding, routing
from .hos_scheduler import (
    ACT_BREAK, ACT_DROPOFF, ACT_FUEL, ACT_PICKUP, ACT_PRE_TRIP_OFF,
    ACT_REST, ACT_RESTART, DRIVING, MINUTES_PER_DAY, ON_DUTY, STATUSES, HOSScheduler, Leg,
    split_into_days, validate_schedule,
)

logger = logging.getLogger(__name__)

STOP_ACTIVITIES = (ACT_PICKUP, ACT_DROPOFF, ACT_BREAK, ACT_REST, ACT_FUEL, ACT_RESTART)
FIXED_LABEL_TOLERANCE_MILES = 0.5


@dataclass
class Place:
    lat: float
    lon: float
    label: str


def _hours(minutes: float) -> float:
    return round(minutes / 60.0, 2)


def _clock(minute_of_day: int) -> str:
    return f"{minute_of_day // 60:02d}:{minute_of_day % 60:02d}"


class _Labeler:
    """
    Resolves schedule-mile positions to 'City, ST' labels.

    The trip endpoints reuse the user's own labels; everything else is reverse
    geocoded (cached, and capped at ``REVERSE_GEOCODE_MAX_LOOKUPS`` uncached
    calls per trip so a cross-country plan still answers quickly).
    """

    def __init__(self, route: routing.Route, to_route_mile, fixed: list[tuple[float, str]]):
        self.route = route
        self.to_route_mile = to_route_mile
        self.fixed = fixed
        self.cache: dict[float, str] = {}
        self.lookups_left = settings.REVERSE_GEOCODE_MAX_LOOKUPS

    def point(self, mile: float) -> tuple[float, float]:
        return self.route.point_at(self.to_route_mile(mile))

    def label(self, mile: float) -> str:
        for fixed_mile, text in self.fixed:
            if abs(mile - fixed_mile) <= FIXED_LABEL_TOLERANCE_MILES:
                return text
        key = round(mile, 1)
        if key in self.cache:
            return self.cache[key]

        lat, lon = self.point(mile)
        text = None
        if self.lookups_left > 0 or geocoding.is_cached_reverse(lat, lon):
            if not geocoding.is_cached_reverse(lat, lon):
                self.lookups_left -= 1
            text = geocoding.try_reverse_label(lat, lon)
        if not text:
            text = f"Mile {mile:,.0f} ({lat:.3f}, {lon:.3f})"
        self.cache[key] = text
        return text


def resolve_location(data: dict) -> Place:
    """Accept either coordinates (+ optional label) or a free-text query."""
    if data.get("lat") is not None and data.get("lon") is not None:
        lat, lon = float(data["lat"]), float(data["lon"])
        label = (data.get("label") or "").strip()
        if not label:
            label = geocoding.try_reverse_label(lat, lon) or f"{lat:.4f}, {lon:.4f}"
        return Place(lat, lon, label)
    place = geocoding.geocode(data["query"])
    return Place(place["lat"], place["lon"], place["label"])


def plan_trip(current: Place, pickup: Place, dropoff: Place,
              cycle_used_hours: float, start_time: datetime) -> dict:
    # ---- 1. Route ------------------------------------------------------------
    route = routing.get_route([(current.lat, current.lon),
                               (pickup.lat, pickup.lon),
                               (dropoff.lat, dropoff.lon)])
    legs = [Leg.from_route(leg.miles, leg.seconds, settings.TRUCK_MAX_AVG_SPEED_MPH)
            for leg in route.legs]

    # ---- 2. HOS schedule -----------------------------------------------------
    start_minute = start_time.hour * 60 + start_time.minute
    result = HOSScheduler(legs, cycle_used_hours, start_minute).run()
    days = split_into_days(result)
    violations = validate_schedule(result)
    day_zero = datetime.combine(start_time.date(), time.min)

    def at(minute: int) -> str:
        return (day_zero + timedelta(minutes=minute)).isoformat(timespec="minutes")

    # Legs shorter than 0.1 mi are scheduled as zero miles; shift schedule
    # miles so they still line up with the polyline.
    leg0_offset = 0.0 if legs[0].miles else route.legs[0].miles

    def to_route_mile(mile: float) -> float:
        return mile + leg0_offset

    pickup_mile, dropoff_mile = legs[0].miles, legs[0].miles + legs[1].miles
    labeler = _Labeler(route, to_route_mile, [
        (0.0, current.label), (pickup_mile, pickup.label), (dropoff_mile, dropoff.label),
    ])

    # ---- 3. Stops (map markers) ----------------------------------------------
    stops = [{
        "type": "start", "label": current.label, "lat": current.lat, "lon": current.lon,
        "mile": 0.0, "arrival": None, "departure": at(result.start_minute),
        "duration_minutes": 0, "day": result.start_minute // MINUTES_PER_DAY + 1,
        "note": "Trip start",
    }]
    for seg in result.segments:
        if seg.activity not in STOP_ACTIVITIES:
            continue
        if seg.activity == ACT_PICKUP:
            lat, lon, label = pickup.lat, pickup.lon, pickup.label
        elif seg.activity == ACT_DROPOFF:
            lat, lon, label = dropoff.lat, dropoff.lon, dropoff.label
        else:
            (lat, lon), label = labeler.point(seg.start_mile), labeler.label(seg.start_mile)
        stops.append({
            "type": seg.activity, "label": label, "lat": round(lat, 6), "lon": round(lon, 6),
            "mile": round(seg.start_mile, 1), "arrival": at(seg.start), "departure": at(seg.end),
            "duration_minutes": seg.minutes, "day": seg.start // MINUTES_PER_DAY + 1,
            "note": seg.note,
        })

    # ---- 4. Daily logs ---------------------------------------------------------
    logs = []
    for day in days:
        remarks = []
        for seg in day.segments:
            if seg.is_continuation:
                continue
            if seg.activity == ACT_PICKUP:
                location = pickup.label
            elif seg.activity == ACT_DROPOFF:
                location = dropoff.label
            elif seg.activity == ACT_PRE_TRIP_OFF:
                location = current.label
            else:
                location = labeler.label(seg.start_mile)
            remarks.append({
                "minute": seg.start, "time": _clock(seg.start), "status": seg.status,
                "activity": seg.activity, "location": location, "note": seg.note,
            })

        cycle_total = day.cycle_end_minutes
        logs.append({
            "day": day.day_index + 1,
            "date": (day_zero + timedelta(days=day.day_index)).date().isoformat(),
            "from": labeler.label(day.start_mile),
            "to": labeler.label(day.end_mile),
            "miles_driven": round(day.miles_driven, 1),
            "segments": [{
                "status": s.status, "start": s.start, "end": s.end,
                "activity": s.activity, "note": s.note,
            } for s in day.segments],
            "totals": {status: _hours(m) for status, m in day.minutes_by_status.items()},
            "total_hours": _hours(sum(day.minutes_by_status.values())),
            "remarks": remarks,
            "recap": {
                "on_duty_today": _hours(day.on_duty_minutes),
                "cycle_at_start_of_day": _hours(day.cycle_start_minutes),
                "total_last_8_days": _hours(cycle_total),
                "available_tomorrow": _hours(max(0.0, 70 * 60 - cycle_total)),
                "restart_taken": any(s.activity == ACT_RESTART for s in day.segments),
            },
        })

    # ---- 5. Summary ----------------------------------------------------------
    totals = result.minutes_by_status()
    summary = {
        "total_miles": round(result.total_miles, 1),
        "route_miles": round(route.total_miles, 1),
        "total_days": result.total_days,
        "start_time": at(result.start_minute),
        "end_time": at(result.end_minute),
        "trip_duration_hours": _hours(result.end_minute - result.start_minute),
        "driving_hours": _hours(totals[DRIVING]),
        "on_duty_not_driving_hours": _hours(totals[ON_DUTY]),
        "on_duty_hours": _hours(totals[DRIVING] + totals[ON_DUTY]),
        "rest_hours": _hours(sum(totals[s] for s in STATUSES if s not in (DRIVING, ON_DUTY))),
        "breaks": result.count(ACT_BREAK),
        "rests": result.count(ACT_REST),
        "fuel_stops": result.count(ACT_FUEL),
        "restarts": result.restarts,
        "cycle_used_start_hours": _hours(result.cycle_used_start_minutes),
        "cycle_used_end_hours": _hours(result.cycle_used_end_minutes),
        "cycle_available_end_hours": _hours(70 * 60 - result.cycle_used_end_minutes),
        "average_speed_mph": round(
            result.total_miles / (totals[DRIVING] / 60), 1) if totals[DRIVING] else 0.0,
        "compliant": not violations,
        "violations": violations,
    }

    return {
        "locations": {
            "current": vars(current), "pickup": vars(pickup), "dropoff": vars(dropoff),
        },
        "route": {
            "distance_miles": round(route.total_miles, 1),
            "duration_hours": round(route.total_seconds / 3600, 2),
            "geometry": route.simplified(settings.ROUTE_MAX_POINTS),
            "legs": [{
                "from": a.label, "to": b.label,
                "distance_miles": round(r.miles, 1),
                "router_duration_hours": round(r.seconds / 3600, 2),
                "scheduled_driving_hours": _hours(leg.minutes),
            } for (a, b), r, leg in zip(((current, pickup), (pickup, dropoff)), route.legs, legs)],
        },
        "stops": stops,
        "logs": logs,
        "summary": summary,
    }
