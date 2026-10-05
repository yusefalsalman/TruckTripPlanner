import uuid

from django.db import models


class TripPlan(models.Model):
    """A generated trip plan, persisted so it can be re-opened by id."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)

    current_label = models.CharField(max_length=300)
    pickup_label = models.CharField(max_length=300)
    dropoff_label = models.CharField(max_length=300)
    current_cycle_used = models.FloatField(help_text="Hours already used in the 70-hr/8-day cycle")
    start_time = models.DateTimeField(help_text="Departure, home-terminal local time")

    total_miles = models.FloatField()
    total_days = models.PositiveIntegerField()
    compliant = models.BooleanField(default=True)

    result = models.JSONField(help_text="Full API payload: route, stops, logs, summary")

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.current_label} -> {self.pickup_label} -> {self.dropoff_label}"
