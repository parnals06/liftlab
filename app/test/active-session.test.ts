import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store-memory";
import { ActiveSessionConflict, SessionService, type Session } from "../src/model";

/**
 * The bug this file exists to prevent:
 *
 *   discarding the current workout caused an old, never-finished workout to
 *   become active — and discarding that one promoted the next one, and so on.
 *
 * The cause was bootstrap logic that asked "is there an unfinished session?"
 * instead of "which session does the active pointer name?". These tests pin the
 * corrected behaviour.
 */

/** A never-finished workout from weeks ago, sitting in history. */
function staleSession(id: string, startedAt: string): Session {
  return {
    schema: 1,
    id,
    date: startedAt.slice(0, 10),
    name: `Old unfinished ${id}`,
    startedAt,
    finishedAt: null,
    exercises: [{ id: `ex_${id}`, name: "Bench Press", sets: [] }],
  };
}

describe("active session invariants", () => {
  it("starts with no active session", async () => {
    const svc = new SessionService(new MemoryStore());
    expect(await svc.getActive()).toBeNull();
  });

  it("runs the full regression sequence: discarding A resurrects nothing", async () => {
    const store = new MemoryStore();
    const svc = new SessionService(store);

    // Two old, never-finished workouts already in the database.
    await store.putSession(staleSession("B", "2026-08-01T18:00:00.000Z"));
    await store.putSession(staleSession("C", "2026-08-08T18:00:00.000Z"));

    // no active session, despite B and C being unfinished
    expect(await svc.getActive()).toBeNull();

    // create A
    const a = await svc.start("Shoulders + Arms");
    expect((await svc.getActive())?.id).toBe(a.id);

    // log into A
    const withEx = await svc.addExercise("Overhead Press");
    const exId = withEx.exercises[0].id;
    await svc.addSet(exId, { weight: 105, reps: 6 });
    await svc.addSet(exId, { weight: 105, reps: 6 });

    // resume A (a fresh service over the same store == reopening the app)
    const resumed = await new SessionService(store).getActive();
    expect(resumed?.id).toBe(a.id);
    expect(resumed?.exercises[0].sets).toHaveLength(2);

    // discard A
    await svc.discardActive();

    // Today shows no active session
    expect(await svc.getActive()).toBeNull();

    // ...and again, because the old bug appeared on the *second* read
    expect(await svc.getActive()).toBeNull();

    // historical B and C remain, still not active
    const abandoned = await svc.abandoned();
    expect(abandoned.map((s) => s.id).sort()).toEqual(["B", "C"]);

    // restart the app: same data, new service instance
    const afterRestart = new SessionService(MemoryStore.restore(store.snapshot()));
    expect(await afterRestart.getActive()).toBeNull();
    expect((await afterRestart.abandoned()).map((s) => s.id).sort()).toEqual(["B", "C"]);

    // A is really gone
    expect(await store.getSession(a.id)).toBeUndefined();
  });

  it("refuses to start a second session while one is active", async () => {
    const svc = new SessionService(new MemoryStore());
    await svc.start("Legs");
    await expect(svc.start("Push")).rejects.toBeInstanceOf(ActiveSessionConflict);
  });

  it("finishing is terminal and clears the pointer", async () => {
    const store = new MemoryStore();
    const svc = new SessionService(store);
    const s = await svc.start("Leg Gauntlet");
    const finished = await svc.finishActive({ notes: "hips fine" });

    expect(finished?.finishedAt).toBeTruthy();
    expect(await svc.getActive()).toBeNull();

    const history = await svc.history();
    expect(history.map((h) => h.id)).toEqual([s.id]);

    // a finished session never becomes active again
    expect(await new SessionService(store).getActive()).toBeNull();
  });

  it("repairs a stale pointer instead of trusting it", async () => {
    const store = new MemoryStore();
    const svc = new SessionService(store);
    await store.setMeta("activeSessionId", "does_not_exist");
    expect(await svc.getActive()).toBeNull();
    expect(await store.getMeta("activeSessionId")).toBeNull();
  });

  it("never promotes an abandoned session, however many there are", async () => {
    const store = new MemoryStore();
    const svc = new SessionService(store);
    for (let i = 0; i < 5; i++) {
      await store.putSession(staleSession(`old${i}`, `2026-07-0${i + 1}T18:00:00.000Z`));
    }
    for (let i = 0; i < 3; i++) {
      await svc.start(`Session ${i}`);
      await svc.discardActive();
      expect(await svc.getActive()).toBeNull();
    }
    expect(await svc.abandoned()).toHaveLength(5);
  });
});

describe("set editing", () => {
  it("appends, edits and deletes sets without touching earlier ones", async () => {
    const svc = new SessionService(new MemoryStore());
    await svc.start("Pull");
    const s1 = await svc.addExercise("Barbell Row");
    const ex = s1.exercises[0].id;

    await svc.addSet(ex, { weight: 135, reps: 8 });
    const s2 = await svc.addSet(ex, { weight: 135, reps: 8, rpe: 8 });
    const second = s2.exercises[0].sets[1];

    const s3 = await svc.editSet(ex, second.id, { reps: 7 });
    expect(s3.exercises[0].sets[0].reps).toBe(8); // first set untouched
    expect(s3.exercises[0].sets[1].reps).toBe(7);

    const s4 = await svc.deleteSet(ex, s3.exercises[0].sets[0].id);
    expect(s4.exercises[0].sets).toHaveLength(1);
    expect(s4.exercises[0].sets[0].id).toBe(second.id);
  });

  it("prefills from the last time the exercise was performed", async () => {
    const store = new MemoryStore();
    const svc = new SessionService(store);

    await svc.start("Push A");
    const a = await svc.addExercise("Overhead Press");
    await svc.addSet(a.exercises[0].id, { weight: 100, reps: 6 });
    await svc.finishActive();

    const last = await svc.lastPerformance("overhead press");
    expect(last).toMatchObject({ weight: 100, reps: 6 });
    expect(await svc.recentExerciseNames()).toContain("Overhead Press");
  });
});
