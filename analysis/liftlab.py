"""
LiftLab analysis — the laptop half of the system.

The phone acquires data. This does everything the phone deliberately does not:
tidy the records, compute volume and estimated-1RM trajectories, find PRs, and
write figures.

Usage
-----
    python liftlab.py export.json                 # figures + summary
    python liftlab.py exports/ --out figures/     # a directory of exports
    python liftlab.py export.json --csv tidy.csv  # also write the tidy table

Design notes
------------
* One tidy DataFrame, one row per set, is the only intermediate representation.
  Every metric below is a groupby over it. If you add a metric, add it as a
  function of `tidy`, not as a new parser.
* e1RM is Epley: w * (1 + r/30). It is a formula, not a measurement — treated
  here as a trend indicator, never reported as a tested max.
* Figures follow one rule that matters more than any styling choice: never two
  y-scales on one plot. Different measures get different axes or facets.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")  # write files, never try to open a window
import matplotlib.pyplot as plt  # noqa: E402

# --------------------------------------------------------------------- style

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_SOFT = "#52514e"
GRID = "#e6e5e2"
# Categorical slots, assigned in fixed order and never cycled.
SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]

plt.rcParams.update(
    {
        "figure.facecolor": SURFACE,
        "axes.facecolor": SURFACE,
        "savefig.facecolor": SURFACE,
        "axes.edgecolor": GRID,
        "axes.labelcolor": INK_SOFT,
        "axes.titlecolor": INK,
        "axes.titlesize": 11,
        "axes.titleweight": "600",
        "axes.labelsize": 9,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "xtick.color": INK_SOFT,
        "ytick.color": INK_SOFT,
        "xtick.labelsize": 8,
        "ytick.labelsize": 8,
        "grid.color": GRID,
        "grid.linewidth": 0.8,
        "legend.frameon": False,
        "legend.fontsize": 8,
        "font.size": 9,
        "figure.dpi": 140,
    }
)


def _style(ax, title: str, ylabel: str = "") -> None:
    ax.set_title(title, loc="left", pad=10)
    if ylabel:
        ax.set_ylabel(ylabel)
    ax.grid(axis="y", alpha=0.7)
    ax.set_axisbelow(True)


# ---------------------------------------------------------------- load/tidy


def load_sessions(path: Path) -> list[dict]:
    """Accept a single export, a directory of exports, or a bare list."""
    files = sorted(path.glob("*.json")) if path.is_dir() else [path]
    if not files:
        sys.exit(f"no .json files found in {path}")

    sessions: dict[str, dict] = {}
    for f in files:
        blob = json.loads(f.read_text())
        found = blob if isinstance(blob, list) else blob.get("sessions", [])
        for s in found:
            sessions[s["id"]] = s  # later files win, ids dedupe across exports
    if not sessions:
        sys.exit("no sessions in the export")
    return sorted(sessions.values(), key=lambda s: s["startedAt"])


def tidy_sets(sessions: list[dict]) -> pd.DataFrame:
    """One row per logged set. This is the table everything else groups over."""
    rows = []
    for s in sessions:
        duration = None
        if s.get("finishedAt"):
            duration = (
                pd.Timestamp(s["finishedAt"]) - pd.Timestamp(s["startedAt"])
            ).total_seconds() / 60.0
        for ex in s.get("exercises", []):
            for i, st in enumerate(ex.get("sets", []), start=1):
                rows.append(
                    {
                        "session_id": s["id"],
                        "date": pd.Timestamp(s["date"]),
                        "session": s.get("name", ""),
                        "finished": s.get("finishedAt") is not None,
                        "duration_min": duration,
                        "bodyweight": s.get("bodyweight"),
                        "exercise": ex["name"].strip(),
                        "set_index": i,
                        "weight": float(st["weight"]),
                        "reps": int(st["reps"]),
                        "rpe": st.get("rpe"),
                    }
                )

    df = pd.DataFrame(rows)
    if df.empty:
        sys.exit("sessions contain no sets yet — log a workout first")

    df["volume"] = df["weight"] * df["reps"]
    df["e1rm"] = np.where(df["reps"] <= 1, df["weight"], df["weight"] * (1 + df["reps"] / 30))
    df["week"] = df["date"].dt.to_period("W").dt.start_time
    return df.sort_values(["date", "exercise", "set_index"]).reset_index(drop=True)


# ------------------------------------------------------------------ metrics


@dataclass
class Report:
    tidy: pd.DataFrame
    by_session: pd.DataFrame
    by_week: pd.DataFrame
    by_exercise: pd.DataFrame
    prs: pd.DataFrame


def build_report(tidy: pd.DataFrame) -> Report:
    by_session = (
        tidy.groupby(["session_id", "date", "session"], as_index=False)
        .agg(
            volume=("volume", "sum"),
            sets=("weight", "size"),
            reps=("reps", "sum"),
            exercises=("exercise", "nunique"),
            duration_min=("duration_min", "first"),
            bodyweight=("bodyweight", "first"),
        )
        .sort_values("date")
    )
    by_session["volume_roll3"] = by_session["volume"].rolling(3, min_periods=1).mean()

    by_week = (
        tidy.groupby("week", as_index=False)
        .agg(volume=("volume", "sum"), sets=("weight", "size"), sessions=("session_id", "nunique"))
        .sort_values("week")
    )

    by_exercise = (
        tidy.groupby("exercise", as_index=False)
        .agg(
            sets=("weight", "size"),
            volume=("volume", "sum"),
            top_weight=("weight", "max"),
            best_e1rm=("e1rm", "max"),
            sessions=("session_id", "nunique"),
            last_seen=("date", "max"),
        )
        .sort_values("volume", ascending=False)
    )

    # A PR is a set whose e1RM beats every e1RM logged earlier for that lift.
    # The first set of a lift establishes the baseline and is not a PR.
    prs = []
    for name, grp in tidy.groupby("exercise"):
        best = -np.inf
        first = True
        for _, row in grp.sort_values(["date", "set_index"]).iterrows():
            if row["e1rm"] > best:
                best = row["e1rm"]
                if not first:
                    prs.append(
                        {
                            "exercise": name,
                            "date": row["date"],
                            "weight": row["weight"],
                            "reps": row["reps"],
                            "e1rm": row["e1rm"],
                        }
                    )
            first = False

    pr_df = pd.DataFrame(prs, columns=["exercise", "date", "weight", "reps", "e1rm"])
    return Report(tidy, by_session, by_week, by_exercise, pr_df)


# ------------------------------------------------------------------ figures


def fig_session_volume(rep: Report, out: Path) -> Path:
    d = rep.by_session
    fig, ax = plt.subplots(figsize=(8.2, 3.4))
    ax.bar(d["date"], d["volume"], width=2.2, color=SERIES[0], label="Session volume")
    ax.plot(
        d["date"],
        d["volume_roll3"],
        color=SERIES[1],
        linewidth=2,
        marker="o",
        markersize=4,
        label="3-session mean",
    )
    # Direct label instead of trusting the legend colour alone.
    ax.annotate(
        "3-session mean",
        (d["date"].iloc[-1], d["volume_roll3"].iloc[-1]),
        textcoords="offset points",
        xytext=(-6, 10),
        ha="right",
        color=SERIES[1],
        fontsize=8,
        fontweight="600",
    )
    _style(ax, "Volume per session", "lb · reps")
    ax.legend(loc="upper left")
    fig.autofmt_xdate()
    path = out / "volume_by_session.png"
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def fig_weekly_volume(rep: Report, out: Path) -> Path:
    d = rep.by_week
    fig, ax = plt.subplots(figsize=(8.2, 3.0))
    ax.bar(d["week"], d["volume"], width=4.5, color=SERIES[0])
    for x, y, n in zip(d["week"], d["volume"], d["sessions"]):
        ax.annotate(
            f"{n}×",
            (x, y),
            textcoords="offset points",
            xytext=(0, 4),
            ha="center",
            fontsize=7,
            color=INK_SOFT,
        )
    _style(ax, "Weekly load  (label = sessions that week)", "lb · reps")
    fig.autofmt_xdate()
    path = out / "weekly_volume.png"
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def fig_e1rm_facets(rep: Report, out: Path, top: int = 6) -> Path:
    """Small multiples, not eight lines on one axis."""
    names = rep.by_exercise.head(top)["exercise"].tolist()
    cols = 2
    rows = int(np.ceil(len(names) / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(8.2, 2.0 * rows + 0.8), squeeze=False)

    for ax, name in zip(axes.flat, names):
        g = rep.tidy[rep.tidy["exercise"] == name]
        best = g.groupby("date", as_index=False)["e1rm"].max()
        ax.plot(best["date"], best["e1rm"], color=SERIES[0], linewidth=2, marker="o", markersize=4)

        if len(best) >= 3:  # a trend line only where there is a trend to fit
            x = matplotlib.dates.date2num(best["date"])
            slope, intercept = np.polyfit(x, best["e1rm"], 1)
            ax.plot(best["date"], slope * x + intercept, color=INK_SOFT, linewidth=1, linestyle=":")
            ax.annotate(
                f"{slope * 7:+.1f} lb/wk",
                (best["date"].iloc[0], best["e1rm"].max()),
                fontsize=7,
                color=INK_SOFT,
            )

        if not rep.prs.empty:
            p = rep.prs[rep.prs["exercise"] == name]
            if not p.empty:
                ax.scatter(
                    p["date"],
                    p["e1rm"],
                    s=46,
                    facecolors="none",
                    edgecolors=INK,
                    linewidths=1.4,
                    zorder=5,
                    label="PR",
                )
                ax.legend(loc="lower right")

        _style(ax, name, "est. 1RM (lb)")
        ax.tick_params(axis="x", rotation=30)

    for ax in axes.flat[len(names) :]:
        ax.set_visible(False)

    fig.suptitle(
        "Estimated 1RM trajectories  ·  Epley estimate, open circles = PRs",
        x=0.01,
        ha="left",
        fontsize=11,
        fontweight="600",
        color=INK,
    )
    path = out / "e1rm_trajectories.png"
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    fig.savefig(path)
    plt.close(fig)
    return path


def fig_exercise_volume(rep: Report, out: Path, top: int = 10) -> Path:
    d = rep.by_exercise.head(top).iloc[::-1]
    fig, ax = plt.subplots(figsize=(8.2, 0.42 * len(d) + 1.4))
    ax.barh(d["exercise"], d["volume"], color=SERIES[0], height=0.62)
    for y, (v, s) in enumerate(zip(d["volume"], d["sets"])):
        ax.annotate(
            f"{v:,.0f} lb · {s} sets",
            (v, y),
            textcoords="offset points",
            xytext=(6, 0),
            va="center",
            fontsize=7.5,
            color=INK_SOFT,
        )
    ax.set_title("Volume by exercise", loc="left", pad=10)
    ax.grid(axis="x", alpha=0.7)
    ax.set_axisbelow(True)
    ax.set_xlim(0, d["volume"].max() * 1.28)
    ax.set_xlabel("lb · reps")
    path = out / "volume_by_exercise.png"
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


# ------------------------------------------------------------------ summary


def print_summary(rep: Report) -> None:
    t, s, e = rep.tidy, rep.by_session, rep.by_exercise
    span = f"{t['date'].min():%Y-%m-%d} → {t['date'].max():%Y-%m-%d}"
    print(f"\nLiftLab — {len(s)} sessions, {len(t)} sets, {span}\n")

    print(f"  total volume      {t['volume'].sum():,.0f} lb·reps")
    print(f"  median session    {s['volume'].median():,.0f} lb·reps, {s['sets'].median():.0f} sets")
    if s["duration_min"].notna().any():
        print(f"  median duration   {s['duration_min'].median():.0f} min")
    if t["bodyweight"].notna().any():
        bw = t.dropna(subset=["bodyweight"]).groupby("date")["bodyweight"].first()
        print(f"  bodyweight        {bw.iloc[0]:.1f} → {bw.iloc[-1]:.1f} lb")
    if t["rpe"].notna().any():
        print(f"  mean RPE          {t['rpe'].dropna().mean():.1f}")

    print("\n  top lifts by volume")
    for _, r in e.head(6).iterrows():
        print(
            f"    {r['exercise'][:26]:<26} {r['volume']:>9,.0f} lb·reps"
            f"  top {r['top_weight']:.0f} lb   e1RM {r['best_e1rm']:.0f}"
        )

    if not rep.prs.empty:
        print(f"\n  PRs ({len(rep.prs)})")
        for _, r in rep.prs.sort_values("date").tail(8).iterrows():
            print(
                f"    {r['date']:%Y-%m-%d}  {r['exercise'][:24]:<24} "
                f"{r['weight']:.0f} lb × {r['reps']}  → e1RM {r['e1rm']:.0f}"
            )

    stale = e[e["last_seen"] < t["date"].max() - pd.Timedelta(days=21)]
    if not stale.empty:
        print("\n  not trained in 3+ weeks: " + ", ".join(stale["exercise"].head(8)))
    print()


# --------------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser(description="Analyse LiftLab exports.")
    ap.add_argument("input", type=Path, help="export .json, or a directory of them")
    ap.add_argument("--out", type=Path, default=Path("figures"), help="figure directory")
    ap.add_argument("--csv", type=Path, help="also write the tidy one-row-per-set table")
    ap.add_argument("--no-figures", action="store_true", help="summary only")
    args = ap.parse_args()

    sessions = load_sessions(args.input)
    tidy = tidy_sets(sessions)
    rep = build_report(tidy)

    print_summary(rep)

    if args.csv:
        args.csv.parent.mkdir(parents=True, exist_ok=True)
        tidy.to_csv(args.csv, index=False)
        print(f"  wrote {args.csv}")

    if not args.no_figures:
        args.out.mkdir(parents=True, exist_ok=True)
        for path in (
            fig_session_volume(rep, args.out),
            fig_weekly_volume(rep, args.out),
            fig_e1rm_facets(rep, args.out),
            fig_exercise_volume(rep, args.out),
        ):
            print(f"  wrote {path}")
        print()


if __name__ == "__main__":
    main()
