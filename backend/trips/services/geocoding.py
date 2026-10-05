"""
OpenStreetMap Nominatim client (forward search + reverse lookup).

* Responses are cached (Django cache) so repeated lookups are free.
* Calls are serialised and spaced >= 1 s apart to honour the Nominatim usage
  policy (https://operations.osmfoundation.org/policies/nominatim/).
* Labels are normalised to the "City, ST" form used in log-sheet remarks.
"""
from __future__ import annotations

import hashlib
import logging
import threading
import time

import requests
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 7 * 24 * 3600
REQUEST_TIMEOUT_SECONDS = 10

_throttle_lock = threading.Lock()
_last_request_at = 0.0


class GeocodingError(Exception):
    """Raised when a location cannot be resolved or the service fails."""


def _request(path: str, params: dict) -> object:
    """GET a Nominatim endpoint, globally throttled to the policy rate."""
    global _last_request_at
    params = {**params, "format": "jsonv2", "addressdetails": 1}
    if settings.NOMINATIM_EMAIL:
        params["email"] = settings.NOMINATIM_EMAIL
    headers = {"User-Agent": settings.NOMINATIM_USER_AGENT, "Accept-Language": "en"}
    url = f"{settings.NOMINATIM_BASE_URL.rstrip('/')}/{path}"

    with _throttle_lock:
        wait = settings.NOMINATIM_MIN_INTERVAL_SECONDS - (time.monotonic() - _last_request_at)
        if wait > 0:
            time.sleep(wait)
        try:
            response = requests.get(url, params=params, headers=headers,
                                    timeout=REQUEST_TIMEOUT_SECONDS)
        except requests.RequestException as exc:
            raise GeocodingError("The geocoding service is unreachable. Try again shortly.") from exc
        finally:
            _last_request_at = time.monotonic()

    if response.status_code == 429:
        raise GeocodingError("The geocoding service is rate limiting requests. Try again in a moment.")
    if not response.ok:
        raise GeocodingError(f"The geocoding service returned HTTP {response.status_code}.")
    try:
        return response.json()
    except ValueError as exc:
        raise GeocodingError("The geocoding service returned an invalid response.") from exc


def _state_code(address: dict) -> str:
    """'US-TX' -> 'TX'; falls back to the full state/province name."""
    iso = address.get("ISO3166-2-lvl4") or address.get("ISO3166-2-lvl3") or ""
    if "-" in iso:
        return iso.split("-", 1)[1]
    return address.get("state") or address.get("province") or address.get("region") or ""


def short_label(address: dict | None, fallback: str = "") -> str:
    """Format a Nominatim ``address`` dict as 'City, ST'."""
    address = address or {}
    city = next(
        (address[k] for k in ("city", "town", "village", "hamlet", "municipality",
                              "suburb", "county") if address.get(k)),
        "",
    )
    state = _state_code(address)
    label = ", ".join(part for part in (city, state) if part)
    if label:
        return label
    return fallback.split(",")[0].strip() if fallback else "Unknown location"


def _to_place(item: dict) -> dict:
    display = item.get("display_name", "")
    return {
        "lat": float(item["lat"]),
        "lon": float(item["lon"]),
        "label": short_label(item.get("address"), display),
        "display_name": display,
    }


def search(query: str, limit: int = 5) -> list[dict]:
    """Forward geocode free text into up to ``limit`` candidate places."""
    query = (query or "").strip()
    if len(query) < 2:
        return []
    key = "geo:search:" + hashlib.sha1(f"{query.lower()}|{limit}".encode()).hexdigest()
    cached = cache.get(key)
    if cached is not None:
        return cached

    params = {"q": query, "limit": limit}
    if settings.GEOCODE_COUNTRY_CODES:
        params["countrycodes"] = settings.GEOCODE_COUNTRY_CODES
    data = _request("search", params)
    places = [_to_place(item) for item in data if "lat" in item and "lon" in item]
    cache.set(key, places, CACHE_TTL_SECONDS)
    return places


def geocode(query: str) -> dict:
    """Resolve free text to the single best match or raise ``GeocodingError``."""
    places = search(query, limit=1)
    if not places:
        raise GeocodingError(f'Could not find a location matching "{query}".')
    return places[0]


def reverse(lat: float, lon: float, zoom: int = 10) -> dict | None:
    """
    Reverse geocode a coordinate. ``zoom=10`` returns the nearest city/town,
    which is what a driver writes in the Remarks section.
    Returns ``None`` when nothing is found (e.g. open ocean).
    """
    key = f"geo:rev:{lat:.3f}:{lon:.3f}:{zoom}"
    cached = cache.get(key)
    if cached is not None:
        return cached or None  # "" marks a cached miss

    data = _request("reverse", {"lat": f"{lat:.6f}", "lon": f"{lon:.6f}", "zoom": zoom})
    if not isinstance(data, dict) or "error" in data or "lat" not in data:
        cache.set(key, "", CACHE_TTL_SECONDS)
        return None
    place = _to_place(data)
    # Keep the clicked coordinate rather than the snapped place centroid.
    place.update(lat=lat, lon=lon)
    cache.set(key, place, CACHE_TTL_SECONDS)
    return place


def try_reverse_label(lat: float, lon: float) -> str | None:
    """Best-effort reverse lookup that never raises (used for remarks)."""
    try:
        place = reverse(lat, lon)
    except GeocodingError as exc:
        logger.warning("Reverse geocode failed for %.4f,%.4f: %s", lat, lon, exc)
        return None
    return place["label"] if place else None


def is_cached_reverse(lat: float, lon: float, zoom: int = 10) -> bool:
    return cache.get(f"geo:rev:{lat:.3f}:{lon:.3f}:{zoom}") is not None
