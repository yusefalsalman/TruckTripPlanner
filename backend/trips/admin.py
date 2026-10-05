from django.contrib import admin

from .models import TripPlan


@admin.register(TripPlan)
class TripPlanAdmin(admin.ModelAdmin):
    list_display = ("created_at", "current_label", "pickup_label", "dropoff_label",
                    "total_miles", "total_days", "compliant")
    list_filter = ("compliant",)
    readonly_fields = ("id", "created_at")
