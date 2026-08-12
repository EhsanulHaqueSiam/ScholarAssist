import { stringify } from "yaml";
import { matchField, looksFreeform, type FieldEvidence } from "./fieldmatch.js";
import type { Locator } from "./schema.js";

// Shared by both recorders: turns captured interactions into a draft config.
// Values are never present in the input — recorders capture evidence and
// selectors only, so drafts are PII-free by construction.

export interface RecordedField {
  evidence: FieldEvidence;
  selectors: Locator[]; // ranked: semantic first
  ts: number;
}

export interface RecordedClick {
  text?: string;
  role?: string;
  selectors: Locator[];
  ts: number;
}

export interface RecordedNav {
  url: string;
  ts: number;
}

export interface Recording {
  startUrl: string;
  fields: RecordedField[];
  clicks: RecordedClick[];
  navs: RecordedNav[];
}

export interface DraftBinding {
  key: string;
  confidence: string;
  evidence: FieldEvidence;
  selectors: Locator[];
  freeform: boolean;
}

// Propose a profile-key binding per field. Unmatched fields get a
// todo.<slug> key the human must rename before the config will feel right;
// lint still passes because todo keys are just unknown profile keys.
export function proposeBindings(fields: RecordedField[]): DraftBinding[] {
  const seen = new Set<string>();
  const out: DraftBinding[] = [];
  for (const f of fields) {
    const sig = JSON.stringify(f.selectors[0] ?? f.evidence);
    if (seen.has(sig)) continue;
    seen.add(sig);
    const freeform = looksFreeform(f.evidence);
    const match = matchField(f.evidence);
    const key = freeform
      ? `essay.${slug(f.evidence.label ?? f.evidence.name ?? "answer")}`
      : (match?.key ?? `todo.${slug(f.evidence.label ?? f.evidence.name ?? f.evidence.id ?? "field")}`);
    out.push({ key, confidence: match?.confidence ?? "unmatched", evidence: f.evidence, selectors: f.selectors, freeform });
  }
  return out;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";

function hostGlobs(startUrl: string): string[] {
  try {
    const u = new URL(startUrl);
    if (u.protocol === "file:") return ["file://**"];
    const host = u.hostname.replace(/^www\./, "");
    return [`https://*.${host}/**`, `https://${host}/**`];
  } catch {
    return [startUrl];
  }
}

export function buildDraft(rec: Recording, bindings: DraftBinding[]): string {
  const siteId = (() => {
    try {
      const u = new URL(rec.startUrl);
      return u.protocol === "file:" ? "local-draft" : u.hostname.replace(/^www\./, "").split(".")[0];
    } catch {
      return "draft";
    }
  })();

  // Page boundaries: each recorded main-frame navigation after the first
  // starts a new page. Fields and clicks are assigned by timestamp.
  const boundaries = rec.navs.map((n) => n.ts);
  const pageOf = (ts: number) => {
    let p = 0;
    for (let i = 1; i < boundaries.length; i++) if (ts >= boundaries[i]) p = i;
    return p;
  };
  const pageCount = Math.max(1, boundaries.length);

  const fieldsMap: Record<string, unknown> = {};
  for (const b of bindings) {
    fieldsMap[b.key] = {
      locator: {
        primary: b.selectors[0] ?? { css: "TODO" },
        ...(b.selectors.length > 1 ? { fallbacks: b.selectors.slice(1) } : {}),
      },
      ...(b.freeform ? { kind: "freeform" } : {}),
      ...(b.evidence.autocomplete ? { autocomplete: b.evidence.autocomplete } : {}),
    };
  }

  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    const pageFields = rec.fields
      .filter((f) => pageOf(f.ts) === p)
      .map((f) => bindings.find((b) => JSON.stringify(b.selectors) === JSON.stringify(f.selectors))?.key)
      .filter((k, i, arr): k is string => !!k && arr.indexOf(k) === i);
    const pageClicks = rec.clicks.filter((c) => pageOf(c.ts) === p);
    // Heuristic: the last click on a page is the advance; earlier clicks are steps.
    const advance = pageClicks.at(-1);
    const steps: unknown[] = [];
    if (p === 0) steps.push({ action: "navigate", url: rec.navs[0]?.url ?? rec.startUrl });
    if (pageFields.length) steps.push({ action: "fill_fields", fields: pageFields });
    for (const c of pageClicks.slice(0, -1)) {
      steps.push({ action: "click", target: { primary: c.selectors[0], ...(c.selectors.length > 1 ? { fallbacks: c.selectors.slice(1) } : {}) } });
    }
    const isLast = p === pageCount - 1;
    pages.push({
      id: p === 0 ? "start" : `page-${p + 1}`,
      steps,
      ...(advance
        ? {
            advance: {
              target: { primary: advance.selectors[0], ...(advance.selectors.length > 1 ? { fallbacks: advance.selectors.slice(1) } : {}) },
              ...(isLast && /submit|apply|finish/i.test(advance.text ?? "") ? { submit: true } : {}),
            },
          }
        : {}),
    });
  }

  const config = {
    schema_version: 1,
    site: {
      id: siteId,
      match: hostGlobs(rec.startUrl),
      last_verified: new Date().toISOString().slice(0, 10),
    },
    fields: fieldsMap,
    flows: { apply: { pages } },
  };

  const todos = bindings.filter((b) => b.confidence === "unmatched" && !b.freeform);
  const header =
    `# Draft recorded ${new Date().toISOString().slice(0, 10)} — review before use.\n` +
    (todos.length
      ? `# TODO: ${todos.length} field(s) could not be matched to a profile key (todo.*): rename them.\n`
      : "") +
    `# Verify with: scholar config verify <this file> --flow apply\n`;
  return header + stringify(config);
}
