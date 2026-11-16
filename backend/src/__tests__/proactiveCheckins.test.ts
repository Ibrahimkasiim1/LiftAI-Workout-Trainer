/**
 * Unit tests for the proactive check-in drafting rules (pure function — no DB).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { draftCheckinForUser } from "../services/proactiveCheckins";

const day = (offset: number): string => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    return d.toISOString();
};

const set = (name: string, weight: number, reps: number, daysAgo: number, setNumber = 1) => ({
    exercise_id: null,
    exercise_name: name,
    set_number: setNumber,
    reps_completed: reps,
    weight_used: weight,
    workout_date: day(daysAgo),
});

test("drafts ready_to_progress when top of range hit two sessions straight", () => {
    const draft = draftCheckinForUser({
        firstName: "Alex",
        unit: "kg",
        rows: [set("bench press", 60, 12, 1), set("bench press", 60, 12, 4)],
        daysSinceLastWorkout: 1,
        workoutsThisWeek: 2,
    });
    assert.ok(draft, "expected a draft");
    assert.equal(draft!.kind, "ready_to_progress");
    assert.match(draft!.message, /12 reps/);
    assert.match(draft!.message, /60 kg/);
    assert.match(draft!.message, /Alex/);
    assert.match(draft!.cta ?? "", /Bench Press/);
});

test("converts weights for lbs users", () => {
    const draft = draftCheckinForUser({
        firstName: null,
        unit: "lbs",
        rows: [set("bench press", 60, 12, 1), set("bench press", 60, 12, 4)],
        daysSinceLastWorkout: 1,
        workoutsThisWeek: 1,
    });
    assert.equal(draft!.kind, "ready_to_progress");
    assert.match(draft!.message, /132 lbs/); // 60kg ≈ 132 lbs
    assert.match(draft!.message, /5 lbs/); // lbs increment
});

test("drafts stalled_lift after 4 flat sessions", () => {
    const rows = [1, 4, 7, 10].map((d) => set("squat", 100, 8, d));
    const draft = draftCheckinForUser({
        firstName: null,
        unit: "kg",
        rows,
        daysSinceLastWorkout: 1,
        workoutsThisWeek: 2,
    });
    assert.equal(draft!.kind, "stalled_lift");
    assert.match(draft!.message, /100 kg/);
});

test("drafts comeback nudge after 5+ silent days (but not past 13)", () => {
    const rows = [set("row", 50, 10, 6)];
    const draft = draftCheckinForUser({
        firstName: null,
        unit: "kg",
        rows,
        daysSinceLastWorkout: 6,
        workoutsThisWeek: 0,
    });
    assert.equal(draft!.kind, "comeback");

    const tooLong = draftCheckinForUser({
        firstName: null,
        unit: "kg",
        rows,
        daysSinceLastWorkout: 20,
        workoutsThisWeek: 0,
    });
    assert.equal(tooLong, null);
});

test("drafts streak praise at 3+ sessions this week", () => {
    const rows = [set("curl", 20, 10, 1), set("curl", 20, 10, 3), set("curl", 20, 11, 5)];
    const draft = draftCheckinForUser({
        firstName: null,
        unit: "kg",
        rows,
        daysSinceLastWorkout: 1,
        workoutsThisWeek: 3,
    });
    assert.equal(draft!.kind, "streak");
});

test("returns null when nothing is noteworthy", () => {
    // Two sessions (past the first-week script), no rep-range trigger, no
    // stall, no silence, no streak.
    const draft = draftCheckinForUser({
        firstName: null,
        unit: "kg",
        rows: [set("curl", 20, 10, 1), set("curl", 22.5, 10, 3)],
        daysSinceLastWorkout: 1,
        workoutsThisWeek: 2,
    });
    assert.equal(draft, null);
});

test("drafts first_workout_followup right after the only session ever", () => {
    const draft = draftCheckinForUser({
        firstName: "Alex",
        unit: "kg",
        rows: [set("curl", 20, 10, 0), set("bench press", 40, 8, 0, 2)],
        daysSinceLastWorkout: 0,
        workoutsThisWeek: 1,
    });
    assert.ok(draft, "expected a draft");
    assert.equal(draft!.kind, "first_workout_followup");
    assert.match(draft!.message, /Alex/);
    assert.equal(draft!.dedupeKey, "first_workout_followup");
});

test("drafts day2_after_first a couple days after the only session", () => {
    const draft = draftCheckinForUser({
        firstName: null,
        unit: "kg",
        rows: [set("curl", 20, 10, 2)],
        daysSinceLastWorkout: 2,
        workoutsThisWeek: 1,
    });
    assert.equal(draft!.kind, "day2_after_first");
    assert.match(draft!.title, /Soreness/);
    assert.equal(draft!.dedupeKey, "day2_after_first");
});

test("first-week script yields to normal flows once a second session exists", () => {
    // Same single-session shape but two distinct days → ready_to_progress
    // wins over the activation script.
    const draft = draftCheckinForUser({
        firstName: null,
        unit: "kg",
        rows: [set("bench press", 60, 12, 1), set("bench press", 60, 12, 4)],
        daysSinceLastWorkout: 1,
        workoutsThisWeek: 2,
    });
    assert.equal(draft!.kind, "ready_to_progress");
});

test("single-session user past the first week falls through to comeback", () => {
    const draft = draftCheckinForUser({
        firstName: null,
        unit: "kg",
        rows: [set("curl", 20, 10, 6)],
        daysSinceLastWorkout: 6,
        workoutsThisWeek: 0,
    });
    assert.equal(draft!.kind, "comeback");
});
