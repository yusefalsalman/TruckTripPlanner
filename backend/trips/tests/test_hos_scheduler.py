"""
Boundary and property tests for the HOS engine.

Leg speeds are chosen so mileage maps to whole 15-minute quanta
(60 mph -> 15 mi per quantum, 55 mph etc. are covered by the random sweep).
"""
import random
from unittest import TestCase

from trips.services.hos_scheduler import (
    ACT_BREAK, ACT_DROPOFF, ACT_FUEL, ACT_PICKUP, ACT_POST_TRIP_OFF, ACT_PRE_TRIP_OFF,
    ACT_REST, ACT_RESTART, DRIVING, MINUTES_PER_DAY, OFF_DUTY, ON_DUTY, SLEEPER_BERTH,
    HOSConfig, HOSError, HOSScheduler, Leg, split_into_days, validate_schedule,
)

H = 60  # minutes per hour


def leg(hours: float, mph: float = 60.0) -> Leg:
    """A leg of exactly ``hours`` of driving at ``mph``."""
    return Leg(miles=hours * mph, minutes=round(hours * H))


def run(leg1, leg2, cycle=0.0, start=8 * H, config=HOSConfig()):
    result = HOSScheduler([leg1, leg2], cycle, start, config).run()
    return result, [s for s in result.segments
                    if s.activity not in (ACT_PRE_TRIP_OFF, ACT_POST_TRIP_OFF)]


def acts(segments):
    return [s.activity for s in segments]


class InvariantMixin:
    def assert_valid(self, result):
        self.assertEqual(validate_schedule(result), [])
        for day in split_into_days(result):
            self.assertEqual(sum(day.minutes_by_status.values()), MINUTES_PER_DAY)
            self.assertEqual(day.segments[0].start, 0)
            self.assertEqual(day.segments[-1].end, MINUTES_PER_DAY)


class LegTests(TestCase):
    def test_short_leg_is_empty(self):
        self.assertEqual(Leg.from_route(0.05, 30), Leg(0.0, 0))

    def test_rounds_up_to_quarter_hour(self):
        self.assertEqual(Leg.from_route(10, 60 * 10, max_avg_mph=60).minutes, 15)

    def test_truck_speed_cap_applies(self):
        # 110 miles in 90 car-minutes (73 mph) -> capped to 55 mph -> 120 min
        self.assertEqual(Leg.from_route(110, 90 * 60, max_avg_mph=55).minutes, 120)

    def test_router_slower_than_cap_is_kept(self):
        self.assertEqual(Leg.from_route(100, 3 * 3600, max_avg_mph=55).minutes, 180)


class InputValidationTests(TestCase):
    def test_cycle_out_of_range(self):
        with self.assertRaises(HOSError):
            HOSScheduler([leg(1), leg(1)], 70.5)
        with self.assertRaises(HOSError):
            HOSScheduler([leg(1), leg(1)], -1)

    def test_leg_must_be_on_quarter_hour_grid(self):
        with self.assertRaises(HOSError):
            HOSScheduler([Leg(10, 10), leg(1)], 0)

    def test_requires_two_legs(self):
        with self.assertRaises(HOSError):
            HOSScheduler([leg(1)], 0)

    def test_start_minute_snapped_to_grid(self):
        result = HOSScheduler([leg(1), leg(1)], 0, 8 * H + 7).run()
        self.assertEqual(result.start_minute, 8 * H)


class ShortTripTests(InvariantMixin, TestCase):
    def test_simple_sequence(self):
        result, segs = run(leg(2), leg(3))
        self.assertEqual(acts(segs), ["drive", ACT_PICKUP, "drive", ACT_DROPOFF])
        self.assertEqual(result.total_days, 1)
        self.assertEqual(result.end_minute, 8 * H + 2 * H + H + 3 * H + H)
        self.assert_valid(result)

    def test_pickup_and_dropoff_are_one_hour_on_duty(self):
        _, segs = run(leg(1), leg(1))
        for s in segs:
            if s.activity in (ACT_PICKUP, ACT_DROPOFF):
                self.assertEqual((s.status, s.minutes), (ON_DUTY, 60))

    def test_day_padded_with_off_duty(self):
        result, _ = run(leg(1), leg(1))
        self.assertEqual(result.segments[0].status, OFF_DUTY)
        self.assertEqual(result.segments[-1].status, OFF_DUTY)
        self.assertEqual(result.segments[-1].end, MINUTES_PER_DAY)

    def test_driver_already_at_pickup(self):
        result, segs = run(Leg(0, 0), leg(2))
        self.assertEqual(acts(segs), [ACT_PICKUP, "drive", ACT_DROPOFF])
        self.assert_valid(result)

    def test_midnight_start(self):
        result, _ = run(leg(1), leg(1), start=0)
        self.assertEqual(result.segments[0].activity, "drive")
        self.assert_valid(result)


class BreakRuleTests(InvariantMixin, TestCase):
    def test_exactly_8_hours_needs_no_break(self):
        # Pickup (1 h on duty) interrupts driving, so use an empty first leg.
        result, segs = run(Leg(0, 0), leg(8))
        self.assertNotIn(ACT_BREAK, acts(segs))
        self.assert_valid(result)

    def test_break_inserted_after_8_hours(self):
        result, segs = run(Leg(0, 0), leg(9))
        self.assertEqual(acts(segs), [ACT_PICKUP, "drive", ACT_BREAK, "drive", ACT_DROPOFF])
        first_drive, brk = segs[1], segs[2]
        self.assertEqual(first_drive.minutes, 8 * H)
        self.assertEqual((brk.status, brk.minutes), (OFF_DUTY, 30))
        self.assert_valid(result)

    def test_pickup_counts_as_break(self):
        # 6 h drive, 1 h pickup (>= 30 min non-driving), 5 h drive: no break.
        result, segs = run(leg(6), leg(5))
        self.assertNotIn(ACT_BREAK, acts(segs))
        self.assert_valid(result)


class DrivingLimitTests(InvariantMixin, TestCase):
    def test_11_hour_limit_triggers_10_hour_rest(self):
        result, segs = run(Leg(0, 0), leg(12))
        driving_before_rest = 0
        for s in segs:
            if s.activity == ACT_REST:
                break
            if s.status == DRIVING:
                driving_before_rest += s.minutes
        self.assertEqual(driving_before_rest, 11 * H)
        rest = next(s for s in segs if s.activity == ACT_REST)
        self.assertEqual((rest.status, rest.minutes), (SLEEPER_BERTH, 10 * H))
        self.assert_valid(result)

    def test_exactly_11_hours_no_rest(self):
        result, segs = run(Leg(0, 0), leg(11))
        self.assertNotIn(ACT_REST, acts(segs))
        self.assert_valid(result)

    def test_14_hour_window_binds_before_11_hours(self):
        # Fuel every 100 mi at 50 mph -> a 30-min on-duty stop every 2 h.
        # On-duty stops eat the 14-h window before 11 h of driving accrue.
        cfg = HOSConfig(fuel_interval_miles=100)
        result, segs = run(Leg(0, 0), leg(20, mph=50), config=cfg)
        shift_start = segs[0].start
        rest = next(s for s in segs if s.activity == ACT_REST)
        driving = sum(s.minutes for s in segs if s.status == DRIVING and s.end <= rest.start)
        self.assertLess(driving, 11 * H)
        last_drive_end = max(s.end for s in segs if s.status == DRIVING and s.end <= rest.start)
        self.assertLessEqual(last_drive_end, shift_start + 14 * H)
        self.assert_valid(result)

    def test_rest_resets_clocks(self):
        result, segs = run(Leg(0, 0), leg(30))
        self.assertGreaterEqual(acts(segs).count(ACT_REST), 2)
        self.assert_valid(result)


class FuelTests(InvariantMixin, TestCase):
    def test_exactly_1000_miles_needs_no_fuel(self):
        result, segs = run(Leg(0, 0), Leg(1000, 1200))  # 50 mph
        self.assertNotIn(ACT_FUEL, acts(segs))
        self.assert_valid(result)

    def test_fuel_inserted_before_1000_miles(self):
        result, segs = run(Leg(0, 0), Leg(1050, 1260))  # 50 mph
        self.assertEqual(acts(segs).count(ACT_FUEL), 1)
        fuel = next(s for s in segs if s.activity == ACT_FUEL)
        self.assertEqual((fuel.status, fuel.minutes), (ON_DUTY, 30))
        self.assertLessEqual(fuel.start_mile, 1000 + 1e-6)
        self.assert_valid(result)

    def test_fuel_interval_spans_both_legs(self):
        result, segs = run(Leg(600, 600), Leg(600, 600))
        self.assertEqual(acts(segs).count(ACT_FUEL), 1)
        self.assert_valid(result)


class CycleTests(InvariantMixin, TestCase):
    def test_cycle_exhausted_at_start_forces_restart(self):
        result, segs = run(leg(1), leg(1), cycle=70)
        self.assertEqual(segs[0].activity, ACT_RESTART)
        self.assertEqual(segs[0].minutes, 34 * H)
        self.assertEqual(result.restarts, 1)
        self.assert_valid(result)

    def test_restart_mid_trip(self):
        # 65 h used: 1 h pickup + ~4 h driving available.
        result, segs = run(Leg(0, 0), leg(8), cycle=65)
        self.assertEqual(result.restarts, 1)
        on_duty_before = sum(s.minutes for s in segs
                             if s.status in (DRIVING, ON_DUTY)
                             and s.end <= next(x for x in segs if x.activity == ACT_RESTART).start)
        self.assertLessEqual(65 * H + on_duty_before, 70 * H)
        self.assert_valid(result)

    def test_non_quarter_cycle_value(self):
        result, _ = run(leg(3), leg(3), cycle=66.4)
        self.assert_valid(result)

    def test_recap_adds_on_duty_hours(self):
        result, _ = run(leg(2), leg(3), cycle=20)
        day = split_into_days(result)[0]
        self.assertEqual(day.on_duty_minutes, 2 * H + H + 3 * H + H)
        self.assertEqual(day.cycle_end_minutes, 20 * H + day.on_duty_minutes)


class DaySplitTests(InvariantMixin, TestCase):
    def test_segment_split_at_midnight(self):
        result, _ = run(leg(1), leg(6), start=20 * H)
        days = split_into_days(result)
        self.assertEqual(len(days), 2)
        self.assertTrue(days[1].segments[0].is_continuation)
        total_miles = sum(d.miles_driven for d in days)
        self.assertAlmostEqual(total_miles, result.total_miles, places=6)
        self.assert_valid(result)

    def test_trip_ending_exactly_at_midnight(self):
        # 22:00 start + 1 h pickup + 1 h dropoff = 24:00 exactly
        result, _ = run(Leg(0, 0), Leg(0, 0), start=22 * H)
        self.assertEqual(result.total_days, 1)
        self.assertEqual(result.segments[-1].activity, ACT_DROPOFF)
        self.assert_valid(result)


class LongHaulTests(InvariantMixin, TestCase):
    def test_cross_country(self):
        # ~2,800 mi at 55 mph with 30 h already used
        result, segs = run(Leg(250, 270), Leg(2550, 2790), cycle=30, start=6 * H)
        self.assertGreaterEqual(acts(segs).count(ACT_FUEL), 2)
        self.assertGreaterEqual(acts(segs).count(ACT_REST), 4)
        self.assertGreaterEqual(result.total_days, 5)
        self.assert_valid(result)


class RandomizedPropertyTests(InvariantMixin, TestCase):
    """Hundreds of random trips must all pass the independent validator."""

    def test_random_trips_are_compliant(self):
        rng = random.Random(1337)
        for _ in range(400):
            mph = rng.uniform(35, 65)
            legs = []
            for _ in range(2):
                miles = rng.choice([0.0, rng.uniform(1, 300), rng.uniform(300, 2500)])
                legs.append(Leg.from_route(miles, miles / mph * 3600, max_avg_mph=mph))
            cycle = rng.choice([0, 70, rng.uniform(0, 70)])
            start = rng.randrange(0, MINUTES_PER_DAY)
            result = HOSScheduler(legs, cycle, start).run()
            with self.subTest(legs=legs, cycle=cycle, start=start):
                self.assert_valid(result)
                self.assertAlmostEqual(result.total_miles, sum(l.miles for l in legs), places=6)
