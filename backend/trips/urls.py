from django.urls import path

from . import views

urlpatterns = [
    path("plan-trip/", views.PlanTripView.as_view(), name="plan-trip"),
    path("trips/<uuid:trip_id>/", views.TripDetailView.as_view(), name="trip-detail"),
    path("geocode/search/", views.GeocodeSearchView.as_view(), name="geocode-search"),
    path("geocode/reverse/", views.GeocodeReverseView.as_view(), name="geocode-reverse"),
    path("health/", views.HealthView.as_view(), name="health"),
]
