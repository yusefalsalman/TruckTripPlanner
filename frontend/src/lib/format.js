/** Formatting helpers. Backend timestamps are naive home-terminal times. */

/** Parse "2026-10-05T08:00" as local wall-clock time (no timezone shift). */
export function parseLocal(iso) {
  if (!iso) return null
  const [date, time = '00:00'] = iso.split('T')
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm)
}

export const fmtDateTime = (iso) =>
  parseLocal(iso)?.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }) ?? '—'

export const fmtTime = (iso) =>
  parseLocal(iso)?.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) ?? '—'

export const fmtDate = (iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  parseLocal(iso)?.toLocaleDateString('en-US', opts) ?? '—'

export const fmtNumber = (n, digits = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

/** 90 -> "1h 30m" */
export function fmtDuration(minutes) {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

/** Hours as decimal on the log ("10.50"). */
export const fmtHours = (h) => Number(h ?? 0).toFixed(2)

/** Default departure: today 08:00 in datetime-local input format. */
export function defaultStartTime() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T08:00`
}

/** minute-of-day -> "08:15" */
export const clock = (minute) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
