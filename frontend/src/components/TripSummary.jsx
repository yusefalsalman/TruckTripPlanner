import {
  CalendarDays, Clock, FileText, Gauge, Route, ShieldAlert, ShieldCheck, Timer, TriangleAlert,
} from 'lucide-react'
import { CYCLE_LIMIT_HOURS, STOP_TYPES } from '../lib/constants'
import { fmtDateTime, fmtDuration, fmtNumber } from '../lib/format'

/** Stats, compliance badge, cycle usage and the stop-by-stop itinerary. */
export default function TripSummary({ plan, stale, onFocusStop, onShowLogs }) {
  const s = plan.summary
  return (
    <div className="space-y-4">
      {stale && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <TriangleAlert className="mt-px size-4 shrink-0" />
          Inputs changed since this plan was generated. Re-plan to update the route and logs.
        </div>
      )}

      <ComplianceBadge compliant={s.compliant} violations={s.violations} />

      <div className="grid grid-cols-2 gap-2">
        <Stat Icon={Route} label="Total miles" value={fmtNumber(s.total_miles)} unit="mi" />
        <Stat Icon={CalendarDays} label="Log days" value={s.total_days} unit={s.total_days === 1 ? 'day' : 'days'} />
        <Stat Icon={Gauge} label="Driving" value={fmtNumber(s.driving_hours, 2)} unit="hrs" />
        <Stat Icon={Timer} label="Trip duration" value={fmtNumber(s.trip_duration_hours, 2)} unit="hrs" />
        <div className="col-span-2 flex items-center gap-3 rounded-xl border border-slate-200 bg-white/70 px-3 py-2.5">
          <Clock className="size-4 text-indigo-500" />
          <div className="min-w-0 text-xs">
            <div className="text-slate-500">Depart {fmtDateTime(s.start_time)}</div>
            <div className="font-semibold text-slate-900">Arrive {fmtDateTime(s.end_time)}</div>
          </div>
        </div>
      </div>

      <CycleBar start={s.cycle_used_start_hours} onDuty={s.on_duty_hours} end={s.cycle_used_end_hours} restarts={s.restarts} />

      <div className="flex flex-wrap gap-1.5">
        {[
          ['break', s.breaks], ['rest', s.rests], ['fuel', s.fuel_stops], ['restart', s.restarts],
        ].map(([type, count]) => {
          const { Icon, color, label } = STOP_TYPES[type]
          return (
            <span key={type} className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white/80 py-1 pl-1 pr-2.5 text-[11px] font-medium text-slate-600">
              <span className="grid size-5 place-items-center rounded-full text-white" style={{ background: color }}>
                <Icon className="size-3" />
              </span>
              {count} × {label}
            </span>
          )
        })}
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Itinerary</h3>
          <button type="button" onClick={onShowLogs} className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800">
            <FileText className="size-3.5" /> View log sheets
          </button>
        </div>
        <ol className="relative space-y-1">
          {plan.stops.map((stop, i) => {
            const { Icon, color, label } = STOP_TYPES[stop.type]
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onFocusStop(stop)}
                  className="group flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-white/80"
                >
                  <span className="relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-white shadow-sm" style={{ background: color }}>
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-semibold text-slate-900">{label}</span>
                      <span className="shrink-0 text-[10.5px] font-medium text-slate-400">Day {stop.day} · mi {fmtNumber(stop.mile)}</span>
                    </span>
                    <span className="block truncate text-xs text-slate-600">{stop.label}</span>
                    <span className="block text-[11px] text-slate-400">
                      {stop.arrival ? fmtDateTime(stop.arrival) : `Departs ${fmtDateTime(stop.departure)}`}
                      {stop.duration_minutes > 0 && ` · ${fmtDuration(stop.duration_minutes)}`}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      </section>
    </div>
  )
}

function ComplianceBadge({ compliant, violations }) {
  if (compliant) {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 p-3 text-white shadow-lg shadow-emerald-500/25">
        <ShieldCheck className="size-7 shrink-0" />
        <div>
          <div className="text-sm font-bold">HOS compliant</div>
          <div className="text-[11px] text-emerald-50">11 / 14 / 8-hr break, 70-hr cycle and fuel rules satisfied on every day</div>
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-xl bg-rose-600 p-3 text-white shadow-lg shadow-rose-500/25">
      <div className="flex items-center gap-2 text-sm font-bold">
        <ShieldAlert className="size-5" /> HOS violations detected
      </div>
      <ul className="mt-1 list-disc pl-6 text-[11px]">
        {violations.map((v) => <li key={v}>{v}</li>)}
      </ul>
    </div>
  )
}

function Stat({ Icon, label, value, unit }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white/70 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className="mt-0.5 text-xl font-bold tabular-nums text-slate-900">
        {value} <span className="text-xs font-medium text-slate-400">{unit}</span>
      </div>
    </div>
  )
}

function CycleBar({ start, onDuty, end, restarts }) {
  const pct = (h) => `${Math.min(100, Math.max(0, (h / CYCLE_LIMIT_HOURS) * 100))}%`
  return (
    <div className="rounded-xl border border-slate-200 bg-white/70 p-3">
      <div className="flex items-baseline justify-between text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">
        <span>70-hr / 8-day cycle</span>
        <span className="font-mono normal-case text-slate-700">{end.toFixed(2)} / 70 hrs after trip</span>
      </div>
      <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-slate-200">
        {restarts > 0 ? (
          <div className="bg-indigo-500" style={{ width: pct(end) }} title="Hours since 34-hr restart" />
        ) : (
          <>
            <div className="bg-slate-400" style={{ width: pct(start) }} title="Used before this trip" />
            <div className="bg-indigo-500" style={{ width: pct(onDuty) }} title="On duty during this trip" />
          </>
        )}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-slate-500">
        <span>
          {restarts > 0 ? `Reset by ${restarts} × 34-hr restart` : `${start.toFixed(2)} prior + ${onDuty.toFixed(2)} this trip`}
        </span>
        <span className="font-semibold text-emerald-700">{Math.max(0, 70 - end).toFixed(2)} left</span>
      </div>
    </div>
  )
}
