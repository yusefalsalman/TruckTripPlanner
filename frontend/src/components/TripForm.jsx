import { useEffect, useRef, useState } from 'react'
import {
  CalendarDays, Crosshair, Gauge, LoaderCircle, MapPin, Route, Search, Sparkles, X,
} from 'lucide-react'
import { api } from '../lib/api'
import { CYCLE_LIMIT_HOURS, STOP_TYPES, WAYPOINTS } from '../lib/constants'

/**
 * Trip input form.
 *
 * Each waypoint can be set three ways:
 *   1. type a place and press Enter / the search button, then pick a result
 *   2. toggle the crosshair and click the map (or drag an existing pin)
 *   3. type a place and submit directly - the backend geocodes the text
 *
 * Nominatim forbids search-as-you-type, so searching is explicit.
 */
export default function TripForm({
  fields, onFieldChange, cycleUsed, onCycleChange, startTime, onStartTimeChange,
  pickMode, onPickModeChange, onSubmit, onLoadSample, loading, stale,
}) {
  const handleSubmit = (e) => {
    e.preventDefault()
    if (!loading) onSubmit()
  }
  const cycleValue = Number.isFinite(cycleUsed) ? cycleUsed : 0
  const remaining = Math.max(0, CYCLE_LIMIT_HOURS - cycleValue)

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div className="relative space-y-2.5">
        {/* Vertical connector between the three waypoint dots */}
        <div className="absolute left-[19px] top-10 bottom-10 w-px bg-gradient-to-b from-emerald-300 via-blue-300 to-rose-300" aria-hidden />
        {WAYPOINTS.map((wp) => (
          <LocationInput
            key={wp.key}
            waypoint={wp}
            value={fields[wp.key]}
            onChange={(next) => onFieldChange(wp.key, next)}
            picking={pickMode === wp.key}
            onTogglePick={() => onPickModeChange(pickMode === wp.key ? null : wp.key)}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block rounded-xl border border-slate-200 bg-white/70 p-3">
          <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <Gauge className="size-3.5" /> Cycle used (hrs)
          </span>
          <div className="flex items-baseline gap-1">
            <input
              type="number"
              min={0}
              max={CYCLE_LIMIT_HOURS}
              step={0.25}
              value={Number.isFinite(cycleUsed) ? cycleUsed : ''}
              onChange={(e) => onCycleChange(e.target.value === '' ? NaN : Number(e.target.value))}
              className="w-full min-w-0 flex-1 bg-transparent text-lg font-semibold tabular-nums text-slate-900 outline-none"
              aria-label="Current cycle used in hours"
              required
            />
            <span className="shrink-0 whitespace-nowrap text-xs text-slate-400">/ 70</span>
          </div>
          <input
            type="range"
            min={0}
            max={CYCLE_LIMIT_HOURS}
            step={0.25}
            value={Math.min(CYCLE_LIMIT_HOURS, Math.max(0, cycleValue))}
            onChange={(e) => onCycleChange(Number(e.target.value))}
            className="cycle-range mt-1 w-full"
            aria-hidden
            tabIndex={-1}
          />
          <span className="text-[11px] text-slate-500">{remaining.toFixed(2)} hrs available</span>
        </label>

        <label className="block rounded-xl border border-slate-200 bg-white/70 p-3">
          <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <CalendarDays className="size-3.5" /> Departure
          </span>
          <input
            type="datetime-local"
            step={900}
            value={startTime}
            onChange={(e) => onStartTimeChange(e.target.value)}
            className="w-full bg-transparent text-sm font-medium text-slate-900 outline-none"
            required
          />
          <span className="mt-1 block text-[11px] leading-snug text-slate-500">Home-terminal time, rounded to 15 min</span>
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading}
          className="group relative inline-flex flex-1 items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:shadow-indigo-500/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-wait disabled:opacity-80"
        >
          {loading ? <LoaderCircle className="size-4 animate-spin" /> : <Route className="size-4" />}
          {loading ? 'Planning trip…' : stale ? 'Re-plan trip' : 'Plan trip & generate logs'}
        </button>
        <button
          type="button"
          onClick={onLoadSample}
          disabled={loading}
          title="Fill in a sample trip"
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white/80 px-3 text-xs font-semibold text-slate-600 transition hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-50"
        >
          <Sparkles className="size-4" /> Sample
        </button>
      </div>
    </form>
  )
}

function LocationInput({ waypoint, value, onChange, picking, onTogglePick }) {
  const meta = STOP_TYPES[waypoint.stopType]
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef(null)
  const boxRef = useRef(null)

  // Close the dropdown when clicking elsewhere.
  useEffect(() => {
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => () => abortRef.current?.abort(), [])

  const runSearch = async () => {
    const q = value.text.trim()
    if (q.length < 2) {
      setError('Type at least 2 characters')
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setSearching(true)
    setError('')
    try {
      const found = await api.searchPlaces(q, controller.signal)
      setResults(found)
      setOpen(true)
      if (!found.length) setError('No matches - try adding a state, or click the map')
    } catch (err) {
      if (!controller.signal.aborted) setError(err.message)
    } finally {
      if (abortRef.current === controller) setSearching(false)
    }
  }

  const choose = (place) => {
    onChange({ text: place.label, place })
    setOpen(false)
    setResults([])
    setError('')
  }

  const { Icon } = meta
  return (
    <div ref={boxRef} className="relative">
      <div
        className={`flex items-center gap-2 rounded-xl border bg-white/80 py-1.5 pl-1.5 pr-1.5 transition focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-500/10 ${
          picking ? 'border-indigo-500 ring-4 ring-indigo-500/15' : 'border-slate-200'
        }`}
      >
        <span
          className="relative z-10 grid size-[26px] shrink-0 place-items-center rounded-lg text-white shadow-sm"
          style={{ background: meta.color }}
          aria-hidden
        >
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <label htmlFor={`loc-${waypoint.key}`} className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {waypoint.label}
          </label>
          <input
            id={`loc-${waypoint.key}`}
            value={value.text}
            placeholder={waypoint.placeholder}
            autoComplete="off"
            onChange={(e) => onChange({ text: e.target.value, place: null })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                runSearch()
              } else if (e.key === 'Escape') setOpen(false)
            }}
            className="w-full truncate bg-transparent text-sm font-medium text-slate-900 placeholder:font-normal placeholder:text-slate-400 outline-none"
          />
        </div>
        {value.place && (
          <span className="hidden shrink-0 rounded-md bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 sm:inline" title="Location locked to coordinates">
            {value.place.lat.toFixed(2)}, {value.place.lon.toFixed(2)}
          </span>
        )}
        {value.text && (
          <IconButton title="Clear" onClick={() => { onChange({ text: '', place: null }); setResults([]); setError('') }}>
            <X className="size-4" />
          </IconButton>
        )}
        <IconButton title="Search" onClick={runSearch} disabled={searching}>
          {searching ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
        </IconButton>
        <IconButton title={picking ? 'Cancel map picking' : 'Pick on map'} onClick={onTogglePick} active={picking}>
          <Crosshair className="size-4" />
        </IconButton>
      </div>

      {error && <p className="mt-1 pl-10 text-[11px] text-rose-600">{error}</p>}

      {open && results.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-[1200] mt-1 max-h-64 overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-xl scroll-thin" role="listbox">
          {results.map((r) => (
            <li key={`${r.lat},${r.lon}`}>
              <button
                type="button"
                onClick={() => choose(r)}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-indigo-50"
              >
                <MapPin className="mt-0.5 size-4 shrink-0 text-indigo-500" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-800">{r.label}</span>
                  <span className="block truncate text-[11px] text-slate-500">{r.display_name}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function IconButton({ children, active, ...props }) {
  return (
    <button
      type="button"
      {...props}
      className={`grid size-8 shrink-0 place-items-center rounded-lg transition disabled:opacity-50 ${
        active ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  )
}
