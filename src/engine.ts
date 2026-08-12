import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Locator as PWLocator, type Page } from "playwright";
import type { Locator, Target } from "./schema.js";

// One persistent, HEADED profile — the user's own browser, visible. No
// headless authenticated flows, no stealth, no proxies: if a challenge
// (CAPTCHA, 2FA, email code) appears, the human is right there to solve it.
export const BROWSER_PROFILE_DIR = path.join(
  os.homedir(),
  ".local",
  "state",
  "scholar",
  "browser-profile",
);

export class StepError extends Error {}

export interface Resolved {
  loc: PWLocator;
  rung: 0 | 1;
  locator: Locator;
}

function build(page: Page, l: Locator): PWLocator | null {
  if (l.css) return page.locator(l.css);
  if (l.testid) return page.getByTestId(l.testid);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (l.role) return page.getByRole(l.role as any, l.name ? { name: l.name } : undefined);
  if (l.label) return page.getByLabel(l.label);
  if (l.placeholder) return page.getByPlaceholder(l.placeholder);
  if (l.text) return page.getByText(l.text);
  return null;
}

export function describeLocator(l: Locator): string {
  if (l.role) return `role=${l.role}${l.name ? ` name="${l.name}"` : ""}`;
  for (const k of ["label", "text", "testid", "css", "placeholder"] as const) {
    if (l[k]) return `${k}="${l[k]}"`;
  }
  return "(empty locator)";
}

export class Engine {
  private constructor(
    public context: BrowserContext,
    public page: Page,
  ) {}

  static async launch(opts: { headless?: boolean; profileDir?: string } = {}): Promise<Engine> {
    const context = await chromium.launchPersistentContext(
      opts.profileDir ?? BROWSER_PROFILE_DIR,
      { headless: opts.headless ?? false, viewport: null },
    );
    const page = context.pages()[0] ?? (await context.newPage());
    return new Engine(context, page);
  }

  // Rung 0: primary locator. Rung 1: ranked fallbacks. No LLM in this binary
  // yet — rungs 2+ (LLM repair) arrive in phase 3 of the plan.
  async resolve(target: Target): Promise<Resolved> {
    const candidates = [target.primary, ...(target.fallbacks ?? [])];
    for (let i = 0; i < candidates.length; i++) {
      const loc = build(this.page, candidates[i]);
      if (!loc) continue;
      try {
        await loc.first().waitFor({ state: "visible", timeout: i === 0 ? 5000 : 2000 });
        return { loc: loc.first(), rung: i === 0 ? 0 : 1, locator: candidates[i] };
      } catch {
        // fall through to next candidate
      }
    }
    throw new StepError(
      `No locator matched. Tried: ${candidates.map(describeLocator).join(" | ")}`,
    );
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
