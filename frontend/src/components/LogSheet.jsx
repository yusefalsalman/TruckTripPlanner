import { CheckCircle2, RotateCcw } from 'lucide-react'
import LogSheetGrid from './LogSheetGrid'
import { STATUS_BY_KEY } from '../lib/constants'
import { fmtHours, fmtNumber, parseLocal } from '../lib/format'

/**
 * One complete FMCSA "Driver's Daily Log" page (49 CFR 395.8 graph-grid format):
 * header fields, the 24-hour duty-status grid, remarks, shipping documents
 * and the 70-hour / 8-day recap.
 */
export default function LogSheet({ log, plan, driver, interactive = true }) {
  const date = parseLocal(log.date)
  const totalDays = plan.logs.length
  const { pickup, dropoff } = plan.locations
  const sumOk = Math.abs(log.total_hours - 24) < 1e-6

  return (
    <article className="log-page mx-auto w-full max-w-[1100px] rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-[0_20px_60px_-30px_rgba(15,23,42,0.35)] sm:p-7">
      {/* ---------- Title row ---------- */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-slate-900 pb-3">
        <div>
          <h3 className="text-xl font-extrabold tracking-tight sm:text-2xl">
            Driver&rsquo;s Daily Log <span className="text-sm font-semibold text-slate-500">(24 hours)</span>
          </h3>
          <p className="text-[11px] text-slate-500">U.S. Department of Transportation · FMCSA · 49 CFR §395.8 · Property-carrying, 70 hr / 8 day</p>
        </div>

        <div className="flex items-end gap-2" aria-label="Log date">
          {[
            ['Month', date.getMonth() + 1],
            ['Day', date.getDate()],
            ['Year', date.getFullYear()],
          ].map(([label, value]) => (
            <div key={label} className="text-center">
              <div className="min-w-12 rounded-md border-2 border-slate-900 px-2 py-0.5 font-mono text-lg font-semibold tabular-nums">
                {String(value).padStart(2, '0')}
              </div>
              <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
            </div>
          ))}
        </div>

        <div className="max-w-[260px] text-right">
          <span className="inline-block rounded-full bg-slate-900 px-3 py-1 text-xs font-bold text-white">
            Day {log.day} of {totalDays}
          </span>
          <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
            Original — file at home terminal. Duplicate — driver retains in possession for 8 days.
          </p>
        </div>
      </header>

      {/* ---------- From / To ---------- */}
      <div className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2">
        <Field label="From" value={log.from} />
        <Field label="To" value={log.to} />
      </div>

      {/* ---------- Header boxes ---------- */}
      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-300 bg-slate-300 text-sm md:grid-cols-6">
        <Box label="Total miles driving today" value={fmtNumber(log.miles_driven, 1)} mono />
        <Box label="Total mileage today" value={fmtNumber(log.miles_driven, 1)} mono />
        <Box label="Truck / tractor & trailer nos." value={[driver.truckNumber, driver.trailerNumber].filter(Boolean).join(' / ') || '—'} />
        <Box label="Name of carrier" value={driver.carrier || '—'} />
        <Box label="Main office address" value={driver.mainOffice || '—'} />
        <Box label="Home terminal address" value={driver.homeTerminal || '—'} />
      </div>

      {/* ---------- Duty status grid ---------- */}
      <div className="mt-4 overflow-x-auto">
        <div className="min-w-[720px]">
          <LogSheetGrid
            segments={log.segments}
            remarks={log.remarks}
            totals={log.totals}
            totalHours={log.total_hours}
            interactive={interactive}
          />
        </div>
      </div>

      {/* ---------- Remarks table / documents / recap ---------- */}
      <div className="mt-2 grid gap-5 lg:grid-cols-[1fr_320px]">
        <section>
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Remarks — change of duty status</h4>
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-left text-[12.5px]">
              <thead className="bg-slate-50 text-[10.5px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Time</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Location</th>
                  <th className="hidden px-3 py-2 font-semibold sm:table-cell">Activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {log.remarks.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-3 text-slate-500">
                      No change of duty status — continued from the previous day.
                    </td>
                  </tr>
                )}
                {log.remarks.map((r, i) => {
                  const status = STATUS_BY_KEY[r.status]
                  return (
                    <tr key={i} className="break-inside-avoid">
                      <td className="px-3 py-1.5 font-mono font-semibold tabular-nums">{r.time}</td>
                      <td className="px-3 py-1.5">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <span className="size-2 rounded-full" style={{ background: status.color }} />
                          {status.label}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-medium">{r.location}</td>
                      <td className="hidden px-3 py-1.5 text-slate-500 sm:table-cell">{r.note}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10.5px] leading-snug text-slate-500">
            Enter name of place reported and released from work, and where each change of duty occurred.
            Use time standard of home terminal.
          </p>

          <div className="mt-3 rounded-lg border border-slate-200 p-3 text-[12.5px]">
            <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-500">Shipping documents</h4>
            <div className="grid gap-1 sm:grid-cols-2">
              <div><span className="text-slate-500">DVL / Manifest No.: </span><span className="font-medium">{driver.shippingDoc || '—'}</span></div>
              <div><span className="text-slate-500">Shipper & commodity: </span><span className="font-medium">{driver.commodity || 'General freight'}</span></div>
              <div className="sm:col-span-2"><span className="text-slate-500">Load: </span><span className="font-medium">{pickup.label} → {dropoff.label}</span></div>
            </div>
          </div>
        </section>

        <aside className="space-y-3">
          <section className="rounded-lg border-2 border-slate-900 p-3">
            <h4 className="text-xs font-extrabold uppercase tracking-wider">Recap · 70 hour / 8 day</h4>
            <dl className="mt-2 space-y-1.5 text-[12.5px]">
              <RecapRow label="On-duty hours today (lines 3 + 4)" value={log.recap.on_duty_today} />
              <RecapRow label="Cycle hours used at start of day" value={log.recap.cycle_at_start_of_day} muted />
              <RecapRow label="A. Total on duty last 8 days incl. today" value={log.recap.total_last_8_days} strong />
              <RecapRow
                label="B. Available tomorrow (70 − A)"
                value={log.recap.available_tomorrow}
                strong
                tone={log.recap.available_tomorrow <= 0 ? 'bad' : log.recap.available_tomorrow < 11 ? 'warn' : 'good'}
              />
            </dl>
            {log.recap.restart_taken ? (
              <p className="mt-2 flex items-start gap-1.5 rounded-md bg-slate-100 p-2 text-[11px] font-medium text-slate-700">
                <RotateCcw className="mt-px size-3.5 shrink-0" /> 34-hr restart taken — the 70-hour cycle was reset.
              </p>
            ) : (
              <p className="mt-2 text-[10.5px] leading-snug text-slate-500">
                *If you took 34 consecutive hours off duty you have 70 hours available.
              </p>
            )}
          </section>

          <section className="rounded-lg border border-slate-200 p-3 text-[12.5px]">
            <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-500">Daily totals</h4>
            {Object.entries(log.totals).map(([key, hours]) => (
              <div key={key} className="flex items-center justify-between py-0.5">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: STATUS_BY_KEY[key].color }} />
                  {STATUS_BY_KEY[key].label}
                </span>
                <span className="font-mono tabular-nums">{fmtHours(hours)}</span>
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between border-t border-slate-900 pt-1 font-bold">
              <span className="inline-flex items-center gap-1.5">
                Total {sumOk && <CheckCircle2 className="size-3.5 text-emerald-600" aria-label="Sums to 24 hours" />}
              </span>
              <span className="font-mono tabular-nums">{fmtHours(log.total_hours)}</span>
            </div>
          </section>
        </aside>
      </div>

      {/* ---------- Certification ---------- */}
      <footer className="mt-5 grid gap-4 border-t border-slate-200 pt-3 text-[12px] sm:grid-cols-2">
        <div>
          <div className="min-h-7 border-b border-slate-400 pb-0.5 text-lg italic text-slate-800" style={{ fontFamily: 'cursive' }}>
            {driver.driverName}
          </div>
          <div className="mt-0.5 text-[10.5px] text-slate-500">Driver&rsquo;s signature — I certify these entries are true and correct</div>
        </div>
        <div>
          <div className="min-h-7 border-b border-slate-400 pb-0.5 text-sm font-medium">{driver.coDriver || ''}</div>
          <div className="mt-0.5 text-[10.5px] text-slate-500">Name of co-driver</div>
        </div>
      </footer>
    </article>
  )
}

function Field({ label, value }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}:</span>
      <span className="flex-1 border-b border-slate-400 pb-0.5 text-sm font-semibold">{value}</span>
    </div>
  )
}

function Box({ label, value, mono }) {
  return (
    <div className="bg-white px-3 py-2">
      <div className="text-[9.5px] font-semibold uppercase leading-tight tracking-wide text-slate-500">{label}</div>
      <div className={`mt-0.5 truncate font-semibold ${mono ? 'font-mono tabular-nums' : ''}`} title={String(value)}>{value}</div>
    </div>
  )
}

const TONES = { good: 'text-emerald-700', warn: 'text-amber-600', bad: 'text-rose-600' }

function RecapRow({ label, value, strong, muted, tone }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={muted ? 'text-slate-500' : 'text-slate-700'}>{label}</dt>
      <dd className={`font-mono tabular-nums ${strong ? 'text-[14px] font-bold' : ''} ${tone ? TONES[tone] : ''}`}>
        {fmtHours(value)}
      </dd>
    </div>
  )
}
