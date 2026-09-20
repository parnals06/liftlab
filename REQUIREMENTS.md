# LiftLab v2 — Requirements

**One sentence:** log an entire workout from my phone with minimal taps, and
analyse the resulting file on my Mac.

This document exists to stop scope creep. If a proposed feature is not on the
PHONE list, it does not go in the phone client, however small it seems.

---

## Split of responsibilities

| Phone (this app) | Laptop (Python) |
| --- | --- |
| start workout | visualisation |
| choose exercise | progression analysis |
| enter weight × reps (± RPE) | fatigue / recovery modelling |
| edit or delete a set | prediction |
| session notes, bodyweight | ML, graph representations |
| rest timer | programme generation |
| finish workout | anything that takes more than 50 ms |
| export / sync | |

## Explicitly NOT in the phone app

Analytics. Charts. Programme builder. AI. Graph visualisation.
Recommendation engine. Accounts. Login. Cloud database. Social features.

Reason: every one of those items is why the previous version stopped being
touched. The phone is a data-acquisition device. Nothing else.

---

## Data model invariants

These are the rules the code enforces, and the reason the old version had the
resurrecting-session bug. They are stated here because they are decisions, not
implementation details.

1. **There is at most one active session.** Zero or one. It is identified by a
   single stored pointer, `meta.activeSessionId`.
2. **Bootstrap never promotes.** On launch, the app reads that pointer and
   nothing else. It must never scan history for unfinished sessions and make one
   active. An unfinished session that is not pointed at is history, not a
   candidate.
3. **Discarding clears the pointer and creates nothing.** Discard deletes the
   pointed-to session and sets the pointer to null. It never selects a successor.
4. **Finishing is terminal.** `finishedAt` is set once and the session becomes
   immutable. The pointer is cleared in the same operation.
5. **Sets append atomically.** A set is appended by a single write. A crash
   mid-workout may lose the set being typed; it may never corrupt earlier sets.
6. **Export is lossless and canonical.** JSON is the source of truth. CSV is a
   projection of it, never the other way round.

### Regression sequence — the win condition

```
no active session
  → create A            (A active)
  → resume A            (A still active, sets intact)
  → discard A           (no active session)
  → Today shows no active session
  → historical B remains in history, still not active
  → restart app         (still no active session)
```

This is implemented as an automated test: `app/test/active-session.test.ts`.
`npm test` must pass before any commit touching session logic.

---

## Storage

Canonical record, one per session:

```json
{
  "schema": 1,
  "id": "2026-09-19T20-14-03-xyz",
  "date": "2026-09-19",
  "name": "Shoulders + Arms",
  "startedAt": "2026-09-19T20:14:03.120Z",
  "finishedAt": "2026-09-19T21:38:44.004Z",
  "bodyweight": 172.4,
  "notes": "left shoulder cranky on the last OHP set",
  "exercises": [
    {
      "id": "ex_1",
      "name": "Overhead Press",
      "sets": [
        { "id": "s_1", "weight": 105, "reps": 6, "rpe": 8, "at": "2026-09-19T20:19:11.000Z" },
        { "id": "s_2", "weight": 105, "reps": 6, "rpe": 9, "at": "2026-09-19T20:22:40.000Z" },
        { "id": "s_3", "weight": 105, "reps": 5, "rpe": 10, "at": "2026-09-19T20:26:02.000Z" }
      ]
    }
  ]
}
```

Units are pounds and stored as entered. No implicit conversion anywhere.
Timestamps are ISO-8601 UTC. `schema` is bumped only for breaking changes, and a
migration is written in the same commit.

Browser storage: IndexedDB, local-first, no network dependency. Export writes a
`.json` file (and a `.csv` projection) through the share sheet / downloads.

---

## v0 success condition

> I can log tomorrow's session entirely on my phone, export the file, and plot
> it on my Mac.

Nothing else counts as v0 being done. Not sync, not styling, not icons.

---

## Templates (v0.2)

A template is a **prescription**: an ordered list of exercises with target set
counts and rep ranges, hardcoded in `app/src/templates.ts`. There is no template
editor and there will not be one in v0. Editing the plan means editing the file
and redeploying — a plan is a decision made at a desk with a clear head, and the
friction is there to stop it drifting into whatever felt easy that day.

### What a prescription adds to an exercise

All optional, so a session written before templates existed still parses:

| Field | Meaning |
| --- | --- |
| `block` | Grouping for the accordion — contiguous, never repeated |
| `target` | Display string, e.g. `3–4 × 5–6`. **Never parsed** |
| `targetSets` | Logged sets that count as complete |
| `kind` | `load` \| `reps` \| `mark` — what the entry row asks for |
| `perSide` | Reps are per limb; volume counts the set twice |
| `optional` | Skippable without the session counting as unfinished |

`kind` is stored, not derived, because a session read back in a year has to know
that "Bird dog 8" meant reps and carried no load.

`perSide` and `load` are **independent**. A Bulgarian split squat is both; a
banded clamshell is per-side with no load at all. Conflating them was the
modelling trap here, and there is a test pinning it.

### Rules this makes explicit

1. **A blank weight is only an error when the exercise expects one.** Bodyweight
   and banded work legitimately has no load; a barbell lift with an empty weight
   field is a mistake. The first saves, the second is refused visibly. A save
   that silently does nothing reads as a broken app.
2. **Per-side sets count twice in volume.** Eight reps of a 95 lb Bulgarian is
   1520 lb of work. Sessions from before this flag have no per-side exercises,
   so their numbers are unchanged.
3. **Recency comes from the set's timestamp, not from session order.** Two
   sessions started in the same millisecond sort arbitrarily, and a session
   edited days after its start date is newer than `startedAt` claims. The set
   knows when it happened; nothing else does.
4. **Seeding is one write, not one per exercise.** A 26-row template must not be
   26 round-trips to IndexedDB on a phone in a gym.
5. **The invariants are untouched.** `startSeeded` runs the same conflict check
   and writes the pointer exactly once. Discarding a template session still
   promotes nothing.

### Navigation

Twenty-six expanded cards is a scroll problem, and a scroll problem between sets
is a logging problem. One block is open at a time, one exercise inside it. The
view moves only when an exercise actually hits its target — nothing shifts under
your thumbs mid-set. `Next` in the header is the one control that matters.

### Dev mode

`?dev=1` exposes seeding and wiping in the Data tab, so the app can be worked on
without doing a 3.5-hour leg session first. Seeded sessions are named `[DEV]`,
never touch the active pointer, and can be deleted without touching real logs.
The dev module is a separate chunk that only downloads when the flag is present.

### Known gap

`analysis/liftlab.py` does not yet read `per_side`, so its volume figures
understate unilateral work. The CSV carries the column; the notebook has to
start using it.

## Roadmap (write it down, then ignore it until v0 ships)

- **v0** local storage + export ← *tonight*
- **v1** automatic sync (file drop to iCloud folder, or a tiny HTTP endpoint)
- **v2** laptop analytics as a standing notebook
- **v3** progression / recommendation model
- **v4** exercise-graph representation, longitudinal model

Prerequisite for v3 and v4 is *months of real logged data*. The model work is
gated on the acquisition device being boring and reliable, which is the entire
argument for this split.
