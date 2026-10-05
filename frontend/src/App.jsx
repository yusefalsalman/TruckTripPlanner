import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, LoaderCircle, Truck, X } from 'lucide-react'
import TripForm from './components/TripForm'
import RouteMap from './components/RouteMap'
import TripSummary from './components/TripSummary'
import LogBook from './components/LogBook'
import { api } from './lib/api'
import { SAMPLE_TRIP, WAYPOINTS } from './lib/constants'
import { defaultStartTime } from './lib/format'

const EMPTY_FIELDS = {
  current: { text: '', place: null },
  pickup: { text: '', place: null },
  dropoff: { text: '', place: null },
}
const LOADING_STEPS = [
  'Geocoding locations…',
  'Calculating the truck route…',
  'Scheduling hours of service…',
  'Inserting breaks, rests & fuel stops…',
  'Labeling duty-status changes…',
  'Drawing daily log sheets…',
]

/** Identity of the inputs a plan was built from (used to flag stale plans). */
const inputsKey = (fields, cycleUsed, startTime) =>
  JSON.stringify([
    WAYPOINTS.map(({ key }) => {
      const { text, place } = fields[key]
      return place ? [place.lat, place.lon] : text.trim().toLowerCase()
    }),
    cycleUsed,
    startTime,
  ])

const placeToField = (p) => ({ text: p.label, place: { lat: p.lat, lon: p.lon, label: p.label } })

export default function App() {
  const [fields, setFields] = useState(EMPTY_FIELDS)
  const [cycleUsed, setCycleUsed] = useState(0)
  const [startTime, setStartTime] = useState(defaultStartTime)
  const [pickMode, setPickMode] = useState(null)
  const [plan, setPlan] = useState(null)
  const [planKey, setPlanKey] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingStep, setLoadingStep] = useState(0)
  const [error, setError] = useState('')
  const [activeDay, setActiveDay] = useState(0)
  const [focusStop, setFocusStop] = useState(null)
  const requestRef = useRef(null)
  const reverseRefs = useRef({})
  const logsRef = useRef(null)
  const fieldsRef = useRef(fields)
  fieldsRef.current = fields

  const stale = Boolean(plan) && planKey !== inputsKey(fields, cycleUsed, startTime)

  // ---- Bootstrapping: wake the API (free tiers sleep) and open shared plans.
  useEffect(() => {
    api.health().catch(() => {})
    const tripId = new URLSearchParams(window.location.search).get('trip')
    if (!tripId) return undefined
    const controller = new AbortController()
    setLoading(true)
    api.getTrip(tripId, controller.signal)
      .then((data) => applyPlan(data, {
        current: placeToField(data.locations.current),
        pickup: placeToField(data.locations.pickup),
        dropoff: placeToField(data.locations.dropoff),
      }, data.inputs.current_cycle_used, data.inputs.start_time))
      .catch((err) => {
        if (!controller.signal.aborted) setError(`Could not open the shared trip: ${err.message}`)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Cycle through progress messages while a plan is being generated.
  useEffect(() => {
    if (!loading) return undefined
    setLoadingStep(0)
    const id = setInterval(() => setLoadingStep((s) => Math.min(s + 1, LOADING_STEPS.length - 1)), 2200)
    return () => clearInterval(id)
  }, [loading])

  const applyPlan = (data, resolvedFields, cycle, start) => {
    setFields(resolvedFields)
    setCycleUsed(cycle)
    setStartTime(start)
    setPlan(data)
    setPlanKey(inputsKey(resolvedFields, cycle, start))
    setActiveDay(0)
    setFocusStop(null)
  }

  const updateField = useCallback((key, next) => {
    reverseRefs.current[key]?.abort()
    setFields((f) => ({ ...f, [key]: next }))
  }, [])

  /** Map click or pin drag: set coordinates immediately, then fetch a label. */
  const handlePick = useCallback((key, latlng) => {
    const { lat, lng } = latlng.wrap()
    const place = { lat, lon: lng, label: `${lat.toFixed(4)}, ${lng.toFixed(4)}` }
    updateField(key, { text: 'Locating…', place })

    const controller = new AbortController()
    reverseRefs.current[key] = controller
    api.reverse(lat, lng, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setFields((f) => ({ ...f, [key]: { text: res.label, place: { ...place, label: res.label } } }))
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFields((f) => ({ ...f, [key]: { text: place.label, place } }))
      })

    // After a map click (not a pin drag), move on to the next empty
    // waypoint, or leave picking mode.
    if (pickMode === key) {
      const f = fieldsRef.current
      const next = WAYPOINTS.find((w) => w.key !== key && !f[w.key].place && !f[w.key].text.trim())
      setPickMode(next ? next.key : null)
    }
  }, [updateField, pickMode])

  const handlePickModeChange = (key) => {
    setPickMode(key)
    // On small screens the map sits below the form - bring it into view.
    if (key && window.innerWidth < 1024) document.getElementById('map')?.scrollIntoView({ behavior: 'smooth' })
  }

  const loadSample = () => {
    setPickMode(null)
    setFields({
      current: placeToField(SAMPLE_TRIP.current),
      pickup: placeToField(SAMPLE_TRIP.pickup),
      dropoff: placeToField(SAMPLE_TRIP.dropoff),
    })
    setCycleUsed(SAMPLE_TRIP.cycleUsed)
    setError('')
  }

  const submit = async () => {
    setError('')
    const missing = WAYPOINTS.filter(({ key }) => !fields[key].place && !fields[key].text.trim())
    if (missing.length) {
      setError(`Please set: ${missing.map((m) => m.label).join(', ')}.`)
      return
    }
    if (WAYPOINTS.some(({ key }) => fields[key].text === 'Locating…')) {
      setError('Still looking up a map location - try again in a second.')
      return
    }
    if (!Number.isFinite(cycleUsed) || cycleUsed < 0 || cycleUsed > 70) {
      setError('Current cycle used must be between 0 and 70 hours.')
      return
    }
    if (!startTime) {
      setError('Please choose a departure date and time.')
      return
    }

    const toPayload = ({ text, place }) =>
      place ? { lat: place.lat, lon: place.lon, label: place.label } : { query: text.trim() }

    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setPickMode(null)
    setLoading(true)
    try {
      const data = await api.planTrip({
        current_location: toPayload(fields.current),
        pickup_location: toPayload(fields.pickup),
        dropoff_location: toPayload(fields.dropoff),
        current_cycle_used: cycleUsed,
        start_time: startTime,
      }, controller.signal)
      applyPlan(data, {
        current: placeToField(data.locations.current),
        pickup: placeToField(data.locations.pickup),
        dropoff: placeToField(data.locations.dropoff),
      }, cycleUsed, startTime)
      const url = new URL(window.location.href)
      url.searchParams.set('trip', data.id)
      window.history.replaceState(null, '', url)
    } catch (err) {
      if (!controller.signal.aborted) setError(err.message)
    } finally {
      if (requestRef.current === controller) setLoading(false)
    }
  }

  const scrollToLogs = () => logsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const handleFocusStop = useCallback((stop) => {
    setFocusStop({ ...stop }) // new object so re-clicking the same stop re-centres
    // On small screens the map sits below the panel.
    if (window.innerWidth < 1024) document.getElementById('map')?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const logCount = plan?.logs.length ?? 0
  const headerStats = useMemo(() => plan && !stale ? plan.summary : null, [plan, stale])

  return (
    <div className="min-h-screen">
      {/* ---------- Top bar ---------- */}
      <header className="sticky top-0 z-[1100] border-b border-slate-200/70 bg-white/80 backdrop-blur-xl print:hidden">
        <div className="mx-auto flex h-16 max-w-[1800px] items-center gap-3 px-4 sm:px-6">
          <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-500/30">
            <Truck className="size-5" />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-extrabold tracking-tight">HOS Trip Planner</div>
            <div className="text-[11px] font-medium text-slate-500">Route · FMCSA hours of service · ELD daily logs</div>
          </div>
          <nav className="ml-auto flex items-center gap-1 text-sm font-semibold">
            <a href="#planner" className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100">Planner</a>
            <a href="#logs" className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100">
              Logs
              {logCount > 0 && <span className="rounded-full bg-indigo-600 px-1.5 text-[10px] text-white">{logCount}</span>}
            </a>
          </nav>
        </div>
      </header>

      <main>
        {/* ---------- Planner: floating panel over a full-bleed map ---------- */}
        <section id="planner" className="relative flex print:hidden flex-col lg:block lg:h-[calc(100vh-4rem)] lg:min-h-[700px]">
          <aside className="relative z-[1000] p-3 sm:p-4 lg:absolute lg:bottom-4 lg:left-4 lg:top-4 lg:w-[430px] lg:p-0">
            <div className="glass flex max-h-full flex-col overflow-hidden rounded-2xl">
              <div className="scroll-thin space-y-5 overflow-y-auto p-5">
                <div>
                  <h1 className="text-xl font-extrabold tracking-tight text-slate-900">Plan a compliant trip</h1>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Search a place or use <span className="font-semibold">⌖</span> to drop pins on the map. Pins are draggable.
                  </p>
                </div>

                <TripForm
                  fields={fields}
                  onFieldChange={updateField}
                  cycleUsed={cycleUsed}
                  onCycleChange={setCycleUsed}
                  startTime={startTime}
                  onStartTimeChange={setStartTime}
                  pickMode={pickMode}
                  onPickModeChange={handlePickModeChange}
                  onSubmit={submit}
                  onLoadSample={loadSample}
                  loading={loading}
                  stale={stale}
                />

                {error && (
                  <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" />
                    <span className="flex-1">{error}</span>
                    <button type="button" onClick={() => setError('')} aria-label="Dismiss error" className="text-rose-400 hover:text-rose-700">
                      <X className="size-4" />
                    </button>
                  </div>
                )}

                {loading ? <SummarySkeleton /> : plan && (
                  <TripSummary plan={plan} stale={stale} onFocusStop={handleFocusStop} onShowLogs={scrollToLogs} />
                )}
              </div>
            </div>
          </aside>

          <div id="map" className="relative h-[60vh] min-h-[420px] lg:absolute lg:inset-0 lg:h-auto">
            <RouteMap
              fields={fields}
              plan={plan}
              stale={stale}
              pickMode={pickMode}
              onPick={handlePick}
              onCancelPick={() => setPickMode(null)}
              focusStop={focusStop}
            />
            {loading && (
              <div className="pointer-events-none absolute inset-0 z-[950] grid place-items-center bg-slate-900/10 backdrop-blur-[1px] lg:pl-[440px]">
                <div className="flex items-center gap-3 rounded-2xl bg-white/95 px-5 py-3.5 shadow-2xl">
                  <LoaderCircle className="size-5 animate-spin text-indigo-600" />
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{LOADING_STEPS[loadingStep]}</div>
                    <div className="text-[11px] text-slate-500">Long trips take a little longer while stops are labeled.</div>
                  </div>
                </div>
              </div>
            )}
            {headerStats && (
              <div className="pointer-events-none absolute bottom-6 left-1/2 z-[900] hidden -translate-x-1/2 gap-4 rounded-full bg-slate-900/85 px-5 py-2 text-xs font-medium text-white shadow-xl backdrop-blur md:flex lg:left-[calc(50%+215px)]">
                <span>{headerStats.total_miles.toLocaleString()} mi</span>
                <span className="text-slate-400">•</span>
                <span>{headerStats.driving_hours} hrs driving</span>
                <span className="text-slate-400">•</span>
                <span>{headerStats.total_days} log {headerStats.total_days === 1 ? 'day' : 'days'}</span>
              </div>
            )}
          </div>
        </section>

        {/* ---------- Log sheets ---------- */}
        <section id="logs" ref={logsRef} className="mx-auto max-w-[1800px] scroll-mt-16 px-4 py-10 sm:px-6 print:max-w-none print:p-0">
          <div className="mb-5 flex print:hidden flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-2xl font-extrabold tracking-tight">Driver&rsquo;s daily logs</h2>
              <p className="text-sm text-slate-500">
                One sheet per calendar day · totals always equal 24 hours · use ← → to switch days
              </p>
            </div>
          </div>
          <LogBook plan={plan} loading={loading} activeDay={activeDay} onActiveDayChange={setActiveDay} />
        </section>

        <footer className="border-t border-slate-200 py-6 print:hidden text-center text-xs text-slate-500">
          Routing © OSRM · Map data © OpenStreetMap contributors. Planning aid only - always verify against your ELD.
        </footer>
      </main>
    </div>
  )
}

function SummarySkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading trip summary">
      <div className="skeleton h-14" />
      <div className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-16" />)}
      </div>
      <div className="skeleton h-16" />
      {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-12" />)}
    </div>
  )
}
