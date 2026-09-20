import "./styles.css";
import {
  SessionService,
  ActiveSessionConflict,
  durationMinutes,
  e1rm,
  exerciseComplete,
  nextIncomplete,
  sessionProgress,
  sessionSetCount,
  sessionVolume,
  type ExerciseEntry,
  type LastPerformance,
  type Session,
  type SetEntry,
} from "./model";
import { IdbStore } from "./store-idb";
import { MemoryStore } from "./store-memory";
import { download, filenameStamp, parseBundle, toBundle, toCsv } from "./export";
import { TEMPLATES, summary, templateById, toSeeds } from "./templates";

/* ------------------------------------------------------------------ setup */

let store: IdbStore | MemoryStore;
try {
  store = new IdbStore();
} catch {
  // Private windows and locked-down browsers: keep working, warn on export.
  store = new MemoryStore();
}
const svc = new SessionService(store);

const DEV = new URLSearchParams(location.search).has("dev");

type Tab = "today" | "history" | "data";

const state: {
  tab: Tab;
  active: Session | null;
  history: Session[];
  abandoned: Session[];
  names: string[];
  lastSetAt: number | null;
  openExercise: string | null;
  openBlock: string | null;
  lastPerf: Map<string, LastPerformance>;
  scrollTo: string | null;
} = {
  tab: "today",
  active: null,
  history: [],
  abandoned: [],
  names: [],
  lastSetAt: null,
  openExercise: null,
  openBlock: null,
  lastPerf: new Map(),
  scrollTo: null,
};

const app = document.getElementById("app") as HTMLDivElement;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
const lb = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const lbBig = (n: number) => Math.round(n).toLocaleString("en-US");

const QUICK_NAMES = ["Push", "Pull", "Legs", "Shoulders + Arms", "Chest + Back"];

/* ------------------------------------------------------------------- data */

async function refresh(): Promise<void> {
  state.active = await svc.getActive();
  state.history = await svc.history();
  state.abandoned = await svc.abandoned();
  state.names = await svc.recentExerciseNames();

  if (state.active) {
    state.lastPerf = await svc.lastPerformanceMap(state.active.exercises.map((ex) => ex.name));
    // On first paint of a session, land on the first thing still to do.
    if (state.openExercise === null) focusNext(state.active);
  } else {
    state.lastPerf = new Map();
  }
  render();
}

/** Point the accordion at the first incomplete exercise. */
function focusNext(s: Session): ExerciseEntry | null {
  const next = nextIncomplete(s) ?? s.exercises[s.exercises.length - 1] ?? null;
  state.openExercise = next?.id ?? null;
  state.openBlock = next?.block ?? null;
  return next;
}

/* ----------------------------------------------------------------- render */

function render(): void {
  app.innerHTML =
    state.tab === "today" ? viewToday() : state.tab === "history" ? viewHistory() : viewData();
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => {
    el.classList.toggle("on", el.dataset.tab === state.tab);
  });

  if (state.scrollTo) {
    document
      .getElementById(`ex-${state.scrollTo}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
    state.scrollTo = null;
  }
}

function restClock(): string {
  if (!state.lastSetAt) return "";
  const s = Math.floor((Date.now() - state.lastSetAt) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function viewToday(): string {
  const s = state.active;
  return s ? viewSession(s) : viewStart();
}

function viewStart(): string {
  return `
    <section class="card">
      <h2>Start a workout</h2>
      <div class="templates">
        ${TEMPLATES.map(
          (t) => `<button class="tmpl" data-action="start-template" data-id="${esc(t.id)}">
            <span class="tmpl-name">${esc(t.name)}</span>
            <span class="fine">${esc(summary(t))}</span>
          </button>`,
        ).join("")}
      </div>
    </section>

    <section class="card">
      <h3>Or free-form</h3>
      <input id="newName" class="text" placeholder="Session name" autocomplete="off" />
      <div class="chips">
        ${QUICK_NAMES.map(
          (n) =>
            `<button class="chip" data-action="quickname" data-name="${esc(n)}">${esc(n)}</button>`,
        ).join("")}
      </div>
      <button class="primary" data-action="start">Start empty</button>
    </section>

    ${
      state.abandoned.length
        ? `<section class="card muted-card">
             <h3>Unfinished, not active <span class="count">${state.abandoned.length}</span></h3>
             <p class="fine">These are history. They are never resumed automatically — that is the whole point of the rewrite. Delete them, or leave them.</p>
             ${state.abandoned
               .map(
                 (a) => `<div class="row">
                   <span>${esc(a.name)} · ${a.date}</span>
                   <button class="ghost" data-action="delete-session" data-id="${a.id}">Delete</button>
                 </div>`,
               )
               .join("")}
           </section>`
        : ""
    }
    ${
      state.history.length
        ? `<p class="fine center">${state.history.length} completed sessions logged.</p>`
        : `<p class="fine center">No sessions yet. The first one is the test of whether this thing is fast enough.</p>`
    }`;
}

function viewSession(s: Session): string {
  const mins = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 60000);
  const p = sessionProgress(s);
  const next = nextIncomplete(s);
  const groups = groupByBlock(s);
  const tmpl = s.templateId ? templateById(s.templateId) : undefined;

  const stats = [
    `${mins} min`,
    p.setsTarget ? `${p.exercisesDone}/${p.exercisesTotal} ex` : null,
    p.setsTarget ? `${p.setsDone}/${p.setsTarget} sets` : `${sessionSetCount(s)} sets`,
    `${lbBig(sessionVolume(s))} lb`,
    state.lastSetAt ? `rest <span id="rest">${restClock()}</span>` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return `
    <section class="card session-head">
      <div class="session-id">
        <h2>${esc(s.name)}</h2>
        <p class="fine">${stats}</p>
      </div>
      <div class="head-actions">
        <button class="primary" data-action="finish">Finish</button>
        <button class="ghost danger" data-action="discard">Discard</button>
      </div>
      ${
        next
          ? `<button class="nextup" data-action="next-up">
               <span class="fine">Next</span>
               <span class="nextup-name">${esc(next.name)}</span>
               <span class="fine">${esc(next.target ?? "")}</span>
             </button>`
          : `<p class="fine done-all">Every target met. ${p.exercisesTotal - p.exercisesDone ? `${p.exercisesTotal - p.exercisesDone} optional left.` : ""}</p>`
      }
    </section>

    ${
      groups
        ? groups.map((g) => blockCard(g)).join("")
        : s.exercises.map((ex) => exerciseCard(ex)).join("")
    }

    <section class="card">
      <input id="newExercise" class="text" placeholder="Add exercise" list="names" autocomplete="off" />
      <datalist id="names">${state.names.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <button class="primary" data-action="add-exercise">+ Exercise</button>
    </section>

    <section class="card">
      <label class="fine" for="bw">Bodyweight (lb)</label>
      <input id="bw" class="text" type="number" inputmode="decimal" step="0.1" value="${s.bodyweight ?? ""}" data-action="bw" />
      <label class="fine" for="notes">Notes</label>
      <textarea id="notes" class="text" rows="2" data-action="notes" placeholder="how it felt, what hurt">${esc(s.notes ?? "")}</textarea>
    </section>

    ${tmpl?.footnote ? `<p class="fine center footnote">${esc(tmpl.footnote)}</p>` : ""}`;
}

type Group = { block: string; items: ExerciseEntry[] };

/**
 * Blocks in template order, with anything added mid-session lumped at the end.
 * Returns null for a free-form session, which renders as a flat list.
 */
function groupByBlock(s: Session): Group[] | null {
  if (!s.exercises.some((ex) => ex.block)) return null;
  const groups: Group[] = [];
  for (const ex of s.exercises) {
    const block = ex.block ?? "Added";
    const last = groups[groups.length - 1];
    if (last && last.block === block) last.items.push(ex);
    else groups.push({ block, items: [ex] });
  }
  return groups;
}

/**
 * One block open at a time. Twenty-six expanded cards is a scroll problem, and
 * a scroll problem between sets is a logging problem.
 */
function blockCard(g: Group): string {
  const done = g.items.filter(exerciseComplete).length;
  const complete = done === g.items.length;
  const open = state.openBlock === g.block;

  return `
    <section class="block ${open ? "open" : ""} ${complete ? "complete" : ""}">
      <button class="block-head" data-action="toggle-block" data-block="${esc(g.block)}">
        <span class="block-name">${esc(g.block)}</span>
        <span class="fine">${done}/${g.items.length}${complete ? " ✓" : ""}</span>
      </button>
      ${open ? g.items.map((ex) => exerciseCard(ex)).join("") : ""}
    </section>`;
}

function setLabel(ex: ExerciseEntry, st: SetEntry): string {
  const side = ex.perSide ? "/side" : "";
  if ((ex.kind ?? "load") === "mark") return "done";
  if (st.weight > 0) return `${lb(st.weight)} lb × ${st.reps}${side}`;
  return `${st.reps} reps${side}`;
}

function pips(done: number, target: number): string {
  if (!target) return "";
  const filled = Math.min(done, target);
  const extra = Math.max(0, done - target);
  return `<span class="pips">${"<i class='on'></i>".repeat(filled)}${"<i></i>".repeat(
    target - filled,
  )}${extra ? `<b>+${extra}</b>` : ""}</span>`;
}

function exerciseCard(ex: ExerciseEntry): string {
  const kind = ex.kind ?? "load";
  const open = state.openExercise === ex.id;
  const last = ex.sets[ex.sets.length - 1];
  const prev = state.lastPerf.get(ex.name.toLowerCase());
  const loaded = ex.sets.filter((st) => st.weight > 0);
  const best = loaded.reduce((m, st) => Math.max(m, e1rm(st.weight, st.reps)), 0);
  const complete = exerciseComplete(ex);

  // Prefill: this session's last set beats history, history beats blank.
  const wSeed = last ? lb(last.weight) : prev ? lb(prev.weight) : "";
  const rSeed = last ? String(last.reps) : prev ? String(prev.reps) : "";

  const meta = [
    ex.target ? `<span class="target">${esc(ex.target)}</span>` : "",
    pips(ex.sets.length, ex.targetSets ?? 0),
    best ? `<span class="fine">e1RM ${lb(best)}</span>` : "",
    ex.optional ? `<span class="fine">optional</span>` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const weightField = (label: string) => `
    <div class="field">
      <span class="fine">${label}</span>
      <div class="stepper">
        <button data-action="bump" data-target="w-${ex.id}" data-by="-5">−5</button>
        <input id="w-${ex.id}" class="num" type="number" inputmode="decimal" step="0.5"
               value="${wSeed}" placeholder="lb" />
        <button data-action="bump" data-target="w-${ex.id}" data-by="5">+5</button>
      </div>
    </div>`;

  const repsField = `
    <div class="field">
      <span class="fine">Reps${ex.perSide ? " / side" : ""}</span>
      <div class="stepper">
        <button data-action="bump" data-target="r-${ex.id}" data-by="-1">−1</button>
        <input id="r-${ex.id}" class="num" type="number" inputmode="numeric" step="1"
               value="${rSeed}" placeholder="reps" />
        <button data-action="bump" data-target="r-${ex.id}" data-by="1">+1</button>
      </div>
    </div>`;

  const entry =
    kind === "mark"
      ? `<div class="entry mark">
           <button class="primary save" data-action="save-set" data-id="${ex.id}">Mark done</button>
         </div>`
      : `<div class="entry">
           ${kind === "load" ? weightField("Weight (lb)") + repsField : repsField + weightField("Load (opt)")}
           <input id="e-${ex.id}" class="num rpe" type="number" inputmode="decimal" step="0.5" min="1" max="10" placeholder="RPE (optional)" />
           <button class="primary save" data-action="save-set" data-id="${ex.id}">Save set</button>
           ${
             last
               ? `<button class="ghost" data-action="repeat-set" data-id="${ex.id}">Repeat ${setLabel(ex, last)}</button>`
               : ""
           }
         </div>`;

  return `
    <section class="card exercise ${open ? "open" : ""} ${complete ? "complete" : ""}" id="ex-${ex.id}">
      <button class="ex-head" data-action="toggle-ex" data-id="${ex.id}">
        <span class="ex-name">${esc(ex.name)}</span>
        <span class="ex-meta">${meta}</span>
        ${ex.note ? `<span class="fine note">${esc(ex.note)}</span>` : ""}
        ${
          !ex.sets.length && prev
            ? `<span class="fine">last ${lb(prev.weight) !== "0" ? `${lb(prev.weight)} lb × ` : ""}${prev.reps} · ${prev.date}</span>`
            : ""
        }
      </button>

      ${
        ex.sets.length
          ? `<ol class="sets">${ex.sets
              .map(
                (st, i) => `<li>
                  <span class="idx">${i + 1}</span>
                  <span class="load">${setLabel(ex, st)}${st.rpe ? ` <span class="fine">@${st.rpe}</span>` : ""}</span>
                  <button class="ghost tiny" data-action="del-set" data-ex="${ex.id}" data-set="${st.id}">×</button>
                </li>`,
              )
              .join("")}</ol>`
          : ""
      }

      ${open ? entry : ""}
      ${
        open
          ? `<button class="ghost danger tiny" data-action="del-exercise" data-id="${ex.id}">Remove exercise</button>`
          : ""
      }
    </section>`;
}

function viewHistory(): string {
  if (!state.history.length) return `<p class="fine center">Nothing finished yet.</p>`;
  return state.history
    .map(
      (s) => `<section class="card">
        <h3>${esc(s.name)}</h3>
        <p class="fine">${s.date} · ${durationMinutes(s) ?? "?"} min · ${sessionSetCount(s)} sets · ${lbBig(sessionVolume(s))} lb${
          s.bodyweight ? ` · bw ${lb(s.bodyweight)}` : ""
        }</p>
        <ul class="plain">${s.exercises
          .filter((ex) => ex.sets.length)
          .map(
            (ex) =>
              `<li><strong>${esc(ex.name)}</strong> ${ex.sets.map((st) => setLabel(ex, st)).join(", ")}</li>`,
          )
          .join("")}</ul>
        ${s.notes ? `<p class="fine">“${esc(s.notes)}”</p>` : ""}
        <button class="ghost tiny danger" data-action="delete-session" data-id="${s.id}">Delete</button>
      </section>`,
    )
    .join("");
}

function viewData(): string {
  const total = state.history.length + state.abandoned.length + (state.active ? 1 : 0);
  return `
    <section class="card">
      <h2>Export</h2>
      <p class="fine">JSON is canonical. CSV is a projection of it — one row per set. On iPhone, Save to Files → iCloud Drive, then open it on the Mac.</p>
      <button class="primary" data-action="export-json">Export JSON (${total})</button>
      <button class="primary" data-action="export-csv">Export CSV</button>
    </section>
    <section class="card">
      <h2>Import</h2>
      <p class="fine">Merges a previous export. Sessions already present are left untouched.</p>
      <input id="importFile" type="file" accept="application/json,.json" />
    </section>
    <section class="card muted-card">
      <h3>Storage</h3>
      <p class="fine">${store instanceof IdbStore ? "IndexedDB (persists on this device)" : "In-memory only — IndexedDB unavailable. Export before closing the tab."}</p>
    </section>
    ${
      DEV
        ? `<section class="card muted-card">
             <h3 class="danger">Dev tools</h3>
             <p class="fine">Only here because the URL has <code>?dev=1</code>. Seeded sessions are named <code>[DEV]</code> so they can never be mistaken for a real log.</p>
             <button class="ghost" data-action="dev-seed">Seed a finished gauntlet</button>
             <button class="ghost" data-action="dev-seed-many">Seed 6 weeks of them</button>
             <button class="ghost danger" data-action="dev-wipe-seeded">Delete [DEV] sessions</button>
             <button class="ghost danger" data-action="dev-wipe">Wipe everything</button>
           </section>`
        : ""
    }`;
}

/* ----------------------------------------------------------------- events */

const val = (id: string): string =>
  (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "";

const num = (id: string): number => {
  const n = parseFloat(val(id));
  return Number.isFinite(n) ? n : NaN;
};

/** Say no out loud. A save that silently does nothing reads as a broken app. */
function flash(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("bad");
  setTimeout(() => el.classList.remove("bad"), 1100);
  (el as HTMLInputElement).focus?.();
}

async function allSessions(): Promise<Session[]> {
  const active = state.active ? [state.active] : [];
  return [...active, ...state.abandoned, ...state.history].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}

/**
 * After a save: if the exercise just hit its target, move on. If it did not,
 * stay put. Nothing moves under the thumbs unless the work is actually done.
 */
function advanceIfComplete(before: string): void {
  const s = state.active;
  if (!s) return;
  const ex = s.exercises.find((e) => e.id === before);
  if (!ex || !exerciseComplete(ex)) return;
  const next = focusNext(s);
  if (next && next.id !== before) state.scrollTo = next.id;
}

document.addEventListener("click", async (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>("[data-action],[data-tab]");
  if (!el) return;

  if (el.dataset.tab) {
    state.tab = el.dataset.tab as Tab;
    render();
    return;
  }

  const action = el.dataset.action;
  try {
    switch (action) {
      case "quickname": {
        const input = document.getElementById("newName") as HTMLInputElement;
        input.value = el.dataset.name ?? "";
        break;
      }
      case "start": {
        const name = val("newName").trim() || "Workout";
        await svc.start(name);
        state.openExercise = null;
        state.openBlock = null;
        state.lastSetAt = null;
        await refresh();
        break;
      }
      case "start-template": {
        const t = templateById(el.dataset.id ?? "");
        if (!t) break;
        await svc.startSeeded(t.name, toSeeds(t), { templateId: t.id });
        state.openExercise = null;
        state.openBlock = null;
        state.lastSetAt = null;
        await refresh();
        break;
      }
      case "finish": {
        await svc.finishActive({
          notes: val("notes") || undefined,
          bodyweight: Number.isFinite(num("bw")) ? num("bw") : undefined,
        });
        state.openExercise = null;
        state.openBlock = null;
        state.lastSetAt = null;
        await refresh();
        break;
      }
      case "discard": {
        if (!confirm("Discard this workout? The sets logged in it are deleted.")) break;
        await svc.discardActive();
        state.openExercise = null;
        state.openBlock = null;
        state.lastSetAt = null;
        await refresh();
        break;
      }
      case "add-exercise": {
        const name = val("newExercise").trim();
        if (!name) break;
        const s = await svc.addExercise(name);
        const added = s.exercises[s.exercises.length - 1];
        state.openExercise = added.id;
        state.openBlock = added.block ?? "Added";
        state.scrollTo = added.id;
        await refresh();
        break;
      }
      case "toggle-ex": {
        state.openExercise = state.openExercise === el.dataset.id ? null : (el.dataset.id ?? null);
        render();
        break;
      }
      case "toggle-block": {
        const block = el.dataset.block ?? null;
        if (state.openBlock === block) {
          state.openBlock = null;
        } else {
          state.openBlock = block;
          // Open the first thing in there that still needs doing.
          const items = state.active?.exercises.filter((ex) => (ex.block ?? "Added") === block);
          const target = items?.find((ex) => !exerciseComplete(ex)) ?? items?.[0];
          state.openExercise = target?.id ?? null;
        }
        render();
        break;
      }
      case "next-up": {
        if (!state.active) break;
        const next = focusNext(state.active);
        if (next) state.scrollTo = next.id;
        render();
        break;
      }
      case "bump": {
        const input = document.getElementById(el.dataset.target ?? "") as HTMLInputElement | null;
        if (!input) break;
        const by = parseFloat(el.dataset.by ?? "0");
        const current = parseFloat(input.value);
        input.value = String(Math.max(0, (Number.isFinite(current) ? current : 0) + by));
        break;
      }
      case "save-set": {
        const id = el.dataset.id as string;
        const ex = state.active?.exercises.find((e) => e.id === id);
        if (!ex) break;
        const kind = ex.kind ?? "load";

        if (kind === "mark") {
          await svc.addSet(id, { weight: 0, reps: 1 });
        } else {
          const reps = num(`r-${id}`);
          if (!Number.isFinite(reps) || reps <= 0) {
            flash(`r-${id}`);
            break;
          }
          let weight = num(`w-${id}`);
          if (!Number.isFinite(weight)) {
            // Bodyweight and banded work legitimately has no load. A barbell
            // lift with a blank weight field is a mistake, so say so.
            if (kind === "load") {
              flash(`w-${id}`);
              break;
            }
            weight = 0;
          }
          const rpe = num(`e-${id}`);
          await svc.addSet(id, { weight, reps, ...(Number.isFinite(rpe) ? { rpe } : {}) });
        }

        state.lastSetAt = Date.now();
        state.active = await svc.getActive();
        advanceIfComplete(id);
        await refresh();
        break;
      }
      case "repeat-set": {
        const id = el.dataset.id as string;
        const ex = state.active?.exercises.find((e) => e.id === id);
        const last = ex?.sets[ex.sets.length - 1];
        if (!last) break;
        await svc.addSet(id, { weight: last.weight, reps: last.reps });
        state.lastSetAt = Date.now();
        state.active = await svc.getActive();
        advanceIfComplete(id);
        await refresh();
        break;
      }
      case "del-set": {
        await svc.deleteSet(el.dataset.ex as string, el.dataset.set as string);
        await refresh();
        break;
      }
      case "del-exercise": {
        if (!confirm("Remove this exercise and its sets?")) break;
        await svc.deleteExercise(el.dataset.id as string);
        await refresh();
        break;
      }
      case "delete-session": {
        if (!confirm("Delete this session permanently?")) break;
        await svc.deleteSession(el.dataset.id as string);
        await refresh();
        break;
      }
      case "export-json": {
        download(
          `liftlab-${filenameStamp()}.json`,
          JSON.stringify(toBundle(await allSessions()), null, 2),
          "application/json",
        );
        break;
      }
      case "export-csv": {
        download(`liftlab-${filenameStamp()}.csv`, toCsv(await allSessions()), "text/csv");
        break;
      }

      // ------------------------------------------------------------ dev only
      case "dev-seed":
      case "dev-seed-many": {
        if (!DEV) break;
        const { seedGauntlet } = await import("./dev");
        const weeks = action === "dev-seed-many" ? 6 : 1;
        for (let i = 0; i < weeks; i += 1) await seedGauntlet(store, i * 7);
        await refresh();
        alert(`Seeded ${weeks} [DEV] session${weeks === 1 ? "" : "s"}.`);
        break;
      }
      case "dev-wipe-seeded": {
        if (!DEV) break;
        const { wipeSeeded } = await import("./dev");
        const n = await wipeSeeded(store);
        await refresh();
        alert(`Deleted ${n} [DEV] session${n === 1 ? "" : "s"}.`);
        break;
      }
      case "dev-wipe": {
        if (!DEV) break;
        if (!confirm("Delete EVERY session on this device, including real ones?")) break;
        const { wipeAll } = await import("./dev");
        const n = await wipeAll(store);
        state.openExercise = null;
        state.openBlock = null;
        await refresh();
        alert(`Deleted ${n} sessions.`);
        break;
      }
    }
  } catch (err) {
    if (err instanceof ActiveSessionConflict) {
      alert("A workout is already active. Finish or discard it first.");
    } else {
      console.error(err);
      alert(`Something failed: ${(err as Error).message}`);
    }
  }
});

document.addEventListener("change", async (event) => {
  const el = event.target as HTMLElement;

  if (el.id === "importFile") {
    const file = (el as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const sessions = parseBundle(await file.text());
      if (store instanceof IdbStore) {
        const added = await store.importSessions(sessions);
        alert(`Imported ${added} new sessions (${sessions.length - added} already present).`);
      } else {
        for (const s of sessions) await store.putSession(s);
        alert(`Imported ${sessions.length} sessions into memory.`);
      }
      await refresh();
    } catch (err) {
      alert(`Import failed: ${(err as Error).message}`);
    }
    return;
  }

  if (el.dataset.action === "notes") await svc.setNotes((el as HTMLTextAreaElement).value);
  if (el.dataset.action === "bw") {
    const n = parseFloat((el as HTMLInputElement).value);
    if (Number.isFinite(n)) await svc.setBodyweight(n);
  }
});

// Enter in the weight/reps row saves the set — no reaching for a button mid-set.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const target = event.target as HTMLElement;
  const id = target.id ?? "";
  if (/^[wr]-/.test(id)) {
    event.preventDefault();
    const exId = id.slice(2);
    document.querySelector<HTMLElement>(`[data-action="save-set"][data-id="${exId}"]`)?.click();
  }
  if (id === "newExercise") {
    event.preventDefault();
    document.querySelector<HTMLElement>('[data-action="add-exercise"]')?.click();
  }
});

// Rest clock ticks without re-rendering the DOM under your thumbs.
setInterval(() => {
  const rest = document.getElementById("rest");
  if (rest) rest.textContent = restClock();
}, 1000);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(console.error);
  });
}

void refresh();
