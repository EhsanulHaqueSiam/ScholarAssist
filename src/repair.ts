import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "playwright";
import { describeLocator } from "./engine.js";
import type { Locator, Target } from "./schema.js";

const exec = promisify(execFile);

// Rung 2/3: when every stored locator misses, hand a compact accessibility
// snapshot plus the step's intent to a model and ask for ONE replacement
// locator. Uses the user's own `claude` CLI so scholar never holds an API
// key. The page's a11y tree goes to the model; the user's profile data never
// does — the model proposes WHERE, never WHAT.
export interface RepairResult {
  locator: Locator;
  rung: 2;
}

export async function claudeAvailable(): Promise<boolean> {
  try {
    await exec("claude", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const LOCATOR_SHAPE = `{"role":"...","name":"..."} or {"label":"..."} or {"text":"..."} or {"css":"..."}`;

export async function repairLocator(
  page: Page,
  target: Target,
  intent: string,
): Promise<RepairResult | null> {
  const snapshot = await page
    .locator("body")
    .ariaSnapshot()
    .then((s) => (s.length > 30_000 ? s.slice(0, 30_000) + "\n...(truncated)" : s))
    .catch(() => null);
  if (!snapshot) return null;

  const tried = [target.primary, ...(target.fallbacks ?? [])].map(describeLocator).join(" | ");
  const prompt = [
    `You repair broken element locators for a form-filling tool.`,
    `Intent of this step: ${intent}`,
    `Locators that no longer match: ${tried}`,
    `Current page accessibility tree (YAML):`,
    "```yaml",
    snapshot,
    "```",
    `Reply with ONLY a single JSON locator, no prose: ${LOCATOR_SHAPE}.`,
    `Prefer role+name, then label, then text; css only if nothing semantic fits.`,
    `If no element on this page plausibly matches the intent, reply exactly: null`,
  ].join("\n");

  try {
    const { stdout } = await exec("claude", ["-p", prompt], {
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    });
    const raw = stdout.trim();
    const jsonMatch = /\{[^{}]*\}/.exec(raw);
    if (!jsonMatch) return null;
    const locator = JSON.parse(jsonMatch[0]) as Locator;
    const kinds = ["role", "label", "text", "testid", "css", "placeholder"].filter(
      (k) => (locator as Record<string, unknown>)[k] !== undefined,
    );
    if (kinds.length < 1) return null;
    return { locator, rung: 2 };
  } catch {
    return null;
  }
}
