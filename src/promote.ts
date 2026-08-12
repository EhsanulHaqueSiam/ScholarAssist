import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { lintConfig } from "./lint.js";
import { BlockedError } from "./profile.js";
import type { ProposedPatch } from "./run.js";

// Promote a run's repair proposals into a config file: each repaired locator
// is APPENDED as a fallback (the original primary stays authoritative).
// The edited file must still pass lint or nothing is written.
export function promotePatches(runDir: string, configFile: string): { applied: number; skipped: string[] } {
  const patchFile = path.join(runDir, "proposed-patch.json");
  if (!fs.existsSync(patchFile)) {
    throw new BlockedError(`No proposed-patch.json in ${runDir} — nothing to promote.`);
  }
  const { patches } = JSON.parse(fs.readFileSync(patchFile, "utf8")) as { patches: ProposedPatch[] };
  const doc = parseDocument(fs.readFileSync(configFile, "utf8"));
  const skipped: string[] = [];
  let applied = 0;

  for (const patch of patches) {
    let targetPath: (string | number)[] | null = null;
    if (patch.where.startsWith("fields.")) {
      targetPath = ["fields", patch.where.slice("fields.".length), "locator"];
    } else {
      // flows.<flow>.<page>.advance
      const m = /^flows\.([^.]+)\.([^.]+)\.advance$/.exec(patch.where);
      if (m) {
        const flowPages = doc.getIn(["flows", m[1], "pages"]);
        if (flowPages && typeof (flowPages as { items?: unknown[] }).items !== "undefined") {
          const pages = (flowPages as { items: unknown[] }).items;
          const idx = pages.findIndex(
            (p) => (p as { get?: (k: string) => unknown }).get?.("id") === m[2],
          );
          if (idx >= 0) targetPath = ["flows", m[1], "pages", idx, "advance", "target"];
        }
      }
    }
    if (!targetPath || !doc.hasIn(targetPath)) {
      skipped.push(patch.where);
      continue;
    }
    const fallbacksPath = [...targetPath, "fallbacks"];
    const existing = (doc.getIn(fallbacksPath, true) as { toJSON?: () => unknown[] })?.toJSON?.() ?? [];
    const dup = (existing as unknown[]).some(
      (f) => JSON.stringify(f) === JSON.stringify(patch.add_fallback),
    );
    if (dup) {
      skipped.push(`${patch.where} (already present)`);
      continue;
    }
    doc.setIn(fallbacksPath, [...(existing as unknown[]), patch.add_fallback]);
    applied++;
  }

  const updated = doc.toString();
  const { issues } = lintConfig(doc.toJSON());
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) {
    throw new BlockedError(
      `Promotion would break the config; not writing. First error: ${errors[0].path}: ${errors[0].message}`,
    );
  }
  if (applied) fs.writeFileSync(configFile, updated);
  return { applied, skipped };
}
