/**
 * LiftLab data model and session rules.
 *
 * Everything in this file is pure and storage-agnostic: it talks to a `Store`
 * interface, never to IndexedDB directly. That is what makes the invariants
 * testable in Node with no browser and no fake-indexeddb shim.
 *
 * The invariants (see ../../REQUIREMENTS.md):
 *   1. at most one active session, identified by a single pointer
 *   2. bootstrap reads the pointer and NEVER scans history for a candidate
 *   3. discard clears the pointer and promotes nothing
 *   4. finish is terminal and clears the pointer in the same operation
 */

export const SCHEMA_VERSION = 1 as const;

export type SetEntry = {
  id: string;
  weight: number;
  reps: number;
  rpe?: number;
  at: string; // ISO-8601
};

/**
 * How the entry row behaves. Stored on the exercise so a session read back
 * months later still knows that "Bird dog 8" meant reps and no load.
 *   load — weight and reps, weight required
 *   reps — reps required, weight optional
 *   mark — no numbers, one "Done" tap
 */
export type EntryKind = "load" | "reps" | "mark";

export type ExerciseEntry = {
  id: string;
  name: string;
  sets: SetEntry[];
  /**
   * The fields below are present only when the exercise came from a template.
   * All optional, so a schema-1 session written before templates existed still
   * parses, and a free-form exercise added mid-session still works.
   */
  block?: string;
  /** Display string for the prescription, e.g. "3–4 × 5–6". Never parsed. */
  target?: string;
  /** Minimum logged sets that counts as complete. */
  targetSets?: number;
  kind?: EntryKind;
  /** Reps were logged per side; volume counts each set twice. */
  perSide?: boolean;
  /** Skippable without the session counting as incomplete. */
  optional?: boolean;
  note?: string;
};

/** An exercise row before it has an id or any sets — what a template hands over. */
export type ExerciseSeed = Omit<ExerciseEntry, "id" | "sets">;

export type Session = {
  schema: typeof SCHEMA_VERSION;
  id: string;
  date: string; // YYYY-MM-DD, local day the session started
  name: string;
  startedAt: string;
  finishedAt: string | null;
  bodyweight?: number;
  notes?: string;
  /** Set when the session was started from a template in `templates.ts`. */
  templateId?: string;
  exercises: ExerciseEntry[];
};

/** The only mutable pointer in the system. */
export const ACTIVE_KEY = "activeSessionId";

export interface Store {
  getSession(id: string): Promise<Session | undefined>;
  putSession(s: Session): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** Newest first. */
  listSessions(): Promise<Session[]>;
  getMeta<T = unknown>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

// ---------------------------------------------------------------- helpers

const pad = (n: number) => String(n).padStart(2, "0");

export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let counter = 0;
export function newId(prefix = "s"): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${Date.now().toString(36)}_${counter}${rand}`;
}

export class ActiveSessionConflict extends Error {
  constructor(public readonly activeId: string) {
    super(`a session is already active: ${activeId}`);
    this.name = "ActiveSessionConflict";
  }
}

// ---------------------------------------------------------------- service

export class SessionService {
  constructor(private readonly store: Store) {}

  /**
   * INVARIANT 2. Reads the pointer, nothing else.
   *
   * The pointer is treated as a claim that may be stale: if it names a session
   * that is missing or already finished, the pointer is repaired to null. What
   * this must never do is look through history for "the most recent unfinished
   * session" — that is precisely the behaviour that made discarding one workout
   * resurrect another.
   */
  async getActive(): Promise<Session | null> {
    const id = await this.store.getMeta<string | null>(ACTIVE_KEY);
    if (!id) return null;

    const session = await this.store.getSession(id);
    if (!session || session.finishedAt !== null) {
      await this.store.setMeta(ACTIVE_KEY, null);
      return null;
    }
    return session;
  }

  async start(name: string, opts: { bodyweight?: number } = {}): Promise<Session> {
    return this.startSeeded(name, [], opts);
  }

  /**
   * Start a session with its exercise rows already laid out — how a template
   * begins. INVARIANT 1 is unchanged: the conflict check happens first, and the
   * pointer is still written exactly once.
   *
   * Seeding costs one write, not one per exercise. A 26-row template must not
   * be 26 round-trips to IndexedDB on a phone in a gym.
   */
  async startSeeded(
    name: string,
    seeds: readonly ExerciseSeed[],
    opts: { bodyweight?: number; templateId?: string } = {},
  ): Promise<Session> {
    const existing = await this.getActive();
    if (existing) throw new ActiveSessionConflict(existing.id);

    const now = new Date();
    const session: Session = {
      schema: SCHEMA_VERSION,
      id: newId("wk"),
      date: localDate(now),
      name: name.trim() || "Workout",
      startedAt: now.toISOString(),
      finishedAt: null,
      exercises: seeds.map((seed) => ({ ...seed, id: newId("ex"), sets: [] })),
      ...(opts.bodyweight !== undefined ? { bodyweight: opts.bodyweight } : {}),
      ...(opts.templateId !== undefined ? { templateId: opts.templateId } : {}),
    };

    await this.store.putSession(session);
    await this.store.setMeta(ACTIVE_KEY, session.id);
    return session;
  }

  /** INVARIANT 3. Deletes the active session and promotes nothing. */
  async discardActive(): Promise<void> {
    const id = await this.store.getMeta<string | null>(ACTIVE_KEY);
    await this.store.setMeta(ACTIVE_KEY, null);
    if (id) await this.store.deleteSession(id);
  }

  /** INVARIANT 4. Terminal, and clears the pointer. */
  async finishActive(patch: { notes?: string; bodyweight?: number } = {}): Promise<Session | null> {
    const session = await this.getActive();
    if (!session) return null;

    const finished: Session = {
      ...session,
      ...patch,
      finishedAt: new Date().toISOString(),
    };
    await this.store.putSession(finished);
    await this.store.setMeta(ACTIVE_KEY, null);
    return finished;
  }

  // -------------------------------------------------------------- editing

  private async mutate(fn: (s: Session) => Session): Promise<Session> {
    const session = await this.getActive();
    if (!session) throw new Error("no active session");
    const next = fn(session);
    await this.store.putSession(next);
    return next;
  }

  addExercise(name: string): Promise<Session> {
    return this.mutate((s) => ({
      ...s,
      exercises: [...s.exercises, { id: newId("ex"), name: name.trim(), sets: [] }],
    }));
  }

  /** INVARIANT 5. One append = one write. */
  addSet(exerciseId: string, set: { weight: number; reps: number; rpe?: number }): Promise<Session> {
    return this.mutate((s) => ({
      ...s,
      exercises: s.exercises.map((ex) =>
        ex.id !== exerciseId
          ? ex
          : {
              ...ex,
              sets: [
                ...ex.sets,
                {
                  id: newId("set"),
                  weight: set.weight,
                  reps: set.reps,
                  ...(set.rpe !== undefined ? { rpe: set.rpe } : {}),
                  at: new Date().toISOString(),
                },
              ],
            },
      ),
    }));
  }

  editSet(
    exerciseId: string,
    setId: string,
    patch: Partial<Pick<SetEntry, "weight" | "reps" | "rpe">>,
  ): Promise<Session> {
    return this.mutate((s) => ({
      ...s,
      exercises: s.exercises.map((ex) =>
        ex.id !== exerciseId
          ? ex
          : { ...ex, sets: ex.sets.map((st) => (st.id === setId ? { ...st, ...patch } : st)) },
      ),
    }));
  }

  deleteSet(exerciseId: string, setId: string): Promise<Session> {
    return this.mutate((s) => ({
      ...s,
      exercises: s.exercises.map((ex) =>
        ex.id !== exerciseId ? ex : { ...ex, sets: ex.sets.filter((st) => st.id !== setId) },
      ),
    }));
  }

  deleteExercise(exerciseId: string): Promise<Session> {
    return this.mutate((s) => ({
      ...s,
      exercises: s.exercises.filter((ex) => ex.id !== exerciseId),
    }));
  }

  setNotes(notes: string): Promise<Session> {
    return this.mutate((s) => ({ ...s, notes }));
  }

  setBodyweight(bodyweight: number): Promise<Session> {
    return this.mutate((s) => ({ ...s, bodyweight }));
  }

  // -------------------------------------------------------------- history

  /** Finished sessions only. Newest first. */
  async history(): Promise<Session[]> {
    const all = await this.store.listSessions();
    return all.filter((s) => s.finishedAt !== null);
  }

  /**
   * Unfinished sessions that are not the active one: abandoned, not resumable.
   * Surfaced so they can be deleted deliberately, never auto-promoted.
   */
  async abandoned(): Promise<Session[]> {
    const activeId = (await this.store.getMeta<string | null>(ACTIVE_KEY)) ?? null;
    const all = await this.store.listSessions();
    return all.filter((s) => s.finishedAt === null && s.id !== activeId);
  }

  async deleteSession(id: string): Promise<void> {
    const activeId = await this.store.getMeta<string | null>(ACTIVE_KEY);
    if (activeId === id) await this.store.setMeta(ACTIVE_KEY, null);
    await this.store.deleteSession(id);
  }

  /** Names already used, most recent first — powers the exercise autocomplete. */
  async recentExerciseNames(limit = 40): Promise<string[]> {
    const all = await this.store.listSessions();
    const seen: string[] = [];
    for (const s of all) {
      for (const ex of s.exercises) {
        if (!seen.some((n) => n.toLowerCase() === ex.name.toLowerCase())) seen.push(ex.name);
      }
      if (seen.length >= limit) break;
    }
    return seen.slice(0, limit);
  }

  /** The last load/reps logged for an exercise, for prefilling the entry row. */
  async lastPerformance(name: string): Promise<LastPerformance | null> {
    return (await this.lastPerformanceMap([name])).get(name.toLowerCase()) ?? null;
  }

  /**
   * Latest logged set per exercise name, in ONE pass over history. A 26-row
   * template asking one name at a time would walk every stored session 26 times.
   *
   * Recency comes from the SET's own timestamp, not from session order. Two
   * sessions started in the same millisecond sort arbitrarily — which is exactly
   * how this returned the older of two loads before — and a session edited days
   * after its start date is newer than its `startedAt` claims. The set knows
   * when it happened; nothing else does.
   */
  async lastPerformanceMap(names: readonly string[]): Promise<Map<string, LastPerformance>> {
    const out = new Map<string, LastPerformance>();
    const want = new Set(names.map((n) => n.toLowerCase()));
    if (want.size === 0) return out;

    const at = new Map<string, string>();
    for (const s of await this.store.listSessions()) {
      for (const ex of s.exercises) {
        const key = ex.name.toLowerCase();
        if (!want.has(key) || ex.sets.length === 0) continue;

        const last = ex.sets[ex.sets.length - 1];
        const stamp = String(last.at ?? "");
        const seen = at.get(key);
        if (seen !== undefined && stamp <= seen) continue;

        at.set(key, stamp);
        out.set(key, { weight: last.weight, reps: last.reps, date: s.date });
      }
    }
    return out;
  }
}

export type LastPerformance = { weight: number; reps: number; date: string };

// ---------------------------------------------------------------- derived

/** Epley estimate. A formula, not a measurement — labelled as such in the UI. */
export function e1rm(weight: number, reps: number): number {
  return reps <= 1 ? weight : weight * (1 + reps / 30);
}

/**
 * Load moved, in lb.
 *
 * A per-side exercise counts twice: eight reps of a 95 lb Bulgarian split squat
 * is 1520 lb of work, not 760. Sessions written before `perSide` existed have
 * no such exercises, so this is the same number they always were.
 */
export function sessionVolume(s: Session): number {
  return s.exercises.reduce((t, ex) => {
    const sides = ex.perSide ? 2 : 1;
    return t + ex.sets.reduce((u, st) => u + st.weight * st.reps * sides, 0);
  }, 0);
}

export function sessionSetCount(s: Session): number {
  return s.exercises.reduce((t, ex) => t + ex.sets.length, 0);
}

/** Target met. An exercise with no prescription counts once it has one set. */
export function exerciseComplete(ex: ExerciseEntry): boolean {
  return ex.targetSets === undefined ? ex.sets.length > 0 : ex.sets.length >= ex.targetSets;
}

export type Progress = {
  exercisesDone: number;
  exercisesTotal: number;
  setsDone: number;
  setsTarget: number;
  /** Excludes exercises marked optional — skipping those is not falling behind. */
  requiredRemaining: number;
};

export function sessionProgress(s: Session): Progress {
  let exercisesDone = 0;
  let setsTarget = 0;
  let requiredRemaining = 0;

  for (const ex of s.exercises) {
    const done = exerciseComplete(ex);
    if (done) exercisesDone += 1;
    setsTarget += ex.targetSets ?? 0;
    if (!done && !ex.optional) requiredRemaining += 1;
  }

  return {
    exercisesDone,
    exercisesTotal: s.exercises.length,
    setsDone: sessionSetCount(s),
    setsTarget,
    requiredRemaining,
  };
}

/** The first exercise still short of its target — what "Next" jumps to. */
export function nextIncomplete(s: Session): ExerciseEntry | null {
  return s.exercises.find((ex) => !exerciseComplete(ex) && !ex.optional) ?? null;
}

export function durationMinutes(s: Session): number | null {
  if (!s.finishedAt) return null;
  return Math.round(
    (new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) / 60000,
  );
}
