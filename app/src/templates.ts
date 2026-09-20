/**
 * Hardcoded workout templates.
 *
 * A template is a *prescription*: an ordered list of what to do, with target
 * set counts and rep ranges. It is deliberately not editable in the app. The
 * plan is a decision made at a desk with a clear head; changing it mid-workout
 * with sweaty thumbs is how a plan turns into whatever felt easy that day.
 *
 * To change a plan, edit this file and redeploy. That friction is the feature.
 *
 * `reps` is a display string, never parsed. The app does not police whether you
 * hit the range — it records what you actually did.
 */

import type { EntryKind, ExerciseSeed } from "./model";

/**
 * `EntryKind` lives in the data model, not here, because it is stored on the
 * exercise: a session read back in a year has to know that "Bird dog 8" was
 * reps and carried no load. Re-exported so a template file reads standalone.
 *   load — weight and reps, weight required (barbell, machine, plate-loaded)
 *   reps — reps required, weight optional (bodyweight, banded, light plate)
 *   mark — no numbers, one "Done" tap (foam rolling, stretches, the walk)
 */
export type { EntryKind };

export type Prescription = {
  name: string;
  block: string;
  kind: EntryKind;
  /** Minimum set count that counts as complete. */
  sets: number;
  /** Upper end when the plan gives a range, e.g. 3–4 sets. */
  setsMax?: number;
  /** Display only: "5–6", "8–10", "3–5 min". */
  reps: string;
  /** Reps are logged per side; volume counts the set twice. */
  perSide?: boolean;
  /** Skippable without the session counting as incomplete. */
  optional?: boolean;
  /** One line, shown under the name. Cue or safety note, not coaching prose. */
  note?: string;
};

export type Template = {
  id: string;
  name: string;
  /** Rough wall-clock estimate. The exercise and set counts are computed, not
   * written down, so they cannot drift out of step with the list below. */
  duration: string;
  /** Shown at the bottom of the session. The instruction that is not an exercise. */
  footnote?: string;
  items: Prescription[];
};

/* ------------------------------------------------------------------------- */

export const LEG_GAUNTLET: Template = {
  id: "leg-gauntlet",
  name: "Leg Gauntlet",
  duration: "~3.5 h",
  footnote:
    "No weighted ruck afterward. Let today's 8–10k steps come naturally around the workout.",
  items: [
    // ------------------------------------------------------------- warm-up
    { block: "Warm-up", name: "Foam rolling", kind: "mark", sets: 1, reps: "3–5 min" },
    {
      block: "Warm-up",
      name: "World's greatest stretch",
      kind: "mark",
      sets: 1,
      reps: "2/side",
      perSide: true,
    },
    { block: "Warm-up", name: "Bird dog", kind: "reps", sets: 2, reps: "8/side", perSide: true },
    {
      block: "Warm-up",
      name: "Piriformis / pigeon",
      kind: "mark",
      sets: 1,
      setsMax: 2,
      reps: "1–2/side",
      perSide: true,
    },
    {
      block: "Warm-up",
      name: "Ankle mobility",
      kind: "reps",
      sets: 2,
      reps: "8–10/side",
      perSide: true,
    },
    {
      block: "Warm-up",
      name: "Cossack squat",
      kind: "reps",
      sets: 2,
      reps: "5/side",
      perSide: true,
    },
    { block: "Warm-up", name: "Landmine squat", kind: "load", sets: 3, reps: "8–10" },
    {
      block: "Warm-up",
      name: "KB hinge / swing primer",
      kind: "load",
      sets: 2,
      reps: "10–12",
      optional: true,
      note: "Light. A primer, not a set.",
    },

    // --------------------------------------------------------------- squat
    {
      block: "Squat",
      name: "Zercher squat — ramp",
      kind: "load",
      sets: 3,
      setsMax: 4,
      reps: "ramp",
      note: "Build to the work weight. Stop short of grinding.",
    },
    {
      block: "Squat",
      name: "Zercher squat — work",
      kind: "load",
      sets: 3,
      setsMax: 4,
      reps: "5–6",
    },

    // ---------------------------------------------------------- unilateral
    {
      block: "Unilateral",
      name: "Bulgarian split squat",
      kind: "load",
      sets: 3,
      reps: "8/leg",
      perSide: true,
    },

    // --------------------------------------------------------------- hinge
    { block: "Hinge", name: "RDL / straight-leg deadlift", kind: "load", sets: 4, reps: "8–10" },

    // --------------------------------------------------------------- press
    { block: "Press", name: "Leg press", kind: "load", sets: 4, reps: "10–15" },

    // -------------------------------------------------------------- glutes
    { block: "Glutes", name: "Hip thrust", kind: "load", sets: 4, reps: "8–12" },

    // ---------------------------------------------------------- hamstrings
    { block: "Hamstrings", name: "Seated leg curl", kind: "load", sets: 3, reps: "10–15" },
    { block: "Hamstrings", name: "Lying leg curl", kind: "load", sets: 3, reps: "10–15" },

    // ----------------------------------------------------- posterior chain
    // After the curls on purpose: all the heavy spinally loaded work is done.
    {
      block: "Posterior chain",
      name: "Hyperextension — 25 lb",
      kind: "load",
      sets: 2,
      reps: "8–10",
      note: "Controlled hip extension. Stop the rep at neutral.",
    },
    {
      block: "Posterior chain",
      name: "Hyperextension — 45 lb",
      kind: "load",
      sets: 2,
      reps: "8–10",
      note: "Stop at neutral. Do not extend into the lumbar spine.",
    },

    // -------------------------------------------------------- hip machines
    { block: "Hip machines", name: "Adductor machine", kind: "load", sets: 3, reps: "12–20" },
    { block: "Hip machines", name: "Abductor machine", kind: "load", sets: 3, reps: "15–20" },

    // ----------------------------------------------------------- lower leg
    { block: "Lower leg", name: "Calf raise", kind: "load", sets: 4, reps: "10–15" },
    { block: "Lower leg", name: "Tibialis raise", kind: "reps", sets: 3, reps: "15–25" },

    // ---------------------------------------------------------------- core
    { block: "Core", name: "Hanging knee raise", kind: "reps", sets: 3, reps: "8–15" },

    // ------------------------------------------------------ glute finisher
    // At the end, not in the warm-up: fatiguing glute med/min before heavy
    // unilateral work costs more than the activation is worth.
    {
      block: "Glute finisher",
      name: "Banded fire hydrant",
      kind: "reps",
      sets: 2,
      reps: "20–30/side",
      perSide: true,
      note: "30–40 if the band is light. Continuous tension, not load.",
    },
    {
      block: "Glute finisher",
      name: "Banded clamshell",
      kind: "reps",
      sets: 2,
      reps: "20–30/side",
      perSide: true,
      note: "30–40 if the band is light. Continuous tension, not load.",
    },

    // ------------------------------------------------------------ cooldown
    { block: "Cooldown", name: "Easy walk / mobility", kind: "mark", sets: 1, reps: "5–10 min" },
  ],
};

export const TEMPLATES: readonly Template[] = [LEG_GAUNTLET];

/* ------------------------------------------------------------------ derived */

/** "3–4 × 5–6", "2 × 8/side", "3–5 min". */
export function targetLabel(p: Prescription): string {
  const sets = p.setsMax && p.setsMax !== p.sets ? `${p.sets}–${p.setsMax}` : String(p.sets);
  if (p.kind === "mark" && p.sets === 1) return p.reps;
  return `${sets} × ${p.reps}`;
}

/** Template → the exercise rows a session starts with. */
export function toSeeds(t: Template): ExerciseSeed[] {
  return t.items.map((p) => ({
    name: p.name,
    block: p.block,
    kind: p.kind,
    target: targetLabel(p),
    targetSets: p.sets,
    ...(p.perSide ? { perSide: true as const } : {}),
    ...(p.optional ? { optional: true as const } : {}),
    ...(p.note ? { note: p.note } : {}),
  }));
}

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Sum of minimum target sets — the denominator in the session progress line. */
export function targetSetTotal(t: Template): number {
  return t.items.reduce((n, p) => n + p.sets, 0);
}

/** "~3.5 h · 26 exercises · 66 target sets", counted from the list itself. */
export function summary(t: Template): string {
  return `${t.duration} · ${t.items.length} exercises · ${targetSetTotal(t)} target sets`;
}
