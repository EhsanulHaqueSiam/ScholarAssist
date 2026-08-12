import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { BlockedError } from "./profile.js";

// Application tracker: one YAML file, resumable states, cycle-aware dedupe.
// `blocked_on_human` is first-class: recommenders, transcripts, CAPTCHAs and
// verification emails are tracked work, not silent failures.
export const STATES = [
  "planned",
  "in_progress",
  "blocked_on_human",
  "ready_to_submit",
  "submitted",
  "won",
  "rejected",
] as const;
export type AppState = (typeof STATES)[number];

export interface Application {
  id: string;
  site: string;
  award: string;
  cycle?: string; // e.g. "2026-09" for recurring draws; part of the dedupe key
  deadline?: string; // ISO instant WITH offset, e.g. 2026-10-07T12:00:00Z
  deadline_tz?: string; // the source timezone as the sponsor states it
  state: AppState;
  notes?: string;
  run_dir?: string;
  created: string;
  updated: string;
}

export const TRACK_PATH = path.join(os.homedir(), ".local", "state", "scholar", "applications.yaml");

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function loadApps(file = TRACK_PATH): Application[] {
  if (!fs.existsSync(file)) return [];
  return (parse(fs.readFileSync(file, "utf8")) ?? []) as Application[];
}

export function saveApps(apps: Application[], file = TRACK_PATH): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify(apps));
}

export function dedupeKey(app: Pick<Application, "site" | "award" | "cycle">): string {
  return `${normalize(app.site)}/${normalize(app.award)}/${app.cycle ?? ""}`;
}

export function findDuplicate(
  apps: Application[],
  candidate: Pick<Application, "site" | "award" | "cycle">,
): Application | undefined {
  const key = dedupeKey(candidate);
  const exact = apps.find((a) => dedupeKey(a) === key);
  if (exact) return exact;
  // Near-match: same site+cycle, one award name containing the other.
  const na = normalize(candidate.award);
  return apps.find(
    (a) =>
      normalize(a.site) === normalize(candidate.site) &&
      (a.cycle ?? "") === (candidate.cycle ?? "") &&
      (normalize(a.award).includes(na) || na.includes(normalize(a.award))),
  );
}

export function addApp(
  apps: Application[],
  input: { site: string; award: string; cycle?: string; deadline?: string; deadline_tz?: string; notes?: string },
  force = false,
): Application {
  const dup = findDuplicate(apps, input);
  if (dup && !force) {
    throw new BlockedError(
      `Looks like a duplicate of "${dup.award}" (${dup.site}, state: ${dup.state}). ` +
        `Duplicate entries get applications disqualified. Use --force only if it is genuinely different.`,
    );
  }
  if (input.deadline && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(input.deadline)) {
    throw new BlockedError(
      `Deadline needs an explicit UTC offset (e.g. 2026-10-07T12:00:00Z or ...T23:59:00-07:00). ` +
        `A deadline without one is a missed deadline waiting to happen.`,
    );
  }
  const now = new Date().toISOString();
  const app: Application = {
    id: Math.random().toString(36).slice(2, 8),
    state: "planned",
    created: now,
    updated: now,
    ...input,
  };
  apps.push(app);
  return app;
}

export function setState(apps: Application[], id: string, state: AppState, notes?: string): Application {
  const app = apps.find((a) => a.id === id || a.id.startsWith(id));
  if (!app) throw new BlockedError(`No tracked application matching id \`${id}\``);
  if (!STATES.includes(state)) throw new BlockedError(`Unknown state \`${state}\`. One of: ${STATES.join(", ")}`);
  app.state = state;
  if (notes) app.notes = notes;
  app.updated = new Date().toISOString();
  return app;
}

// Accept human deadline input ("6 Oct 2026 11:00 UTC") as well as ISO, but
// still refuse anything without an explicit timezone — a naive deadline is a
// missed deadline. Returns a normalized ISO instant.
export function parseDeadlineInput(input: string): string {
  const hasZone = /\b(UTC|GMT)\b/i.test(input) || /[Zz]$|[+-]\d{2}:?\d{2}$/.test(input.trim());
  if (!hasZone) {
    throw new BlockedError(
      `Deadline "${input}" has no explicit timezone. Say "6 Oct 2026 11:00 UTC" or ` +
        `"2026-10-07T23:59:00-07:00" — a deadline without one is a missed deadline waiting to happen.`,
    );
  }
  const t = new Date(input);
  if (Number.isNaN(t.getTime())) {
    throw new BlockedError(`Could not parse deadline "${input}". Try "6 Oct 2026 11:00 UTC".`);
  }
  return t.toISOString();
}

export function timeLeft(deadline: string): { ms: number; human: string } {
  const ms = new Date(deadline).getTime() - Date.now();
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const human = ms < 0 ? `PASSED ${days}d ago` : days > 0 ? `${days}d ${hours}h` : `${hours}h`;
  return { ms, human };
}

export function formatList(apps: Application[]): string {
  const sorted = [...apps].sort((a, b) => {
    const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    return da - db;
  });
  if (!sorted.length) return "(nothing tracked — scholar track add <site> --award ...)";
  return sorted
    .map((a) => {
      const dl = a.deadline
        ? `${timeLeft(a.deadline).human.padEnd(14)} ${a.deadline}${a.deadline_tz ? ` (${a.deadline_tz})` : ""}`
        : "no deadline";
      return `${a.id}  ${a.state.padEnd(16)} ${dl.padEnd(45)} ${a.site}: ${a.award}${a.notes ? `\n        ${a.notes}` : ""}`;
    })
    .join("\n");
}
