# LiftLab

Local-first strength-training data acquisition, with a separate computational
analysis pipeline. The phone logs. The laptop models. Nothing in between.

```
PHONE  ── fast logger ──►  canonical JSON  ──►  LAPTOP  ── pandas / matplotlib ──►  figures, trends, later: models
```

Read `REQUIREMENTS.md` before adding a feature. It exists to keep the phone
client boring, which is the only reason the previous version stopped being used.

---

## app/ — the phone client

Vite · TypeScript · IndexedDB · no framework · no accounts · no network.

```bash
cd app
npm install
npm run dev -- --host       # prints a http://192.168.x.x:5173 URL
npm test                    # the session-invariant regression suite
npm run build && npm run preview -- --host
```

**Put it on your iPhone** (same Wi-Fi):

1. `npm run build && npm run preview -- --host`
2. Open the printed `http://192.168.…` address in **Safari** (not Chrome).
3. Share → **Add to Home Screen**. It launches full-screen, works offline, and
   keeps its data in IndexedDB on the phone.

For a permanent install, deploy `app/dist/` anywhere with HTTPS — GitHub Pages,
Netlify drop, Vercel — and add *that* URL to the home screen instead. HTTPS is
what makes the service worker and offline launch work.

### Logging a set, in taps

start → name (or a chip) → **Start** → type exercise → **+ Exercise** →
weight, reps → **Save set** → **Repeat 105×6** for each following set →
**Finish**. Enter in the weight or reps field saves the set, so a whole
straight-set exercise is: two numbers, Enter, Repeat, Repeat.

### The bug this version was written to kill

Discarding the current workout used to promote an old unfinished workout to
active, then another, and another. The cause was bootstrap logic that searched
history for "an unfinished session" instead of reading a single pointer.

Now: at most one active session, named by `meta.activeSessionId`; bootstrap
reads that pointer and never scans; discard clears it and promotes nothing.
`app/test/active-session.test.ts` runs the exact regression sequence —

```
no active → create A → resume A → discard A → no active
→ B and C stay history → restart app → still no active
```

`npm test` must pass before any commit that touches session logic.

---

## analysis/ — the laptop half

```bash
cd analysis
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python make_sample.py --weeks 10          # synthetic data, so the pipeline runs today
python liftlab.py sample/liftlab-sample.json --out figures --csv sample/tidy.csv
```

That prints a session/volume/PR summary and writes four figures:

| Figure | What it answers |
| --- | --- |
| `volume_by_session.png` | Is load trending up, and how noisy is it session to session? |
| `weekly_volume.png` | Weekly load, with session count per week |
| `e1rm_trajectories.png` | Per-lift estimated-1RM trend with PRs marked, as small multiples |
| `volume_by_exercise.png` | Where the work actually goes |

Real data replaces the synthetic file with nothing else changing: export from
the phone (Data → Export JSON), drop it in, run the same command.

Everything is a groupby over one tidy table (`tidy_sets`, one row per set). New
metrics go in as functions of that table — not as new parsers.

### Deliberately later

Sync. Muscle-group mapping. Fatigue/recovery modelling. Programme
recommendation. Exercise-graph representation and any transformer over it. All
of them need *months of real logged data* first, which is the entire argument
for making the logger boring and shipping it now.
