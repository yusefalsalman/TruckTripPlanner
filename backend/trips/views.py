import logging

from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import TripPlan
from .serializers import PlanTripRequestSerializer
from .services import geocoding
from .services.geocoding import GeocodingError
from .services.hos_scheduler import HOSError
from .services.routing import RoutingError
from .services.trip_planner import plan_trip, resolve_location

logger = logging.getLogger(__name__)


def _error(message: str, code: int, **extra) -> Response:
    return Response({"error": message, **extra}, status=code)


class PlanTripView(APIView):
    """
    POST /api/plan-trip/

    Body::

        {
          "current_location":  {"lat": 32.78, "lon": -96.80, "label": "Dallas, TX"},
          "pickup_location":   "Oklahoma City, OK",
          "dropoff_location":  {"query": "Denver, CO"},
          "current_cycle_used": 12.5,
          "start_time": "2026-10-05T08:00"
        }
    """

    def post(self, request):
        serializer = PlanTripRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return _error("Invalid trip details.", status.HTTP_400_BAD_REQUEST,
                          details=serializer.errors)
        data = serializer.validated_data

        try:
            current = resolve_location(data["current_location"])
            pickup = resolve_location(data["pickup_location"])
            dropoff = resolve_location(data["dropoff_location"])
        except GeocodingError as exc:
            return _error(str(exc), status.HTTP_400_BAD_REQUEST)

        try:
            plan = plan_trip(current, pickup, dropoff,
                             data["current_cycle_used"], data["start_time"])
        except RoutingError as exc:
            return _error(str(exc), status.HTTP_502_BAD_GATEWAY)
        except HOSError as exc:
            return _error(str(exc), status.HTTP_400_BAD_REQUEST)

        trip = TripPlan.objects.create(
            current_label=current.label[:300],
            pickup_label=pickup.label[:300],
            dropoff_label=dropoff.label[:300],
            current_cycle_used=data["current_cycle_used"],
            start_time=data["start_time"],
            total_miles=plan["summary"]["total_miles"],
            total_days=plan["summary"]["total_days"],
            compliant=plan["summary"]["compliant"],
            result=plan,
        )
        return Response({"id": str(trip.id), "inputs": {
            "current_cycle_used": data["current_cycle_used"],
            "start_time": data["start_time"].isoformat(timespec="minutes"),
        }, **plan}, status=status.HTTP_201_CREATED)


class TripDetailView(APIView):
    """GET /api/trips/<uuid>/ - re-open a previously generated plan."""

    def get(self, request, trip_id):
        trip = get_object_or_404(TripPlan, pk=trip_id)
        return Response({"id": str(trip.id), "inputs": {
            "current_cycle_used": trip.current_cycle_used,
            "start_time": trip.start_time.isoformat(timespec="minutes"),
        }, **trip.result})


class GeocodeSearchView(APIView):
    """GET /api/geocode/search/?q=Dallas - place suggestions for the form."""

    def get(self, request):
        query = request.query_params.get("q", "").strip()
        if len(query) < 2:
            return _error("Type at least 2 characters.", status.HTTP_400_BAD_REQUEST)
        try:
            return Response({"results": geocoding.search(query, limit=5)})
        except GeocodingError as exc:
            return _error(str(exc), status.HTTP_502_BAD_GATEWAY)


class GeocodeReverseView(APIView):
    """GET /api/geocode/reverse/?lat=..&lon=.. - label for a map click."""

    def get(self, request):
        try:
            lat = float(request.query_params["lat"])
            lon = float(request.query_params["lon"])
        except (KeyError, ValueError):
            return _error("lat and lon query parameters are required.", status.HTTP_400_BAD_REQUEST)
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return _error("Coordinates are out of range.", status.HTTP_400_BAD_REQUEST)
        try:
            place = geocoding.reverse(lat, lon)
        except GeocodingError as exc:
            return _error(str(exc), status.HTTP_502_BAD_GATEWAY)
        if not place:
            place = {"lat": lat, "lon": lon, "label": f"{lat:.4f}, {lon:.4f}", "display_name": ""}
        return Response(place)


class HealthView(APIView):
    """GET /api/health/ - used by Render health checks (and to wake the dyno)."""

    def get(self, request):
        return Response({"status": "ok"})
