import { useEffect, useMemo, useRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import L from 'leaflet'
import {
  MapContainer, Marker, Polyline, Popup, TileLayer, ZoomControl, useMap, useMapEvents,
} from 'react-leaflet'
import { Crosshair, X } from 'lucide-react'
import { STOP_TYPES, WAYPOINTS } from '../lib/constants'
import { fmtDateTime, fmtDuration, fmtNumber } from '../lib/format'

const US_CENTER = [39.5, -98.35]
const WAYPOINT_TYPES = new Set(['start', 'pickup', 'dropoff'])

// ---------------------------------------------------------------------------
// Marker icons: Lucide SVGs rendered once, at module load, into Leaflet
// divIcons. (Rendering outside React's render phase keeps flushSync legal and
// avoids shipping react-dom/server to the browser.)
// ---------------------------------------------------------------------------
function toHtml(element) {
  const container = document.createElement('div')
  const root = createRoot(container)
  flushSync(() => root.render(element))
  const html = container.innerHTML
  root.unmount()
  return html
}

/** Teardrop pin for the three draggable waypoints. */
function buildPinIcon(type) {
  const { Icon, color } = STOP_TYPES[type]
  const html = toHtml(
    <div style={{ position: 'relative', width: 36, height: 46, filter: 'drop-shadow(0 6px 6px rgb(15 23 42 / .35))' }}>
      <svg width="36" height="46" viewBox="0 0 36 46">
        <path d="M18 45C18 45 34 28.5 34 17.5A16 16 0 0 0 2 17.5C2 28.5 18 45 18 45Z" fill={color} stroke="#fff" strokeWidth="2.5" />
      </svg>
      <div style={{ position: 'absolute', top: 7, left: 7, width: 22, height: 22, borderRadius: 999, background: '#fff', display: 'grid', placeItems: 'center', color }}>
        <Icon size={13} strokeWidth={2.6} />
      </div>
    </div>,
  )
  return L.divIcon({ html, className: 'stop-icon', iconSize: [36, 46], iconAnchor: [18, 45], popupAnchor: [0, -40] })
}

/** Round badge for HOS stops (breaks, rests, fuel, restarts). */
function buildBadgeIcon(type) {
  const { Icon, color, ring } = STOP_TYPES[type]
  const html = toHtml(
    <div style={{ width: 30, height: 30, borderRadius: 999, background: color, color: '#fff', display: 'grid', placeItems: 'center', border: '2.5px solid #fff', boxShadow: `0 0 0 3px ${ring}, 0 6px 12px -4px rgb(15 23 42 / .45)` }}>
      <Icon size={15} strokeWidth={2.4} />
    </div>,
  )
  return L.divIcon({ html, className: 'stop-icon', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -16] })
}

const PIN_ICONS = Object.fromEntries(Object.keys(STOP_TYPES).map((t) => [t, buildPinIcon(t)]))
const BADGE_ICONS = Object.fromEntries(Object.keys(STOP_TYPES).map((t) => [t, buildBadgeIcon(t)]))
const pinIcon = (type) => PIN_ICONS[type]
const badgeIcon = (type) => BADGE_ICONS[type]

// ---------------------------------------------------------------------------
// Map behaviours
// ---------------------------------------------------------------------------
function panelPadding() {
  // On desktop the floating form panel covers the left ~440px of the map.
  return window.innerWidth >= 1024 ? { paddingTopLeft: [460, 40], paddingBottomRight: [40, 40] } : { padding: [30, 30] }
}

function ClickToPick({ pickMode, onPick }) {
  const map = useMap()
  useEffect(() => {
    map.getContainer().classList.toggle('picking', Boolean(pickMode))
  }, [map, pickMode])
  useMapEvents({
    click(e) {
      if (pickMode) onPick(pickMode, e.latlng)
    },
  })
  return null
}

/** Zoom to the route when a new plan arrives, or to the pins before planning. */
function AutoFit({ geometry, points, planKey }) {
  const map = useMap()
  const lastFit = useRef(null)
  useEffect(() => {
    const key = planKey || points.map((p) => p.join(',')).join('|')
    if (!key || key === lastFit.current) return
    lastFit.current = key
    const coords = geometry?.length ? geometry : points
    if (coords.length === 1) map.flyTo(coords[0], Math.max(map.getZoom(), 9), { duration: 0.8 })
    else if (coords.length > 1) map.flyToBounds(L.latLngBounds(coords), { ...panelPadding(), duration: 0.9, maxZoom: 12 })
  }, [map, geometry, points, planKey])
  return null
}

function FocusStop({ stop }) {
  const map = useMap()
  useEffect(() => {
    if (stop) map.flyTo([stop.lat, stop.lon], stop.zoom ?? Math.max(map.getZoom(), 10), { duration: 0.8 })
  }, [map, stop])
  return null
}

/** Leaflet measures its container once; re-measure when the layout changes. */
function InvalidateOnResize() {
  const map = useMap()
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize())
    observer.observe(map.getContainer())
    return () => observer.disconnect()
  }, [map])
  return null
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function RouteMap({ fields, plan, stale, pickMode, onPick, onCancelPick, focusStop }) {
  const waypointPoints = useMemo(
    () => WAYPOINTS.map((wp) => fields[wp.key].place).filter(Boolean).map((p) => [p.lat, p.lon]),
    [fields],
  )
  const hosStops = useMemo(() => (plan?.stops ?? []).filter((s) => !WAYPOINT_TYPES.has(s.type)), [plan])
  const stopsByType = useMemo(() => Object.fromEntries((plan?.stops ?? []).map((s) => [s.type, s])), [plan])
  const pickLabel = WAYPOINTS.find((w) => w.key === pickMode)?.label

  return (
    <div className="relative h-full w-full">
      <MapContainer center={US_CENTER} zoom={4} minZoom={3} zoomControl={false} worldCopyJump className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          className="osm-tiles"
          maxZoom={19}
        />
        <ZoomControl position="bottomright" />
        <ClickToPick pickMode={pickMode} onPick={onPick} />
        <InvalidateOnResize />
        <AutoFit geometry={plan?.route.geometry} points={waypointPoints} planKey={plan?.id} />
        <FocusStop stop={focusStop} />

        {plan && (
          <>
            <Polyline positions={plan.route.geometry} pathOptions={{ color: '#fff', weight: 9, opacity: stale ? 0.4 : 0.95 }} />
            <Polyline
              positions={plan.route.geometry}
              pathOptions={{ color: stale ? '#94a3b8' : '#4f46e5', weight: 5, opacity: stale ? 0.7 : 1, dashArray: stale ? '8 10' : null }}
            />
          </>
        )}

        {hosStops.map((stop, i) => (
          <Marker key={`${stop.type}-${i}`} position={[stop.lat, stop.lon]} icon={badgeIcon(stop.type)} opacity={stale ? 0.5 : 1}>
            <Popup>
              <StopPopup stop={stop} />
            </Popup>
          </Marker>
        ))}

        {WAYPOINTS.map((wp) => {
          const place = fields[wp.key].place
          if (!place) return null
          const planned = !stale ? stopsByType[wp.stopType] : null
          return (
            <Marker
              key={wp.key}
              position={[place.lat, place.lon]}
              icon={pinIcon(wp.stopType)}
              draggable
              zIndexOffset={1000}
              eventHandlers={{ dragend: (e) => onPick(wp.key, e.target.getLatLng()) }}
            >
              <Popup>
                {planned ? (
                  <StopPopup stop={planned} />
                ) : (
                  <div className="text-sm">
                    <div className="font-semibold">{wp.label}</div>
                    <div className="text-slate-600">{place.label}</div>
                    <div className="mt-1 text-[11px] text-slate-400">Drag the pin to adjust</div>
                  </div>
                )}
              </Popup>
            </Marker>
          )
        })}
      </MapContainer>

      {pickMode && (
        <div className="pointer-events-none absolute inset-x-0 top-4 z-[1000] flex justify-center px-4 lg:pl-[440px]">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-slate-900/90 py-2 pl-4 pr-2 text-sm text-white shadow-xl backdrop-blur">
            <Crosshair className="size-4 text-indigo-300" />
            <span>
              Click the map to set <strong>{pickLabel}</strong>
            </span>
            <button type="button" onClick={onCancelPick} className="grid size-7 place-items-center rounded-full bg-white/10 hover:bg-white/20" title="Cancel">
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      <Legend />
    </div>
  )
}

function StopPopup({ stop }) {
  const meta = STOP_TYPES[stop.type]
  return (
    <div className="min-w-[190px] text-[13px] leading-snug">
      <div className="mb-1 flex items-center gap-2">
        <span className="size-2.5 rounded-full" style={{ background: meta.color }} />
        <span className="font-semibold text-slate-900">{meta.label}</span>
        <span className="ml-auto rounded bg-slate-100 px-1.5 text-[11px] font-medium text-slate-600">Day {stop.day}</span>
      </div>
      <div className="font-medium text-slate-700">{stop.label}</div>
      <div className="mt-1.5 space-y-0.5 text-[12px] text-slate-500">
        {stop.arrival && <div>Arrive: {fmtDateTime(stop.arrival)}</div>}
        <div>Depart: {fmtDateTime(stop.departure)}</div>
        {stop.duration_minutes > 0 && <div>Duration: {fmtDuration(stop.duration_minutes)}</div>}
        <div>Mile {fmtNumber(stop.mile)}</div>
      </div>
    </div>
  )
}

function Legend() {
  return (
    <div className="pointer-events-none absolute right-3 top-3 z-[900] hidden rounded-xl bg-white/90 p-2.5 text-[11px] shadow-lg backdrop-blur md:block">
      <div className="mb-1 font-semibold uppercase tracking-wide text-slate-400">Legend</div>
      <ul className="space-y-1">
        {Object.entries(STOP_TYPES).map(([type, { label, color, Icon }]) => (
          <li key={type} className="flex items-center gap-2 text-slate-700">
            <span className="grid size-4 place-items-center rounded-full text-white" style={{ background: color }}>
              <Icon className="size-2.5" strokeWidth={3} />
            </span>
            {label}
          </li>
        ))}
      </ul>
    </div>
  )
}
