import {
  BedDouble, Coffee, Flag, Fuel, Navigation, PackagePlus, RotateCcw,
} from 'lucide-react'

/** The four duty-status lines of the log graph, top to bottom. */
export const STATUSES = [
  { key: 'off_duty', label: 'Off Duty', short: 'OFF', color: '#64748b' },
  { key: 'sleeper_berth', label: 'Sleeper Berth', short: 'SB', color: '#7c3aed' },
  { key: 'driving', label: 'Driving', short: 'D', color: '#2563eb' },
  { key: 'on_duty', label: 'On Duty (Not Driving)', short: 'ON', color: '#ea580c' },
]
export const STATUS_BY_KEY = Object.fromEntries(STATUSES.map((s) => [s.key, s]))

/** Map marker / timeline metadata per stop type. */
export const STOP_TYPES = {
  start: { label: 'Start', Icon: Navigation, color: '#059669', ring: '#a7f3d0' },
  pickup: { label: 'Pickup', Icon: PackagePlus, color: '#2563eb', ring: '#bfdbfe' },
  dropoff: { label: 'Dropoff', Icon: Flag, color: '#e11d48', ring: '#fecdd3' },
  break: { label: '30-min Break', Icon: Coffee, color: '#d97706', ring: '#fde68a' },
  rest: { label: '10-hr Sleeper Rest', Icon: BedDouble, color: '#7c3aed', ring: '#ddd6fe' },
  fuel: { label: 'Fuel Stop', Icon: Fuel, color: '#ea580c', ring: '#fed7aa' },
  restart: { label: '34-hr Restart', Icon: RotateCcw, color: '#475569', ring: '#cbd5e1' },
}

/** The three user-controlled waypoints. */
export const WAYPOINTS = [
  { key: 'current', label: 'Current location', stopType: 'start', placeholder: 'e.g. Dallas, TX' },
  { key: 'pickup', label: 'Pickup', stopType: 'pickup', placeholder: 'e.g. Oklahoma City, OK' },
  { key: 'dropoff', label: 'Dropoff', stopType: 'dropoff', placeholder: 'e.g. Denver, CO' },
]

export const SAMPLE_TRIP = {
  current: { lat: 32.7767, lon: -96.797, label: 'Dallas, TX' },
  pickup: { lat: 35.4676, lon: -97.5164, label: 'Oklahoma City, OK' },
  dropoff: { lat: 39.7392, lon: -104.9903, label: 'Denver, CO' },
  cycleUsed: 12,
}

export const CYCLE_LIMIT_HOURS = 70
