"""
Generate a synthetic LiftLab export so the analysis pipeline can be run and the
figures inspected before a single real workout has been logged.

    python make_sample.py --weeks 10 --out sample/liftlab-sample.json

The numbers are plausible but invented. Delete this file's output before drawing
any conclusion about your own training.
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

PLAN = {
    "Push": [("Overhead Press", 100, 6, 2.0), ("Incline Bench Press", 155, 8, 2.5),
             ("Cable Lateral Raise", 20, 15, 0.5), ("Triceps Rope Pushdown", 45, 12, 1.0)],
    "Pull": [("Barbell Row", 155, 8, 2.5), ("Lat Pulldown", 120, 10, 2.0),
             ("Face Pull", 35, 15, 0.5), ("Hammer Curl", 30, 10, 0.5)],
    "Legs": [("Back Squat", 205, 5, 4.0), ("Romanian Deadlift", 185, 8, 3.0),
             ("Leg Press", 300, 10, 6.0), ("Standing Calf Raise", 120, 12, 2.0)],
}


def build(weeks: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    start = datetime.now(timezone.utc) - timedelta(weeks=weeks)
    sessions: list[dict] = []
    bodyweight = 172.0

    for w in range(weeks):
        for day, (name, exercises) in zip((0, 2, 4), PLAN.items()):
            when = (start + timedelta(weeks=w, days=day)).replace(hour=20, minute=rng.randint(0, 50))
            deload = (w + 1) % 5 == 0  # a lighter week every fifth week
            clock = when
            payload = []

            for ex_i, (ex_name, base, reps, weekly_gain) in enumerate(exercises, start=1):
                load = base + weekly_gain * w
                if deload:
                    load *= 0.85
                load = round(load / 2.5) * 2.5
                sets = []
                for s in range(3):
                    clock += timedelta(minutes=rng.randint(2, 5))
                    got = max(1, reps - s + rng.choice([0, 0, -1]))
                    sets.append(
                        {
                            "id": f"set_{w}_{day}_{ex_i}_{s}",
                            "weight": load,
                            "reps": got,
                            "rpe": min(10.0, 7.0 + s + rng.choice([0, 0.5])),
                            "at": clock.isoformat().replace("+00:00", "Z"),
                        }
                    )
                payload.append({"id": f"ex_{w}_{day}_{ex_i}", "name": ex_name, "sets": sets})

            bodyweight += rng.uniform(-0.4, 0.55)
            sessions.append(
                {
                    "schema": 1,
                    "id": f"wk_{when:%Y%m%d}_{name.lower()}",
                    "date": f"{when:%Y-%m-%d}",
                    "name": name,
                    "startedAt": when.isoformat().replace("+00:00", "Z"),
                    "finishedAt": clock.isoformat().replace("+00:00", "Z"),
                    "bodyweight": round(bodyweight, 1),
                    "notes": rng.choice(["", "", "felt strong", "low sleep", "left shoulder cranky"]),
                    "exercises": payload,
                }
            )
    return sessions


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weeks", type=int, default=10)
    ap.add_argument("--seed", type=int, default=19)
    ap.add_argument("--out", type=Path, default=Path("sample/liftlab-sample.json"))
    args = ap.parse_args()

    sessions = build(args.weeks, args.seed)
    bundle = {
        "format": "liftlab.sessions",
        "schema": 1,
        "exportedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(sessions),
        "sessions": sessions,
        "_synthetic": True,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(bundle, indent=2))
    print(f"wrote {args.out} — {len(sessions)} synthetic sessions")


if __name__ == "__main__":
    main()
