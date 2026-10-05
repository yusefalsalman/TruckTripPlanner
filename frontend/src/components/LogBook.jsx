import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { ChevronDown, ChevronLeft, ChevronRight, FileText, Printer } from 'lucide-react'
import LogSheet from './LogSheet'
import { fmtDate } from '../lib/format'

const DRIVER_STORAGE_KEY = 'ttp.driver'
const EMPTY_DRIVER = {
  driverName: '', coDriver: '', carrier: '', mainOffice: '', homeTerminal: '',
  truckNumber: '', trailerNumber: '', shippingDoc: '', commodity: '',
}
const DRIVER_FIELDS = [
  ['driverName', 'Driver name'], ['coDriver', 'Co-driver'], ['carrier', 'Carrier'],
  ['mainOffice', 'Main office address'], ['homeTerminal', 'Home terminal address'],
  ['truckNumber', 'Truck / tractor no.'], ['trailerNumber', 'Trailer no.'],
  ['shippingDoc', 'DVL / manifest no.'], ['commodity', 'Shipper & commodity'],
]

function loadDriver() {
  try {
    return { ...EMPTY_DRIVER, ...JSON.parse(localStorage.getItem(DRIVER_STORAGE_KEY) || '{}') }
  } catch {
    return EMPTY_DRIVER
  }
}

/**
 * Log-sheet viewer: day pagination, optional driver/carrier header details
 * (remembered in this browser), and print / save-as-PDF of one or all days.
 */
export default function LogBook({ plan, loading, activeDay, onActiveDayChange }) {
  const [driver, setDriver] = useState(loadDriver)
  const [showDetails, setShowDetails] = useState(false)
  const [printScope, setPrintScope] = useState('all')

  useEffect(() => {
    try {
      localStorage.setItem(DRIVER_STORAGE_KEY, JSON.stringify(driver))
    } catch {
      /* storage unavailable (private mode) - details just won't persist */
    }
  }, [driver])

  // Arrow-key navigation between days (ignored while typing in a field).
  useEffect(() => {
    if (!plan) return undefined
    const onKey = (e) => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return
      if (e.key === 'ArrowRight') onActiveDayChange((d) => Math.min(plan.logs.length - 1, d + 1))
      if (e.key === 'ArrowLeft') onActiveDayChange((d) => Math.max(0, d - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [plan, onActiveDayChange])

  const print = (scope) => {
    // Render the print container for the chosen scope before the dialog opens.
    flushSync(() => setPrintScope(scope))
    window.print()
  }

  if (loading) return <LogSkeleton />
  if (!plan) return <EmptyState />

  const logs = plan.logs
  const day = Math.min(activeDay, logs.length - 1)
  const log = logs[day]
  const printLogs = printScope === 'all' ? logs : [log]

  return (
    <>
      <div className="print:hidden">
        {/* ---------- Toolbar ---------- */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
            <NavButton disabled={day === 0} onClick={() => onActiveDayChange(day - 1)} label="Previous day">
              <ChevronLeft className="size-4" />
            </NavButton>
            <div className="flex max-w-[60vw] gap-1 overflow-x-auto scroll-thin" role="tablist" aria-label="Log days">
              {logs.map((l, i) => (
                <button
                  key={l.day}
                  type="button"
                  role="tab"
                  aria-selected={i === day}
                  onClick={() => onActiveDayChange(i)}
                  className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-left transition ${
                    i === day ? 'bg-slate-900 text-white shadow' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <span className="block text-xs font-bold">Day {l.day}</span>
                  <span className={`block text-[10px] ${i === day ? 'text-slate-300' : 'text-slate-400'}`}>{fmtDate(l.date)}</span>
                </button>
              ))}
            </div>
            <NavButton disabled={day === logs.length - 1} onClick={() => onActiveDayChange(day + 1)} label="Next day">
              <ChevronRight className="size-4" />
            </NavButton>
          </div>

          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold text-slate-700 shadow-sm hover:border-slate-300"
            aria-expanded={showDetails}
          >
            Driver & carrier details
            <ChevronDown className={`size-4 transition ${showDetails ? 'rotate-180' : ''}`} />
          </button>

          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => print('day')}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold text-slate-700 shadow-sm hover:border-slate-300"
            >
              <FileText className="size-4" /> Print day {log.day}
            </button>
            <button
              type="button"
              onClick={() => print('all')}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white shadow-lg shadow-slate-900/20 hover:bg-slate-800"
            >
              <Printer className="size-4" /> Download PDF / Print all
            </button>
          </div>
        </div>

        {showDetails && (
          <div className="mb-4 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-3">
            {DRIVER_FIELDS.map(([key, label]) => (
              <label key={key} className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
                <input
                  value={driver[key]}
                  onChange={(e) => setDriver((d) => ({ ...d, [key]: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10"
                />
              </label>
            ))}
            <p className="text-[11px] text-slate-500 sm:col-span-2 lg:col-span-3">
              Printed on every sheet. Saved in this browser only.
            </p>
          </div>
        )}

        <LogSheet key={log.day} log={log} plan={plan} driver={driver} />
      </div>

      {/* Print-only copy: one sheet per page. */}
      <div className="hidden print:block">
        {printLogs.map((l) => (
          <LogSheet key={l.day} log={l} plan={plan} driver={driver} interactive={false} />
        ))}
      </div>
    </>
  )
}

function NavButton({ children, label, ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      className="grid size-9 shrink-0 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
      {...props}
    >
      {children}
    </button>
  )
}

function EmptyState() {
  return (
    <div className="grid place-items-center rounded-2xl border-2 border-dashed border-slate-300 bg-white/60 px-6 py-16 text-center">
      <div className="grid size-14 place-items-center rounded-2xl bg-indigo-50 text-indigo-600">
        <FileText className="size-7" />
      </div>
      <h3 className="mt-4 text-lg font-bold text-slate-900">No log sheets yet</h3>
      <p className="mt-1 max-w-md text-sm text-slate-500">
        Plan a trip above and a 24-hour FMCSA driver&rsquo;s daily log will be generated for every day of the journey.
      </p>
    </div>
  )
}

function LogSkeleton() {
  return (
    <div aria-busy="true" aria-label="Generating log sheets">
      <div className="mb-4 flex gap-2">
        {[0, 1, 2].map((i) => <div key={i} className="skeleton h-12 w-20" />)}
        <div className="skeleton ml-auto h-12 w-44" />
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-7">
        <div className="skeleton h-8 w-72" />
        <div className="mt-4 grid grid-cols-6 gap-2">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton h-12" />)}
        </div>
        <div className="skeleton mt-5 h-56 w-full" />
        <div className="mt-5 grid grid-cols-[1fr_320px] gap-5">
          <div className="skeleton h-40" />
          <div className="skeleton h-40" />
        </div>
      </div>
    </div>
  )
}
