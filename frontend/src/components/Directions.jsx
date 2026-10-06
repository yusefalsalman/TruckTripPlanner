import {
  ArrowUp, ArrowUpLeft, ArrowUpRight, CornerUpLeft, CornerUpRight, Flag, Merge, Navigation,
  RotateCw, Split, Undo2,
} from 'lucide-react'
import { STOP_TYPES } from '../lib/constants'
import { fmtDateTime, fmtDuration, fmtNumber } from '../lib/format'

const HOS_STOP_TYPES = new Set(['break', 'rest', 'fuel', 'restart'])

/** Pick an arrow for an OSRM maneuver type + modifier. */
function maneuverIcon(maneuver, modifier) {
  if (maneuver === 'depart') return Navigation
  if (maneuver === 'arrive') return Flag
  if (maneuver === 'roundabout' || maneuver === 'rotary' || maneuver === 'roundabout turn') return RotateCw
  if (maneuver === 'merge') return Merge
  if (maneuver === 'fork') return Split
  if (modifier === 'uturn') return Undo2
  if (modifier === 'left' || modifier === 'sharp left') return CornerUpLeft
  if (modifier === 'right' || modifier === 'sharp right') return CornerUpRight
  if (modifier === 'slight left') return ArrowUpLeft
  if (modifier === 'slight right') return ArrowUpRight
  return ArrowUp
}

/**
 * Turn-by-turn route instructions, one section per leg, with the planned HOS
 * stops (breaks, rests, fuel, restarts) slotted in at the mile they happen.
 * Clicking a row zooms the map to that point.
 */
export default function Directions({ plan, onFocus }) {
  const hosStops = plan.stops.filter((s) => HOS_STOP_TYPES.has(s.type))

  return (
    <div className="space-y-4">
      {plan.route.legs.map((leg, legIndex) => {
        const legStart = leg.steps[0]?.mile ?? 0
        const legEnd = legStart + leg.distance_miles
        const isLastLeg = legIndex === plan.route.legs.length - 1
        return (
          <section key={legIndex}>
            <div className="mb-1.5 rounded-lg bg-slate-900 px-3 py-2 text-white">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Leg {legIndex + 1} · {legIndex === 0 ? 'to pickup' : 'to dropoff'}
              </div>
              <div className="truncate text-[13px] font-semibold">{leg.from} → {leg.to}</div>
              <div className="text-[11px] text-slate-300">
                {fmtNumber(leg.distance_miles)} mi · {fmtNumber(leg.scheduled_driving_hours, 2)} hrs driving
              </div>
            </div>

            {leg.steps.length === 0 ? (
              <p className="px-2 py-2 text-xs text-slate-500">Driver is already at the pickup - no driving needed.</p>
            ) : (
              <ol>
                {leg.steps.map((step, i) => {
                  const next = leg.steps[i + 1]?.mile ?? legEnd
                  // A stop belongs to the stretch it falls on; stops exactly at the
                  // end of the last leg are covered by the "Arrive" row.
                  const stopsHere = hosStops.filter((s) => s.mile >= step.mile && s.mile < next
                    && (s.mile < legEnd || isLastLeg))
                  return (
                    <li key={i}>
                      <StepRow step={step} onClick={() => onFocus({ lat: step.lat, lon: step.lon, zoom: 14 })} />
                      {stopsHere.map((stop, j) => (
                        <StopRow key={j} stop={stop} onClick={() => onFocus(stop)} />
                      ))}
                    </li>
                  )
                })}
              </ol>
            )}
          </section>
        )
      })}
      <p className="px-1 text-[10.5px] text-slate-400">Directions © OSRM / OpenStreetMap. Verify truck restrictions (height, weight, hazmat) before driving.</p>
    </div>
  )
}

function StepRow({ step, onClick }) {
  const Icon = maneuverIcon(step.maneuver, step.modifier)
  const isEndpoint = step.maneuver === 'depart' || step.maneuver === 'arrive'
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/80"
    >
      <span className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-md ${isEndpoint ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
        <Icon className="size-3.5" strokeWidth={2.4} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] leading-snug text-slate-800">{step.instruction}</span>
        <span className="block text-[10.5px] text-slate-400">
          mi {fmtNumber(step.mile)}
          {step.distance_miles > 0 && ` · then ${fmtNumber(step.distance_miles, step.distance_miles < 10 ? 1 : 0)} mi`}
        </span>
      </span>
    </button>
  )
}

function StopRow({ stop, onClick }) {
  const { Icon, color, label } = STOP_TYPES[stop.type]
  return (
    <button
      type="button"
      onClick={onClick}
      className="my-0.5 ml-4 flex w-[calc(100%-1rem)] items-center gap-2 rounded-lg border-l-2 py-1.5 pl-2.5 pr-2 text-left transition hover:bg-white/80"
      style={{ borderColor: color, background: `${color}0f` }}
    >
      <span className="grid size-5 shrink-0 place-items-center rounded-full text-white" style={{ background: color }}>
        <Icon className="size-3" />
      </span>
      <span className="min-w-0 flex-1 text-[11.5px]">
        <span className="font-semibold text-slate-800">{label}</span>
        <span className="text-slate-500"> · {stop.label}</span>
        <span className="block text-[10.5px] text-slate-400">
          Day {stop.day} · {fmtDateTime(stop.arrival)} · {fmtDuration(stop.duration_minutes)}
        </span>
      </span>
    </button>
  )
}
