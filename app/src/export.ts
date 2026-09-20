import { durationMinutes, sessionSetCount, sessionVolume, type Session } from "./model";

export type ExportBundle = {
  format: "liftlab.sessions";
  schema: 1;
  exportedAt: string;
  count: number;
  sessions: Session[];
};

/** JSON is the source of truth. CSV below is a projection of it. */
export function toBundle(sessions: Session[]): ExportBundle {
  return {
    format: "liftlab.sessions",
    schema: 1,
    exportedAt: new Date().toISOString(),
    count: sessions.length,
    sessions,
  };
}

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Added with templates: `block`, `kind`, `per_side`, `target`, `template_id`.
 *
 * `per_side` is the one that changes arithmetic downstream — a per-side set is
 * two limbs' worth of work, so anything summing `weight * reps` has to double
 * it. Selecting columns by name means an older export with fewer columns still
 * loads; the new ones just come back missing.
 */
export const CSV_COLUMNS = [
  "session_id",
  "date",
  "session_name",
  "template_id",
  "started_at",
  "finished_at",
  "duration_min",
  "bodyweight",
  "block",
  "exercise",
  "kind",
  "per_side",
  "target",
  "set_index",
  "weight",
  "reps",
  "rpe",
  "set_at",
  "session_volume",
  "session_sets",
  "notes",
] as const;

/** One row per set. This is the shape pandas wants. */
export function toCsv(sessions: Session[]): string {
  const rows: string[] = [CSV_COLUMNS.join(",")];

  for (const s of sessions) {
    const common = [
      s.id,
      s.date,
      s.name,
      s.templateId ?? "",
      s.startedAt,
      s.finishedAt ?? "",
      durationMinutes(s) ?? "",
      s.bodyweight ?? "",
    ];
    const tail = [sessionVolume(s), sessionSetCount(s), s.notes ?? ""];

    // 10 per-set columns sit between `common` and `tail`; a row with nothing to
    // say in them still has to hold their places.
    const blanks = (n: number) => Array.from({ length: n }, () => "");

    if (s.exercises.length === 0) {
      rows.push([...common, ...blanks(10), ...tail].map(csvCell).join(","));
      continue;
    }

    for (const ex of s.exercises) {
      const exCols = [
        ex.block ?? "",
        ex.name,
        ex.kind ?? "load",
        ex.perSide ? 1 : 0,
        ex.target ?? "",
      ];

      if (ex.sets.length === 0) {
        rows.push([...common, ...exCols, ...blanks(5), ...tail].map(csvCell).join(","));
        continue;
      }
      ex.sets.forEach((st, i) => {
        rows.push(
          [...common, ...exCols, i + 1, st.weight, st.reps, st.rpe ?? "", st.at, ...tail]
            .map(csvCell)
            .join(","),
        );
      });
    }
  }

  return rows.join("\n") + "\n";
}

export function filenameStamp(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/**
 * Download a file. On iOS Safari this opens the share sheet, which is how the
 * file reaches Files / iCloud Drive and therefore the Mac.
 */
export function download(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function parseBundle(text: string): Session[] {
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed as Session[];
  const bundle = parsed as Partial<ExportBundle>;
  if (bundle && Array.isArray(bundle.sessions)) return bundle.sessions;
  throw new Error("not a LiftLab export");
}
