import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store-memory";
import {
  ActiveSessionConflict,
  SessionService,
  exerciseComplete,
  nextIncomplete,
  sessionProgress,
  sessionVolume,
  type Session,
} from "../src/model";
import {
  LEG_GAUNTLET,
  TEMPLATES,
  summary,
  targetLabel,
  targetSetTotal,
  toSeeds,
} from "../src/templates";
import { CSV_COLUMNS, toCsv } from "../src/export";

/** Split one CSV line, respecting doubled-quote escaping. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

describe("template integrity", () => {
  it("has no malformed prescriptions", () => {
    for (const t of TEMPLATES) {
      expect(t.id, "template id").toMatch(/^[a-z0-9-]+$/);
      expect(t.items.length).toBeGreaterThan(0);

      for (const p of t.items) {
        expect(p.name.trim(), `${t.id}: name`).not.toBe("");
        expect(p.block.trim(), `${t.id}/${p.name}: block`).not.toBe("");
        expect(p.reps.trim(), `${t.id}/${p.name}: reps`).not.toBe("");
        expect(p.sets, `${t.id}/${p.name}: sets`).toBeGreaterThanOrEqual(1);
        if (p.setsMax !== undefined) {
          expect(p.setsMax, `${t.id}/${p.name}: setsMax`).toBeGreaterThan(p.sets);
        }
      }
    }
  });

  it("has no duplicate exercise names", () => {
    // Duplicates would collide in lastPerformanceMap and in the analysis
    // pipeline's groupby, silently merging two different movements.
    for (const t of TEMPLATES) {
      const names = t.items.map((p) => p.name.toLowerCase());
      expect(new Set(names).size, `${t.id}: duplicate names`).toBe(names.length);
    }
  });

  it("keeps blocks contiguous so the accordion cannot show one twice", () => {
    for (const t of TEMPLATES) {
      const order: string[] = [];
      for (const p of t.items) {
        if (order[order.length - 1] !== p.block) order.push(p.block);
      }
      expect(new Set(order).size, `${t.id}: block appears in two runs`).toBe(order.length);
    }
  });

  it("describes the gauntlet the way the plan does", () => {
    const g = LEG_GAUNTLET;
    expect(g.items).toHaveLength(26);
    // 66 is the sum of the LOW end of every set range. The upper ends (Zercher
    // 3–4, pigeon 1–2) take it to 69 on a day everything gets its extra set.
    expect(targetSetTotal(g)).toBe(66);
    // The counts on the start screen are computed, so they cannot go stale.
    expect(summary(g)).toBe("~3.5 h · 26 exercises · 66 target sets");

    const names = g.items.map((p) => p.name);
    // Hyperextensions after both curls; the finisher genuinely last.
    expect(names.indexOf("Hyperextension — 25 lb")).toBeGreaterThan(
      names.indexOf("Lying leg curl"),
    );
    expect(names.indexOf("Banded fire hydrant")).toBeGreaterThan(names.indexOf("Calf raise"));
    expect(names.indexOf("Banded clamshell")).toBe(names.length - 2);

    // Bulgarian split squats are loaded AND per side — the two flags are
    // independent, and conflating them was the modelling trap here.
    const bulgarian = g.items.find((p) => p.name === "Bulgarian split squat");
    expect(bulgarian).toMatchObject({ kind: "load", perSide: true, sets: 3 });

    // Banded work carries no load, so it must not demand a weight.
    for (const p of g.items.filter((x) => x.name.startsWith("Banded"))) {
      expect(p.kind).toBe("reps");
      expect(p.perSide).toBe(true);
    }
  });

  it("labels targets readably", () => {
    expect(targetLabel({ name: "x", block: "b", kind: "load", sets: 3, setsMax: 4, reps: "5–6" })).toBe(
      "3–4 × 5–6",
    );
    expect(targetLabel({ name: "x", block: "b", kind: "load", sets: 4, reps: "8–10" })).toBe(
      "4 × 8–10",
    );
    // A single mobility item reads as a duration, not "1 × 3–5 min".
    expect(targetLabel({ name: "x", block: "b", kind: "mark", sets: 1, reps: "3–5 min" })).toBe(
      "3–5 min",
    );
  });
});

describe("starting from a template", () => {
  it("seeds every exercise, with no sets and the prescription attached", async () => {
    const store = new MemoryStore();
    const svc = new SessionService(store);

    const s = await svc.startSeeded(LEG_GAUNTLET.name, toSeeds(LEG_GAUNTLET), {
      templateId: LEG_GAUNTLET.id,
    });

    expect(s.name).toBe("Leg Gauntlet");
    expect(s.templateId).toBe("leg-gauntlet");
    expect(s.exercises).toHaveLength(26);
    expect(s.exercises.every((ex) => ex.sets.length === 0)).toBe(true);
    expect(s.exercises.every((ex) => ex.id !== "")).toBe(true);
    expect(new Set(s.exercises.map((ex) => ex.id)).size).toBe(26);
    expect(s.exercises[0]).toMatchObject({
      name: "Foam rolling",
      block: "Warm-up",
      kind: "mark",
      target: "3–5 min",
      targetSets: 1,
    });

    // Order is the plan's order, not object-key order.
    expect(s.exercises.map((ex) => ex.name)).toEqual(LEG_GAUNTLET.items.map((p) => p.name));
  });

  it("still refuses a second session, and still resurrects nothing on discard", async () => {
    const store = new MemoryStore();
    const svc = new SessionService(store);

    // An old unfinished session already sitting in the database.
    const stale: Session = {
      schema: 1,
      id: "OLD",
      date: "2026-08-01",
      name: "Old unfinished",
      startedAt: "2026-08-01T18:00:00.000Z",
      finishedAt: null,
      exercises: [],
    };
    await store.putSession(stale);

    await svc.startSeeded(LEG_GAUNTLET.name, toSeeds(LEG_GAUNTLET), {
      templateId: LEG_GAUNTLET.id,
    });
    await expect(svc.start("Push")).rejects.toBeInstanceOf(ActiveSessionConflict);
    await expect(
      svc.startSeeded(LEG_GAUNTLET.name, toSeeds(LEG_GAUNTLET)),
    ).rejects.toBeInstanceOf(ActiveSessionConflict);

    await svc.discardActive();
    expect(await svc.getActive()).toBeNull();
    expect(await svc.getActive()).toBeNull();
    expect((await svc.abandoned()).map((x) => x.id)).toEqual(["OLD"]);
  });

  it("survives a reopen with the prescription intact", async () => {
    const store = new MemoryStore();
    await new SessionService(store).startSeeded(LEG_GAUNTLET.name, toSeeds(LEG_GAUNTLET), {
      templateId: LEG_GAUNTLET.id,
    });

    const reopened = await new SessionService(MemoryStore.restore(store.snapshot())).getActive();
    expect(reopened?.exercises).toHaveLength(26);
    expect(reopened?.exercises.find((ex) => ex.name === "Leg press")).toMatchObject({
      target: "4 × 10–15",
      targetSets: 4,
      kind: "load",
    });
  });

  it("looks up the most recent load, by when the set was logged", async () => {
    const store = new MemoryStore();
    const svc = new SessionService(store);

    // Explicit timestamps, because two sessions started in the same millisecond
    // sort arbitrarily — which is how this used to return the older load.
    const logged = (day: string, weight: number, at: string): Session => ({
      schema: 1,
      id: `wk_${day}_${weight}`,
      date: day,
      name: "Legs",
      startedAt: `${day}T17:00:00.000Z`,
      finishedAt: `${day}T18:30:00.000Z`,
      exercises: [
        {
          id: `ex_${day}_${weight}`,
          name: "Leg press",
          kind: "load",
          sets: [{ id: `st_${day}_${weight}`, weight, reps: 12, at }],
        },
      ],
    });

    await store.putSession(logged("2026-09-01", 250, "2026-09-01T17:20:00.000Z"));
    await store.putSession(logged("2026-09-15", 270, "2026-09-15T17:20:00.000Z"));
    // Same start date as the first, but its sets were entered a week later —
    // recency belongs to the set, not to the session's start.
    await store.putSession(logged("2026-09-01", 285, "2026-09-22T09:00:00.000Z"));

    const map = await svc.lastPerformanceMap(["Leg press", "Hip thrust"]);
    expect(map.get("leg press")).toMatchObject({ weight: 285, reps: 12 });
    // An exercise never performed comes back absent, not zeroed.
    expect(map.has("hip thrust")).toBe(false);
    // The single-name helper is the same code path, so it cannot disagree.
    expect(await svc.lastPerformance("LEG PRESS")).toMatchObject({ weight: 285 });
  });
});

describe("progress and completion", () => {
  it("counts an exercise done at its target, not at its first set", async () => {
    const svc = new SessionService(new MemoryStore());
    const s = await svc.startSeeded("T", [
      { name: "Leg press", block: "Press", kind: "load", target: "4 × 10–15", targetSets: 4 },
    ]);
    const id = s.exercises[0].id;

    for (const n of [1, 2, 3]) {
      const cur = await svc.addSet(id, { weight: 270, reps: 12 });
      expect(exerciseComplete(cur.exercises[0]), `after ${n} sets`).toBe(false);
    }
    const done = await svc.addSet(id, { weight: 270, reps: 12 });
    expect(exerciseComplete(done.exercises[0])).toBe(true);

    // A fifth set is allowed and does not un-complete anything.
    const extra = await svc.addSet(id, { weight: 270, reps: 10 });
    expect(exerciseComplete(extra.exercises[0])).toBe(true);
    expect(sessionProgress(extra)).toMatchObject({
      exercisesDone: 1,
      exercisesTotal: 1,
      setsDone: 5,
      setsTarget: 4,
      requiredRemaining: 0,
    });
  });

  it("does not let an optional exercise hold up the session", async () => {
    const svc = new SessionService(new MemoryStore());
    const s = await svc.startSeeded("T", [
      { name: "Primer", block: "Warm-up", kind: "load", targetSets: 2, optional: true },
      { name: "Squat", block: "Squat", kind: "load", targetSets: 1 },
    ]);
    const squat = s.exercises[1].id;

    // `next` skips the optional row entirely.
    expect(nextIncomplete(s)?.name).toBe("Squat");

    const after = await svc.addSet(squat, { weight: 185, reps: 5 });
    expect(nextIncomplete(after)).toBeNull();
    expect(sessionProgress(after)).toMatchObject({ requiredRemaining: 0, exercisesDone: 1 });
  });

  it("counts per-side work twice in volume, and leaves old sessions alone", async () => {
    const svc = new SessionService(new MemoryStore());
    const s = await svc.startSeeded("T", [
      { name: "Bulgarian split squat", block: "Unilateral", kind: "load", perSide: true },
      { name: "RDL", block: "Hinge", kind: "load" },
    ]);

    await svc.addSet(s.exercises[0].id, { weight: 95, reps: 8 }); // 95*8*2 = 1520
    const both = await svc.addSet(s.exercises[1].id, { weight: 185, reps: 8 }); // 1480

    expect(sessionVolume(both)).toBe(1520 + 1480);

    // A session from before templates has no perSide anywhere, so its number
    // is exactly what it always was.
    const legacy: Session = {
      schema: 1,
      id: "L",
      date: "2026-01-01",
      name: "old",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T01:00:00.000Z",
      exercises: [
        { id: "e", name: "Squat", sets: [{ id: "s", weight: 200, reps: 5, at: "x" }] },
      ],
    };
    expect(sessionVolume(legacy)).toBe(1000);
  });

  it("marks a mobility item done without asking for numbers", async () => {
    const svc = new SessionService(new MemoryStore());
    const s = await svc.startSeeded("T", [
      { name: "Foam rolling", block: "Warm-up", kind: "mark", target: "3–5 min", targetSets: 1 },
    ]);
    const done = await svc.addSet(s.exercises[0].id, { weight: 0, reps: 1 });

    expect(exerciseComplete(done.exercises[0])).toBe(true);
    expect(sessionVolume(done)).toBe(0); // a stretch is not tonnage
  });
});

describe("CSV export", () => {
  it("keeps every row the same width as the header", async () => {
    const svc = new SessionService(new MemoryStore());
    const s = await svc.startSeeded(LEG_GAUNTLET.name, toSeeds(LEG_GAUNTLET), {
      templateId: LEG_GAUNTLET.id,
    });

    // One logged exercise, one marked one, and 24 rows with no sets at all.
    const press = s.exercises.find((ex) => ex.name === "Leg press")!;
    await svc.addSet(press.id, { weight: 270, reps: 12, rpe: 8 });
    await svc.addSet(press.id, { weight: 270, reps: 11 });
    await svc.addSet(s.exercises[0].id, { weight: 0, reps: 1 });
    const withNotes = await svc.setNotes('hips fine, "left knee" a bit cranky');

    const lines = toCsv([withNotes, { ...withNotes, id: "empty", exercises: [] }])
      .trim()
      .split("\n");

    expect(cells(lines[0])).toEqual([...CSV_COLUMNS]);
    for (const [i, line] of lines.entries()) {
      expect(cells(line).length, `row ${i}`).toBe(CSV_COLUMNS.length);
    }

    const header = cells(lines[0]);
    const rowFor = (name: string) =>
      lines.slice(1).map(cells).find((r) => r[header.indexOf("exercise")] === name);

    const pressRow = rowFor("Leg press")!;
    expect(pressRow[header.indexOf("block")]).toBe("Press");
    expect(pressRow[header.indexOf("kind")]).toBe("load");
    expect(pressRow[header.indexOf("per_side")]).toBe("0");
    expect(pressRow[header.indexOf("template_id")]).toBe("leg-gauntlet");

    expect(rowFor("Bulgarian split squat")![header.indexOf("per_side")]).toBe("1");
    // An exercise with no sets still appears, so a skipped lift is visible.
    expect(rowFor("Calf raise")![header.indexOf("set_index")]).toBe("");
  });
});
