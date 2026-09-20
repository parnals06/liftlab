/**
 * Debug helpers. Loaded lazily, and only when the page is opened with `?dev=1`.
 *
 * These exist so the app can be worked on without doing a 3.5-hour leg session
 * first. Everything here writes obviously-fake data: seeded sessions are named
 * with a `[DEV]` prefix so a real log is never mistaken for one, and so they can
 * be filtered out of the analysis pipeline by name.
 */

import { localDate, newId, SCHEMA_VERSION, type Session, type Store } from "./model";
import { LEG_GAUNTLET, targetLabel, type Prescription } from "./templates";

/** Plausible working loads, by exercise name. Absent = bodyweight or banded. */
const DEMO_LOAD: Record<string, number> = {
  "Landmine squat": 95,
  "KB hinge / swing primer": 53,
  "Zercher squat — ramp": 135,
  "Zercher squat — work": 185,
  "Bulgarian split squat": 40,
  "RDL / straight-leg deadlift": 185,
  "Leg press": 270,
  "Hip thrust": 225,
  "Seated leg curl": 90,
  "Lying leg curl": 70,
  "Hyperextension — 25 lb": 25,
  "Hyperextension — 45 lb": 45,
  "Adductor machine": 120,
  "Abductor machine": 110,
  "Calf raise": 180,
};

/** Middle of the prescribed range, so the numbers look like a real session. */
function demoReps(p: Prescription): number {
  const m = p.reps.match(/(\d+)(?:\s*[–-]\s*(\d+))?/);
  if (!m) return 1;
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  return Math.round((lo + hi) / 2);
}

/**
 * A finished Leg Gauntlet, `daysAgo` days back, written straight to the store.
 *
 * It bypasses SessionService on purpose: the point is to produce history to look
 * at, not to exercise the start/finish path, and it must never touch the active
 * pointer — a seed that stole the pointer would be the exact bug the invariants
 * exist to prevent.
 */
export async function seedGauntlet(store: Store, daysAgo = 0): Promise<Session> {
  const start = new Date();
  start.setDate(start.getDate() - daysAgo);
  start.setHours(9, 30, 0, 0);

  let clock = start.getTime();
  const tick = (ms: number) => new Date((clock += ms)).toISOString();

  const exercises = LEG_GAUNTLET.items.map((p) => {
    const base = DEMO_LOAD[p.name] ?? 0;
    const reps = demoReps(p);
    return {
      id: newId("ex"),
      name: p.name,
      block: p.block,
      kind: p.kind,
      target: targetLabel(p),
      targetSets: p.sets,
      ...(p.perSide ? { perSide: true as const } : {}),
      ...(p.optional ? { optional: true as const } : {}),
      sets: Array.from({ length: p.sets }, (_, i) => ({
        id: newId("set"),
        // Ramp sets climb; everything else holds and drops a rep late on.
        weight: p.name.endsWith("ramp") ? Math.round(base * (0.6 + 0.2 * i)) : base,
        reps: i >= 2 && reps > 6 ? reps - 1 : reps,
        at: tick(150_000),
      })),
    };
  });

  const session: Session = {
    schema: SCHEMA_VERSION,
    id: newId("wk"),
    date: localDate(start),
    name: `[DEV] ${LEG_GAUNTLET.name}`,
    startedAt: start.toISOString(),
    finishedAt: new Date(clock).toISOString(),
    bodyweight: 176,
    notes: "Seeded by ?dev=1. Not a real session.",
    exercises,
  };

  await store.putSession(session);
  return session;
}

/** Everything, including the active pointer. Confirm before calling. */
export async function wipeAll(store: Store): Promise<number> {
  const all = await store.listSessions();
  for (const s of all) await store.deleteSession(s.id);
  await store.setMeta("activeSessionId", null);
  return all.length;
}

/** Seeded sessions only — leaves real logs alone. */
export async function wipeSeeded(store: Store): Promise<number> {
  const all = await store.listSessions();
  const fake = all.filter((s) => s.name.startsWith("[DEV]"));
  for (const s of fake) await store.deleteSession(s.id);
  return fake.length;
}
