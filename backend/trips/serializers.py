from datetime import datetime

from rest_framework import serializers


class LocationInputSerializer(serializers.Serializer):
    """
    A location is either coordinates (from a map click or a picked search
    result) or a free-text query that the backend geocodes. A bare string is
    accepted as shorthand for ``{"query": "..."}``.
    """

    query = serializers.CharField(required=False, allow_blank=True, max_length=300)
    label = serializers.CharField(required=False, allow_blank=True, max_length=300)
    lat = serializers.FloatField(required=False, allow_null=True, min_value=-90, max_value=90)
    lon = serializers.FloatField(required=False, allow_null=True, min_value=-180, max_value=180)

    def to_internal_value(self, data):
        if isinstance(data, str):
            data = {"query": data}
        return super().to_internal_value(data)

    def validate(self, attrs):
        has_coords = attrs.get("lat") is not None and attrs.get("lon") is not None
        if not has_coords and not (attrs.get("query") or "").strip():
            raise serializers.ValidationError("Provide a place name or pick a point on the map.")
        return attrs


class PlanTripRequestSerializer(serializers.Serializer):
    current_location = LocationInputSerializer()
    pickup_location = LocationInputSerializer()
    dropoff_location = LocationInputSerializer()
    current_cycle_used = serializers.FloatField(min_value=0, max_value=70)
    # Departure in the driver's home-terminal time, e.g. "2026-10-05T08:00".
    # Any UTC offset is ignored: log sheets are kept in wall-clock time.
    start_time = serializers.CharField(required=False, allow_blank=True, max_length=40)

    def validate_start_time(self, value):
        if not value:
            return datetime.now().replace(hour=8, minute=0, second=0, microsecond=0)
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise serializers.ValidationError("Use ISO format, e.g. 2026-10-05T08:00.") from exc
        return parsed.replace(tzinfo=None, second=0, microsecond=0)

