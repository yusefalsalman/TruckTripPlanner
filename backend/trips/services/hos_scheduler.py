"""
FMCSA Hours-of-Service (HOS) scheduling engine.

Rules modelled (property-carrying driver, 70-hour / 8-day cycle, 49 CFR 395):

* 11-hour driving limit   - max 11 h of driving per duty period.
* 14-hour duty window     - no driving after the 14th hour since the first
                            on-duty activity of the duty period.
* 30-minute break         - required once 8 cumulative hours of driving have
                            accrued without a >= 30 consecutive minute
                            non-driving interruption (any non-driving status
                            counts, per the 2020 rule; the inserted break is
                            logged as Off Duty).
* 10-hour rest            - 10 consecutive hours off duty / sleeper berth reset
                            the 11 and 14 hour clocks (logged as Sleeper Berth).
* 70-hour / 8-day cycle   - on-duty time (driving + on duty not driving) is
                            added to the hours already used. When the cycle is
                            exhausted a 34-hour restart is inserted.
* Fuel                    - a 30 minute On Duty fuel stop at least every
                            1,000 driven miles.
* Pickup / Dropoff        - 1 hour On Duty (not driving) each.

Design notes
------------
* All times are **integer minutes** measured from 00:00 of the first log day,
  and every activity is aligned to a 15-minute grid (the resolution of the
  paper log graph). Integer arithmetic means each day's totals sum to exactly
  24.00 hours - there is no floating point drift.
* The engine is pure Python (no Django imports) so it is trivially unit
  testable and reusable.
* ``validate_schedule`` re-checks a finished schedule against the rules
  independently of the scheduler's own bookkeeping; the API reports its
  result as the HOS compliance badge.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable

# --------------------------------------------------------------------------- #
# Duty statuses (the four lines of the log graph, top to bottom)
# --------------------------------------------------------------------------- #
OFF_DUTY = "off_duty"
SLEEPER_BERTH = "sleeper_berth"
DRIVING = "driving"
ON_DUTY = "on_duty"
STATUSES = (OFF_DUTY, SLEEPER_BERTH, DRIVING, ON_DUTY)
ON_DUTY_STATUSES = frozenset({DRIVING, ON_DUTY})
REST_STATUSES = frozenset({OFF_DUTY, SLEEPER_BERTH})

# Activities (what the driver is doing; several map to the same status)
ACT_PRE_TRIP_OFF = "pre_trip_off"
ACT_DRIVE = "drive"
ACT_PICKUP = "pickup"
ACT_DROPOFF = "dropoff"
ACT_BREAK = "break"
ACT_REST = "rest"
ACT_FUEL = "fuel"
ACT_RESTART = "restart"
ACT_POST_TRIP_OFF = "post_trip_off"

MINUTES_PER_DAY = 24 * 60
_EPS = 1e-6


class HOSError(ValueError):
    """Raised for inputs the scheduler cannot work with."""


@dataclass(frozen=True)
class HOSConfig:
    """Every regulatory constant in one place (minutes / miles)."""

    max_driving_minutes: int = 11 * 60
    duty_window_minutes: int = 14 * 60
    driving_before_break_minutes: int = 8 * 60
    break_minutes: int = 30
    rest_minutes: int = 10 * 60
    cycle_limit_minutes: int = 70 * 60
    restart_minutes: int = 34 * 60
    pickup_minutes: int = 60
    dropoff_minutes: int = 60
    fuel_minutes: int = 30
    fuel_interval_miles: float = 1000.0
    quantum_minutes: int = 15
    rest_status: str = SLEEPER_BERTH

    def floor_q(self, minutes: float) -> int:
        """Round *down* to the 15-minute grid (never exceeds a limit)."""
        q = self.quantum_minutes
        return int(math.floor(minutes / q + _EPS)) * q

    def ceil_q(self, minutes: float) -> int:
        """Round *up* to the 15-minute grid (never under-estimates driving)."""
        q = self.quantum_minutes
        return int(math.ceil(minutes / q - _EPS)) * q


DEFAULT_CONFIG = HOSConfig()


@dataclass(frozen=True)
class Leg:
    """One driving leg (current -> pickup, or pickup -> dropoff)."""

    miles: float
    minutes: int  # multiple of the 15-minute quantum

    @classmethod
    def from_route(
        cls,
        miles: float,
        seconds: float,
        max_avg_mph: float = 55.0,
        config: HOSConfig = DEFAULT_CONFIG,
    ) -> "Leg":
        """
        Build a leg from router output. Car-profile durations are slowed down
        to ``max_avg_mph`` for a loaded truck and rounded up to 15 minutes.
        Legs shorter than 0.1 mi (e.g. driver already at the pickup) are empty.
        """
        if miles < 0.1:
            return cls(miles=0.0, minutes=0)
        raw_minutes = max(seconds / 60.0, miles / max_avg_mph * 60.0)
        return cls(miles=miles, minutes=max(config.quantum_minutes, config.ceil_q(raw_minutes)))


@dataclass
class Segment:
    """A continuous block of a single duty status."""

    status: str
    start: int  # absolute minutes since 00:00 of day 1
    end: int
    activity: str
    note: str
    start_mile: float
    end_mile: float
    cycle_before: float = 0.0  # 70-hr cycle minutes used when segment starts
    cycle_after: float = 0.0  # ... and when it ends (after any 34-hr reset)

    @property
    def minutes(self) -> int:
        return self.end - self.start

    @property
    def miles(self) -> float:
        return self.end_mile - self.start_mile


@dataclass
class ScheduleResult:
    segments: list[Segment]
    start_minute: int  # when the driver goes on duty
    end_minute: int  # when the dropoff is complete
    total_days: int
    total_miles: float
    cycle_used_start_minutes: float
    cycle_used_end_minutes: float
    restarts: int
    config: HOSConfig = field(default=DEFAULT_CONFIG, repr=False)

    def minutes_by_status(self) -> dict[str, int]:
        totals = {s: 0 for s in STATUSES}
        for seg in self.segments:
            if seg.activity in (ACT_PRE_TRIP_OFF, ACT_POST_TRIP_OFF):
                continue
            totals[seg.status] += seg.minutes
        return totals

    def count(self, activity: str) -> int:
        return sum(1 for seg in self.segments if seg.activity == activity)


# --------------------------------------------------------------------------- #
# Scheduler
# --------------------------------------------------------------------------- #
class HOSScheduler:
    """
    Event-driven simulation: drive in the largest chunk that no limit forbids,
    then satisfy whichever limit was hit (break, rest, fuel, restart).

    Usage::

        result = HOSScheduler([leg_to_pickup, leg_to_dropoff], cycle_used_hours=12,
                              start_minute=8 * 60).run()
    """

    def __init__(
        self,
        legs: Iterable[Leg],
        cycle_used_hours: float,
        start_minute: int = 8 * 60,
        config: HOSConfig = DEFAULT_CONFIG,
    ):
        self.cfg = config
        self.legs = list(legs)
        if len(self.legs) != 2:
            raise HOSError("Exactly two legs are required (to pickup, to dropoff).")
        if any(leg.miles < 0 or leg.minutes < 0 for leg in self.legs):
            raise HOSError("Leg distance and duration must be non-negative.")
        if any(leg.minutes % config.quantum_minutes for leg in self.legs):
            raise HOSError(f"Leg durations must be multiples of {config.quantum_minutes} minutes.")
        if not 0 <= cycle_used_hours <= config.cycle_limit_minutes / 60:
            raise HOSError(
                f"Current cycle used must be between 0 and {config.cycle_limit_minutes / 60:g} hours."
            )
        if not 0 <= start_minute < MINUTES_PER_DAY:
            raise HOSError("Start time must fall within the first day.")
        for leg in self.legs:
            if leg.minutes and leg.miles / leg.minutes * config.quantum_minutes >= config.fuel_interval_miles:
                raise HOSError("Leg speed is unrealistically high.")

        self.start_minute = config.floor_q(start_minute)
        self.cycle_used_start = round(cycle_used_hours * 60, 4)

        # ---- simulation state ------------------------------------------------
        self.t = self.start_minute
        self.mile = 0.0
        self.segments: list[Segment] = []
        self.shift_start: int | None = None  # start of current 14-hr window
        self.drive_in_shift = 0  # minutes driven toward the 11-hr limit
        self.drive_since_break = 0  # minutes driven toward the 8-hr break rule
        self.non_driving_streak = 0  # consecutive non-driving minutes
        self.rest_streak = 0  # consecutive off-duty/sleeper minutes
        self.cycle_used = self.cycle_used_start  # minutes on duty in the 70-hr cycle
        self.miles_since_fuel = 0.0  # truck starts with a full tank
        self.restarts = 0

    # ---- public --------------------------------------------------------------
    def run(self) -> ScheduleResult:
        cfg = self.cfg
        if self.start_minute > 0:
            # Midnight -> departure is logged as off duty (driver was resting).
            self.segments.append(
                Segment(OFF_DUTY, 0, self.start_minute, ACT_PRE_TRIP_OFF, "Off duty",
                        0.0, 0.0, self.cycle_used, self.cycle_used)
            )

        self._drive_leg(self.legs[0], "Driving to pickup")
        self._on_duty_task(cfg.pickup_minutes, ACT_PICKUP, "Pickup - loading")
        self._drive_leg(self.legs[1], "Driving to dropoff")
        self._on_duty_task(cfg.dropoff_minutes, ACT_DROPOFF, "Dropoff - unloading")
        end_minute = self.t

        # Pad the last log day with off-duty time so every day spans 24 hours.
        total_days = max(1, math.ceil(end_minute / MINUTES_PER_DAY))
        day_end = total_days * MINUTES_PER_DAY
        if day_end > end_minute:
            self.segments.append(
                Segment(OFF_DUTY, end_minute, day_end, ACT_POST_TRIP_OFF, "Off duty",
                        self.mile, self.mile, self.cycle_used, self.cycle_used)
            )

        return ScheduleResult(
            segments=self.segments,
            start_minute=self.start_minute,
            end_minute=end_minute,
            total_days=total_days,
            total_miles=self.mile,
            cycle_used_start_minutes=self.cycle_used_start,
            cycle_used_end_minutes=self.cycle_used,
            restarts=self.restarts,
            config=cfg,
        )

    # ---- limits --------------------------------------------------------------
    def _cycle_available(self) -> float:
        return self.cfg.cycle_limit_minutes - self.cycle_used

    def _window_left(self) -> int:
        if self.shift_start is None:  # driving now would open a fresh window
            return self.cfg.duty_window_minutes
        return self.shift_start + self.cfg.duty_window_minutes - self.t

    def _hos_drive_cap(self) -> int:
        """Longest legal driving chunk right now (multiple of the quantum)."""
        cfg = self.cfg
        return min(
            cfg.max_driving_minutes - self.drive_in_shift,
            self._window_left(),
            cfg.driving_before_break_minutes - self.drive_since_break,
            cfg.floor_q(self._cycle_available()),
        )

    def _fuel_cap(self, miles_per_minute: float) -> int:
        """Minutes that can be driven before the fuel interval is exceeded."""
        # The tolerance absorbs float drift from summing many chunk distances.
        miles_left = self.cfg.fuel_interval_miles - self.miles_since_fuel + 1e-6
        return self.cfg.floor_q(max(0.0, miles_left) / miles_per_minute)

    # ---- actions -------------------------------------------------------------
    def _ensure_can_drive(self) -> None:
        """Insert whatever rest is needed until at least one quantum of driving is legal."""
        cfg, q = self.cfg, self.cfg.quantum_minutes
        while True:
            if self._cycle_available() < q:
                self._restart()
            elif cfg.max_driving_minutes - self.drive_in_shift < q or self._window_left() < q:
                self._rest()
            elif cfg.driving_before_break_minutes - self.drive_since_break < q:
                # A break that would consume the rest of the 14-hr window is
                # pointless - take the 10-hour rest instead.
                if self._window_left() - cfg.break_minutes < q:
                    self._rest()
                else:
                    self._break()
            else:
                return

    def _drive_leg(self, leg: Leg, note: str) -> None:
        if leg.minutes == 0:
            self.mile += leg.miles
            return
        speed = leg.miles / leg.minutes  # miles per minute
        leg_start_mile = self.mile
        driven = 0
        while driven < leg.minutes:
            self._ensure_can_drive()
            fuel_cap = self._fuel_cap(speed)
            if fuel_cap < self.cfg.quantum_minutes:
                self._on_duty_task(self.cfg.fuel_minutes, ACT_FUEL, "Fuel stop")
                continue  # fueling used window time; re-check limits
            chunk = min(leg.minutes - driven, self._hos_drive_cap(), fuel_cap)
            driven += chunk
            # Derive the mile marker from the leg fraction so it lands exactly
            # on the leg's end without accumulated floating point error.
            end_mile = leg_start_mile + leg.miles * driven / leg.minutes
            self._append(DRIVING, chunk, ACT_DRIVE, note, end_mile)

    def _on_duty_task(self, minutes: int, activity: str, note: str) -> None:
        while self._cycle_available() < minutes:
            self._restart()
        self._append(ON_DUTY, minutes, activity, note, self.mile)
        if activity == ACT_FUEL:
            self.miles_since_fuel = 0.0

    def _break(self) -> None:
        self._append(OFF_DUTY, self.cfg.break_minutes, ACT_BREAK, "30-min rest break", self.mile)

    def _rest(self) -> None:
        self._append(self.cfg.rest_status, self.cfg.rest_minutes, ACT_REST,
                     "10-hr sleeper berth rest", self.mile)

    def _restart(self) -> None:
        self.restarts += 1
        self._append(OFF_DUTY, self.cfg.restart_minutes, ACT_RESTART,
                     "34-hr restart (70-hr cycle reset)", self.mile)

    # ---- bookkeeping ---------------------------------------------------------
    def _append(self, status: str, minutes: int, activity: str, note: str, end_mile: float) -> None:
        cfg = self.cfg
        cycle_before = self.cycle_used
        seg = Segment(status, self.t, self.t + minutes, activity, note,
                      self.mile, end_mile, cycle_before, cycle_before)

        if status in ON_DUTY_STATUSES:
            if self.shift_start is None:
                self.shift_start = self.t
            self.cycle_used += minutes
            self.rest_streak = 0
        else:
            self.rest_streak += minutes
            if self.rest_streak >= cfg.rest_minutes:
                self.shift_start = None
                self.drive_in_shift = 0
            if self.rest_streak >= cfg.restart_minutes:
                self.cycle_used = 0.0

        if status == DRIVING:
            self.drive_in_shift += minutes
            self.drive_since_break += minutes
            self.non_driving_streak = 0
            self.miles_since_fuel += end_mile - self.mile
        else:
            self.non_driving_streak += minutes
            if self.non_driving_streak >= cfg.break_minutes:
                self.drive_since_break = 0

        seg.cycle_after = self.cycle_used
        self.segments.append(seg)
        self.t += minutes
        self.mile = end_mile


# --------------------------------------------------------------------------- #
# Calendar-day splitting
# --------------------------------------------------------------------------- #
@dataclass
class DaySegment:
    status: str
    start: int  # minutes since this day's midnight (0-1440)
    end: int
    activity: str
    note: str
    start_mile: float
    end_mile: float
    is_continuation: bool  # began on a previous day

    @property
    def minutes(self) -> int:
        return self.end - self.start


@dataclass
class DayLog:
    day_index: int  # 0-based
    segments: list[DaySegment]
    minutes_by_status: dict[str, int]
    miles_driven: float
    on_duty_minutes: int
    cycle_start_minutes: float  # cycle used at 00:00
    cycle_end_minutes: float  # cycle used at 24:00 (A in the recap)
    start_mile: float
    end_mile: float


def _cycle_at(seg: Segment, absolute_minute: int) -> float:
    """Cycle minutes used at an instant inside ``seg``."""
    if absolute_minute >= seg.end:
        return seg.cycle_after
    if seg.status in ON_DUTY_STATUSES:
        return seg.cycle_before + (absolute_minute - seg.start)
    return seg.cycle_before


def split_into_days(result: ScheduleResult) -> list[DayLog]:
    """Clip the continuous schedule into 24-hour calendar-day log sheets."""
    days: list[DayLog] = []
    for day in range(result.total_days):
        day_start = day * MINUTES_PER_DAY
        day_end = day_start + MINUTES_PER_DAY
        segs: list[DaySegment] = []
        totals = {s: 0 for s in STATUSES}
        miles = 0.0
        cycle_start = cycle_end = None
        start_mile = end_mile = None

        for seg in result.segments:
            lo, hi = max(seg.start, day_start), min(seg.end, day_end)
            if lo >= hi:
                continue
            frac_lo = (lo - seg.start) / seg.minutes
            frac_hi = (hi - seg.start) / seg.minutes
            s_mile = seg.start_mile + seg.miles * frac_lo
            e_mile = seg.start_mile + seg.miles * frac_hi
            segs.append(DaySegment(seg.status, lo - day_start, hi - day_start, seg.activity,
                                   seg.note, s_mile, e_mile, seg.start < day_start))
            totals[seg.status] += hi - lo
            if seg.status == DRIVING:
                miles += e_mile - s_mile
            if cycle_start is None:
                cycle_start = _cycle_at(seg, lo)
                start_mile = s_mile
            cycle_end = _cycle_at(seg, hi)
            end_mile = e_mile

        days.append(DayLog(
            day_index=day,
            segments=segs,
            minutes_by_status=totals,
            miles_driven=miles,
            on_duty_minutes=totals[DRIVING] + totals[ON_DUTY],
            cycle_start_minutes=cycle_start or 0.0,
            cycle_end_minutes=cycle_end or 0.0,
            start_mile=start_mile or 0.0,
            end_mile=end_mile or 0.0,
        ))
    return days


# --------------------------------------------------------------------------- #
# Independent compliance validator
# --------------------------------------------------------------------------- #
def validate_schedule(result: ScheduleResult) -> list[str]:
    """
    Re-derive every HOS clock from the raw segment list and return a list of
    human-readable violations (empty list == compliant).
    """
    cfg = result.config
    segs = result.segments
    violations: list[str] = []

    def hhmm(minute: int) -> str:
        day, rem = divmod(minute, MINUTES_PER_DAY)
        return f"Day {day + 1} {rem // 60:02d}:{rem % 60:02d}"

    # Continuity & coverage of whole days
    if not segs or segs[0].start != 0:
        violations.append("Log does not start at midnight of day 1.")
    for prev, cur in zip(segs, segs[1:]):
        if prev.end != cur.start:
            violations.append(f"Gap/overlap in log at {hhmm(prev.end)}.")
    if segs and segs[-1].end != result.total_days * MINUTES_PER_DAY:
        violations.append("Log does not end at midnight of the last day.")

    shift_start = None
    drive_in_shift = 0
    drive_since_break = 0
    non_driving = 0
    rest_streak = 0
    cycle = result.cycle_used_start_minutes
    miles_since_fuel = 0.0

    for seg in segs:
        if seg.status in REST_STATUSES:
            rest_streak += seg.minutes
            non_driving += seg.minutes
            if rest_streak >= cfg.rest_minutes:
                shift_start, drive_in_shift = None, 0
            if rest_streak >= cfg.restart_minutes:
                cycle = 0
            if non_driving >= cfg.break_minutes:
                drive_since_break = 0
            continue

        # on duty or driving
        rest_streak = 0
        if shift_start is None:
            shift_start = seg.start
        cycle += seg.minutes
        if cycle > cfg.cycle_limit_minutes + _EPS:
            violations.append(f"70-hour/8-day limit exceeded at {hhmm(seg.end)}.")

        if seg.status == ON_DUTY:
            non_driving += seg.minutes
            if non_driving >= cfg.break_minutes:
                drive_since_break = 0
            if seg.activity == ACT_FUEL:
                miles_since_fuel = 0.0
            continue

        # driving
        non_driving = 0
        drive_in_shift += seg.minutes
        drive_since_break += seg.minutes
        miles_since_fuel += seg.miles
        if drive_in_shift > cfg.max_driving_minutes:
            violations.append(f"11-hour driving limit exceeded at {hhmm(seg.end)}.")
        if seg.end > shift_start + cfg.duty_window_minutes:
            violations.append(f"Driving after the 14-hour window at {hhmm(seg.end)}.")
        if drive_since_break > cfg.driving_before_break_minutes:
            violations.append(f"8 hours driving without a 30-min break at {hhmm(seg.end)}.")
        if miles_since_fuel > cfg.fuel_interval_miles + 1e-3:
            violations.append(f"More than {cfg.fuel_interval_miles:g} miles without fuel at {hhmm(seg.end)}.")

    for day in split_into_days(result):
        if sum(day.minutes_by_status.values()) != MINUTES_PER_DAY:
            violations.append(f"Day {day.day_index + 1} totals do not equal 24 hours.")

    # De-duplicate while preserving order
    return list(dict.fromkeys(violations))
