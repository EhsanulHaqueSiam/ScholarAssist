import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { globToRegex } from "./lint.js";
import { Engine, StepError, describeLocator, type Resolved } from "./engine.js";
import { repairLocator } from "./repair.js";
import {
  BlockedError,
  expandHome,
  loadProfile,
  resolveKey,
  resolveTemplate,
  type Profile,
} from "./profile.js";
import type { PageDef, SiteConfig, Step, Target } from "./schema.js";

export type Mode = "step" | "auto";

export interface RunOptions {
  flow: string;
  mode: Mode;
  dryRun: boolean;
  headless?: boolean;
  profilePath?: string;
  browserProfileDir?: string;
  inputs: Record<string, string | number | boolean>;
  runDir?: string;
  // Rung 2: on locator failure, ask the user's `claude` CLI to propose a
  // replacement. Proposals go to a patch file, never silently into the config.
  repair?: boolean;
  // test hook: replaces interactive prompts. Production code never sets it.
  confirm?: (question: string) => Promise<string>;
}

export interface FillRecord {
  page: string;
  field: string;
  value: string;
  source: string;
  rung: number;
  locator: string;
}

export interface ProposedPatch {
  where: string; // "fields.<key>" or "flows.<flow>.<page>.<step-id>"
  add_fallback: Record<string, string>;
}

export interface RunResult {
  status: "submitted" | "dry-run" | "aborted" | "blocked";
  fills: FillRecord[];
  runDir: string;
  reason?: string;
  patches: ProposedPatch[];
  rungsUsed: number[];
}

// Pages asking for these are either scams or out of scope by design. The
// tripwire fires regardless of what the config says.
const TRIPWIRE_RE = /\b(ssn|social security|bank account|routing number|credit card|card number|fsa id)\b/i;

async function ask(question: string, confirm?: RunOptions["confirm"]): Promise<string> {
  if (confirm) return confirm(question);
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

function makeRunDir(base?: string): string {
  const dir =
    base ??
    path.join(
      os.homedir(),
      ".local",
      "state",
      "scholar",
      "runs",
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function runFlow(config: SiteConfig, opts: RunOptions): Promise<RunResult> {
  const flow = config.flows[opts.flow];
  if (!flow) throw new BlockedError(`Flow \`${opts.flow}\` not found in config \`${config.site.id}\``);

  for (const input of flow.inputs ?? []) {
    if (!(input.name in opts.inputs)) {
      if (input.default !== undefined) opts.inputs[input.name] = input.default;
      else if (input.required)
        throw new BlockedError(`Missing required input \`${input.name}\`. Pass --input ${input.name}=...`);
    }
  }

  const profile: Profile = loadProfile(opts.profilePath);
  const runDir = makeRunDir(opts.runDir);
  const auditPath = path.join(runDir, "audit.jsonl");
  const audit = (entry: Record<string, unknown>) =>
    fs.appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  const matchRes = config.site.match.map(globToRegex);
  const fills: FillRecord[] = [];
  const patches: ProposedPatch[] = [];
  const rungsUsed: number[] = [];

  const engine = await Engine.launch({
    headless: opts.headless,
    profileDir: opts.browserProfileDir,
  });
  const page = engine.page;

  const checkOrigin = () => {
    const url = page.url();
    if (url !== "about:blank" && !matchRes.some((r) => r.test(url))) {
      throw new BlockedError(`Navigation left the config's declared origins: ${url}`);
    }
  };

  // resolve with the ladder: rungs 0-1 in the engine, rung 2 = LLM repair.
  // A repaired locator is verified (it must resolve) and recorded as a
  // proposed patch — never silently written into the config.
  type LadderResolved = Omit<Resolved, "rung"> & { rung: number };
  const resolve = async (target: Target, where: string, intent: string): Promise<LadderResolved> => {
    try {
      const r = await engine.resolve(target);
      rungsUsed.push(r.rung);
      return r;
    } catch (err) {
      if (!opts.repair || !(err instanceof StepError)) throw err;
      audit({ action: "repair-attempt", where, intent });
      const repaired = await repairLocator(page, target, intent);
      if (!repaired) throw err;
      const r = await engine.resolve({ primary: repaired.locator });
      rungsUsed.push(2);
      patches.push({
        where,
        add_fallback: Object.fromEntries(
          Object.entries(repaired.locator).filter(([, v]) => v !== undefined),
        ) as Record<string, string>,
      });
      audit({ action: "repair-success", where, locator: describeLocator(repaired.locator) });
      return { ...r, rung: 2 };
    }
  };

  const checkTripwires = async () => {
    const text = await page
      .locator("label, legend, th")
      .allInnerTexts()
      .then((t) => t.join("\n"))
      .catch(() => "");
    const hit = TRIPWIRE_RE.exec(text);
    if (hit) {
      throw new BlockedError(
        `This page asks for "${hit[0]}". Legitimate scholarships never need this before selection. ` +
          `Stopping. If you believe this is a scam, report it at https://reportfraud.ftc.gov`,
      );
    }
  };

  const fillOne = async (
    pageDef: PageDef,
    field: string,
    value: string,
    source: string,
    kind: string | undefined,
    maxChars: number | undefined,
    target: Target,
  ) => {
    if (maxChars !== undefined && value.length > maxChars) {
      throw new BlockedError(
        `\`${field}\` is ${value.length} chars; this site allows ${maxChars}. ` +
          `Shorten it yourself — I won't truncate your writing.`,
      );
    }
    const resolved = await resolve(target, `fields.${field}`, `fill the "${field}" form field`);
    if (kind === "select") {
      await resolved.loc.selectOption({ label: value }).catch(() => resolved.loc.selectOption(value));
    } else {
      await resolved.loc.fill(value);
    }
    const record: FillRecord = {
      page: pageDef.id,
      field,
      value,
      source,
      rung: resolved.rung,
      locator: describeLocator(resolved.locator),
    };
    fills.push(record);
    audit({ action: "fill", ...record });
  };

  const doStep = async (pageDef: PageDef, step: Step) => {
    switch (step.action) {
      case "navigate": {
        const url = step.url!.startsWith("{{")
          ? resolveTemplate(step.url!, profile, opts.inputs).value
          : step.url!;
        await page.goto(url);
        checkOrigin();
        await checkTripwires();
        audit({ action: "navigate", url, page: pageDef.id });
        break;
      }
      case "fill":
      case "select": {
        const { value, source } = resolveTemplate(step.value!, profile, opts.inputs);
        await fillOne(pageDef, source, value, source, step.action === "select" ? "select" : "text", undefined, step.target!);
        break;
      }
      case "fill_fields": {
        for (const key of step.fields!) {
          const def = config.fields?.[key];
          if (!def) throw new BlockedError(`Config references undeclared field \`${key}\``);
          if (def.kind === "file") {
            const file = expandHome(resolveKey(profile, key));
            if (!fs.existsSync(file)) throw new BlockedError(`Document not found: ${file}`);
            const resolved = await resolve(def.locator, `fields.${key}`, `file upload input for "${key}"`);
            await resolved.loc.setInputFiles(file);
            audit({ action: "upload", field: key, file, page: pageDef.id, rung: resolved.rung });
          } else {
            const value = resolveKey(profile, key);
            await fillOne(pageDef, key, value, `profile.${key}`, def.kind, def.max_chars, def.locator);
          }
        }
        break;
      }
      case "click": {
        const resolved = await resolve(step.target!, `step.${step.id ?? "click"}`, `click ${describeLocator(step.target!.primary)}`);
        await resolved.loc.click();
        audit({ action: "click", locator: describeLocator(resolved.locator), page: pageDef.id });
        break;
      }
      case "press":
        await (step.target ? (await engine.resolve(step.target)).loc : page.locator("body")).press(step.key!);
        break;
      case "upload": {
        const { value: file } = resolveTemplate(step.file!, profile, opts.inputs);
        const expanded = expandHome(file);
        if (!fs.existsSync(expanded)) throw new BlockedError(`Document not found: ${expanded}`);
        const resolved = await resolve(step.target!, `step.${step.id ?? "upload"}`, "file upload input");
        await resolved.loc.setInputFiles(expanded);
        audit({ action: "upload", file: expanded, page: pageDef.id });
        break;
      }
      case "wait":
        if (step.for!.url_contains) {
          await page.waitForURL((u) => u.href.includes(step.for!.url_contains!));
        }
        if (step.for!.locator) {
          await engine.resolve({ primary: step.for!.locator });
        }
        break;
    }
  };

  const reviewTable = () => {
    const rows = fills.map((f) => {
      const shown = f.value.length > 60 ? f.value.slice(0, 57) + "..." : f.value;
      return `  ${f.field.padEnd(28)} ${shown}  (${f.source}${f.rung > 0 ? `, fallback locator` : ""})`;
    });
    return rows.length ? rows.join("\n") : "  (nothing filled)";
  };

  const finish = async (status: RunResult["status"], reason?: string): Promise<RunResult> => {
    if (patches.length) {
      fs.writeFileSync(
        path.join(runDir, "proposed-patch.json"),
        JSON.stringify({ site: config.site.id, patches }, null, 2),
      );
    }
    fs.writeFileSync(
      path.join(runDir, "summary.json"),
      JSON.stringify({ status, site: config.site.id, flow: opts.flow, reason, fills, patches, rungsUsed }, null, 2),
    );
    audit({ action: "finish", status, reason });
    await engine.close();
    return { status, fills, runDir, reason, patches, rungsUsed };
  };

  try {
    for (let pi = 0; pi < flow.pages.length; pi++) {
      const pageDef = flow.pages[pi];
      for (const step of pageDef.steps ?? []) await doStep(pageDef, step);
      await page
        .screenshot({ path: path.join(runDir, `page-${pi}-${pageDef.id}.png`), fullPage: true })
        .catch(() => {});

      if (!pageDef.advance) continue;
      const isSubmit = pageDef.advance.submit === true;

      if (isSubmit) {
        // The review gate. Always. Every mode. No flag disables it.
        console.log(`\nReview — everything below will be submitted to ${config.site.id}:`);
        console.log(reviewTable());
        console.log(`Screenshots and audit log: ${runDir}`);
        if (opts.dryRun) return await finish("dry-run", "stopped before submit (--dry-run)");
        const answer = await ask(`Type "submit" to submit, anything else to abort: `, opts.confirm);
        if (answer !== "submit") return await finish("aborted", "user declined at review gate");
      } else if (opts.mode === "step") {
        const next = flow.pages[pi + 1]?.id ?? "next page";
        const answer = await ask(`Page "${pageDef.id}" done. Continue to "${next}"? [Y/n] `, opts.confirm);
        if (answer.toLowerCase() === "n") return await finish("aborted", `stopped after page ${pageDef.id}`);
      }

      const resolved = await resolve(
        pageDef.advance.target,
        `flows.${opts.flow}.${pageDef.id}.advance`,
        isSubmit ? "the submit button of this application" : "the button that advances to the next page",
      );
      await resolved.loc.click();
      audit({ action: isSubmit ? "submit" : "advance", page: pageDef.id, rung: resolved.rung });
      if (pageDef.advance.wait_for?.url_contains) {
        await page.waitForURL((u) => u.href.includes(pageDef.advance!.wait_for!.url_contains!));
      }
      checkOrigin();
      if (!isSubmit) await checkTripwires();
      if (isSubmit) {
        // Proof of submission: the confirmation state, captured before it can vanish.
        await page.waitForLoadState("networkidle").catch(() => {});
        await page
          .screenshot({ path: path.join(runDir, "confirmation.png"), fullPage: true })
          .catch(() => {});
        fs.writeFileSync(path.join(runDir, "confirmation.url.txt"), page.url());
        return await finish("submitted");
      }
    }
    return await finish("dry-run", "flow ended without a submit advance");
  } catch (err) {
    if (err instanceof BlockedError || err instanceof StepError) {
      await page.screenshot({ path: path.join(runDir, "blocked.png"), fullPage: true }).catch(() => {});
      return await finish("blocked", err.message);
    }
    await engine.close().catch(() => {});
    throw err;
  }
}
