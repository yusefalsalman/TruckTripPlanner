import { useState } from 'react'
import { STATUSES, STATUS_BY_KEY } from '../lib/constants'
import { clock, fmtDuration, fmtHours } from '../lib/format'

/*
 * SVG renderer for the FMCSA 24-hour duty-status graph.
 *
 * Layout (viewBox units):
 *   ┌────────┬───────────── hour labels (Mid-night … Noon … Mid-night) ─────────┬───────┐
 *   │ 1. Off │ ┊ ╷ ┊ ╷ ┊ … 24 columns, ticks every 15 minutes                    │ total │
 *   │ 2. SB  │                                                                   │       │
 *   │ 3. D   │      ▁▁▁▁▁|▔▔▔▔▔▔▔▔|▁▁    ← continuous duty-status step line       │       │
 *   │ 4. ON  │                                                                   │       │
 *   └────────┴───────────────────────────────────────────────────────────────────┴───────┘
 *     Remarks band: a flag at every change of duty status with "City, ST".
 */
const W = 1000
const LABEL_W = 138
const TOTAL_W = 76
const X0 = LABEL_W
const X1 = W - TOTAL_W
const HEADER_H = 30
const ROW_H = 36
const Y0 = HEADER_H
const Y1 = Y0 + ROW_H * 4
const REMARKS_H = 128
const H = Y1 + REMARKS_H
const LINE_COLOR = '#1d3fbf'

const xAt = (minute) => X0 + ((X1 - X0) * minute) / 1440
const rowIndex = Object.fromEntries(STATUSES.map((s, i) => [s.key, i]))
const yMid = (status) => Y0 + ROW_H * rowIndex[status] + ROW_H / 2

const HOUR_LABELS = Array.from({ length: 25 }, (_, h) =>
  h === 0 || h === 24 ? 'Mid-night' : h === 12 ? 'Noon' : String(h % 12),
)
const ROW_LABELS = [
  ['1. Off Duty'],
  ['2. Sleeper', 'Berth'],
  ['3. Driving'],
  ['4. On Duty', '(not driving)'],
]

export default function LogSheetGrid({ segments, remarks, totals, totalHours, interactive = true }) {
  const [hover, setHover] = useState(null)

  // Continuous step path: horizontal at each status, vertical at each change.
  const path = segments
    .map((s, i) => `${i === 0 ? 'M' : 'L'}${xAt(s.start).toFixed(2)},${yMid(s.status)} L${xAt(s.end).toFixed(2)},${yMid(s.status)}`)
    .join(' ')

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-auto w-full select-none"
      role="img"
      aria-label="Duty status graph for a 24 hour period"
      style={{ fontFamily: 'Inter, ui-sans-serif, system-ui' }}
    >
      {/* ---------- Hour header band ---------- */}
      {/* Band overhangs the grid so the centred "Mid-night" labels stay legible */}
      <rect x={X0 - 18} y={0} width={X1 - X0 + 36} height={HEADER_H} fill="#0f172a" rx={4} />
      {HOUR_LABELS.map((label, h) => {
        const x = xAt(h * 60)
        const twoLine = label === 'Mid-night'
        return (
          <text key={h} x={x} y={twoLine ? 12 : 19} textAnchor="middle" fill="#fff" fontSize={twoLine ? 8 : 10.5} fontWeight={600}>
            {twoLine ? (
              <>
                <tspan x={x}>Mid-</tspan>
                <tspan x={x} dy={9}>night</tspan>
              </>
            ) : label}
          </text>
        )
      })}
      <text x={(X1 + W) / 2} y={13} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0f172a">Total</text>
      <text x={(X1 + W) / 2} y={24} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0f172a">Hours</text>

      {/* ---------- Rows ---------- */}
      {STATUSES.map((s, i) => {
        const y = Y0 + i * ROW_H
        return (
          <g key={s.key}>
            <rect x={X0} y={y} width={X1 - X0} height={ROW_H} fill={i % 2 ? '#f8fafc' : '#ffffff'} />
            <rect x={4} y={y + 6} width={4} height={ROW_H - 12} rx={2} fill={s.color} />
            {ROW_LABELS[i].map((line, j) => (
              <text key={j} x={14} y={y + ROW_H / 2 + (ROW_LABELS[i].length === 1 ? 4 : j === 0 ? -2 : 10)}
                fontSize={j === 0 ? 11.5 : 9.5} fontWeight={j === 0 ? 700 : 500} fill={j === 0 ? '#0f172a' : '#64748b'}>
                {line}
              </text>
            ))}
            {/* Row total */}
            <rect x={X1 + 8} y={y + 6} width={TOTAL_W - 12} height={ROW_H - 12} rx={5} fill="#f1f5f9" />
            <text x={X1 + 8 + (TOTAL_W - 12) / 2} y={y + ROW_H / 2 + 4.5} textAnchor="middle" fontSize={13} fontWeight={700}
              fill="#0f172a" style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>
              {fmtHours(totals[s.key])}
            </text>
          </g>
        )
      })}

      {/* ---------- 15-minute tick marks ---------- */}
      {Array.from({ length: 24 * 4 + 1 }, (_, q) => {
        const x = xAt(q * 15)
        if (q % 4 === 0) {
          return <line key={q} x1={x} x2={x} y1={Y0} y2={Y1} stroke="#94a3b8" strokeWidth={q % 48 === 0 ? 1.4 : 0.9} />
        }
        const len = q % 2 === 0 ? ROW_H * 0.5 : ROW_H * 0.28
        return (
          <g key={q}>
            {STATUSES.map((s, i) => (
              <line key={s.key} x1={x} x2={x} y1={Y0 + i * ROW_H} y2={Y0 + i * ROW_H + len} stroke="#cbd5e1" strokeWidth={0.8} />
            ))}
          </g>
        )
      })}
      {Array.from({ length: 5 }, (_, i) => (
        <line key={i} x1={X0} x2={X1} y1={Y0 + i * ROW_H} y2={Y0 + i * ROW_H} stroke="#64748b" strokeWidth={i === 0 || i === 4 ? 1.4 : 0.9} />
      ))}

      {/* ---------- Status highlight bands + duty line ---------- */}
      {segments.map((s, i) => (
        <rect key={i} x={xAt(s.start)} y={yMid(s.status) - 7} width={Math.max(0, xAt(s.end) - xAt(s.start))} height={14}
          fill={STATUS_BY_KEY[s.status].color} opacity={hover === i ? 0.32 : 0.12} />
      ))}
      <path d={path} fill="none" stroke={LINE_COLOR} strokeWidth={2.6} strokeLinejoin="miter" strokeLinecap="square" />
      {segments.slice(1).map((s, i) => (
        <circle key={i} cx={xAt(s.start)} cy={yMid(s.status)} r={2.4} fill={LINE_COLOR} />
      ))}

      {/* Invisible hit-areas give each segment a tooltip */}
      {interactive && segments.map((s, i) => (
        <rect key={i} x={xAt(s.start)} y={Y0} width={Math.max(0, xAt(s.end) - xAt(s.start))} height={Y1 - Y0}
          fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
          <title>{`${STATUS_BY_KEY[s.status].label}: ${clock(s.start)}–${clock(s.end)} (${fmtDuration(s.end - s.start)})\n${s.note}`}</title>
        </rect>
      ))}

      {/* Grand total */}
      <line x1={X1 + 8} x2={W - 4} y1={Y1 + 4} y2={Y1 + 4} stroke="#0f172a" strokeWidth={1.2} />
      <text x={X1 + 8 + (TOTAL_W - 12) / 2} y={Y1 + 20} textAnchor="middle" fontSize={13} fontWeight={800} fill="#0f172a"
        style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>
        {fmtHours(totalHours)}
      </text>

      {/* ---------- Remarks band ---------- */}
      <text x={14} y={Y1 + 22} fontSize={11.5} fontWeight={700} fill="#0f172a">Remarks</text>
      <line x1={X0} x2={X1} y1={Y1 + 12} y2={Y1 + 12} stroke="#e2e8f0" />
      {remarks.map((r, i) => {
        const x = xAt(r.minute)
        const color = STATUS_BY_KEY[r.status].color
        // Labels near the right edge slant down-left so they stay on the sheet.
        const flip = x > X1 - 140
        const tx = flip ? x - 3 : x + 3
        const ty = Y1 + 20
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={Y1} y2={Y1 + 12} stroke={LINE_COLOR} strokeWidth={1.2} />
            <circle cx={x} cy={Y1 + 12} r={2.2} fill={color} />
            <text x={tx} y={ty} fontSize={9} fill="#334155" textAnchor={flip ? 'end' : 'start'}
              transform={`rotate(${flip ? -42 : 42} ${tx} ${ty})`}>
              <tspan fontWeight={700} fill="#0f172a">{r.time}</tspan> {r.location}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
