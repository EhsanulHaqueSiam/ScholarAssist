import { buildDraft, proposeBindings, type Recording, type RecordedField, type RecordedClick, type RecordedNav } from "./draft.js";
import type { Locator } from "./schema.js";

// Converts a Chrome DevTools Recorder JSON export into a draft config.
// Recorder `change` steps carry the typed value — it is DISCARDED here;
// only selectors survive into the draft.

interface RecorderStep {
  type: string;
  url?: string;
  selectors?: string[][];
  value?: string;
}

interface RecorderExport {
  title?: string;
  steps: RecorderStep[];
}

function toLocator(sel: string): Locator | null {
  if (sel.startsWith("aria/")) return { label: sel.slice(5).replace(/\[role=.*\]$/, "").trim() };
  if (sel.startsWith("text/")) return { text: sel.slice(5) };
  if (sel.startsWith("pierce/")) return { css: sel.slice(7) };
  if (sel.startsWith("xpath/")) return null; // last-resort noise; ranked selectors above it suffice
  return { css: sel };
}

function toLocators(selectors: string[][] | undefined): Locator[] {
  const out: Locator[] = [];
  for (const group of selectors ?? []) {
    const l = toLocator(group[0]);
    if (l && !out.some((o) => JSON.stringify(o) === JSON.stringify(l))) out.push(l);
  }
  // Semantic first: label/text before css.
  return out.sort((a, b) => Number("css" in b) + Number("label" in a || "text" in a) - (Number("css" in a) + Number("label" in b || "text" in b)));
}

export function convertRecording(data: RecorderExport): { recording: Recording; warnings: string[] } {
  const warnings: string[] = [];
  const fields: RecordedField[] = [];
  const clicks: RecordedClick[] = [];
  const navs: RecordedNav[] = [];
  let ts = 0;

  for (const step of data.steps) {
    ts += 1;
    switch (step.type) {
      case "navigate":
        if (step.url) navs.push({ url: step.url, ts });
        break;
      case "change": {
        if (step.value) warnings.push("Discarded a recorded value (recordings must stay PII-free).");
        const selectors = toLocators(step.selectors);
        const aria = selectors.find((s) => "label" in s);
        fields.push({
          ts,
          selectors,
          evidence: { label: aria?.label, id: selectors.find((s) => s.css?.startsWith("#"))?.css?.slice(1) },
        });
        break;
      }
      case "click":
      case "doubleClick": {
        const selectors = toLocators(step.selectors);
        const aria = selectors.find((s) => "label" in s);
        clicks.push({ ts, text: aria?.label, role: "button", selectors: aria ? [{ role: "button", name: aria.label }, ...selectors.filter((s) => s !== aria)] : selectors });
        break;
      }
      case "setViewport":
      case "keyUp":
      case "keyDown":
      case "scroll":
        break;
      default:
        warnings.push(`Unsupported recorder step type skipped: ${step.type}`);
    }
  }
  if (!navs.length) warnings.push("Recording has no navigate step; draft will need a navigate added.");
  return {
    recording: { startUrl: navs[0]?.url ?? "", fields, clicks, navs },
    warnings,
  };
}

export function importRecording(json: string): { yaml: string; warnings: string[] } {
  const data = JSON.parse(json) as RecorderExport;
  const { recording, warnings } = convertRecording(data);
  const bindings = proposeBindings(recording.fields);
  return { yaml: buildDraft(recording, bindings), warnings };
}
