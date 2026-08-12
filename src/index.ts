#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { chromium } from "playwright";
import { parse } from "yaml";
import { lintConfig } from "./lint.js";
import { BlockedError, PROFILE_PATH, initProfile, loadProfile, resolveKey, setProfileKey } from "./profile.js";
import { runFlow, type Mode } from "./run.js";
import { recordConfig } from "./record.js";
import { importRecording } from "./importrec.js";
import { promotePatches } from "./promote.js";
import { claudeAvailable } from "./repair.js";
import { CORE_GUIDE } from "./skills.js";
import { Engine } from "./engine.js";
import { DOCS_DIR, SIZE_WARN_MB, addDoc, listDocs } from "./docs.js";
import { extractCandidates, fetchPageText, llmCandidates, type Candidate } from "./importweb.js";
import { TRACK_PATH, addApp, formatList, loadApps, parseDeadlineInput, saveApps, setState, timeLeft, type AppState } from "./track.js";
import type { SiteConfig } from "./schema.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG_DIRS = [
  path.join(process.cwd(), "configs"),
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "scholar", "configs"),
];

// One interactive question on the CLI's own stdin (commands only — runFlow
// has its own `ask` with the test hook).
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

// All valid configs across CONFIG_DIRS, deduped by site id (the same repo can
// be reachable via cwd AND a ~/.config symlink — count it once).
function allConfigs(): { config: SiteConfig; file: string }[] {
  const byId = new Map<string, { config: SiteConfig; file: string }>();
  for (const dir of CONFIG_DIRS) {
    for (const file of walkYaml(dir)) {
      try {
        const config = loadConfigFile(file);
        if (!byId.has(config.site.id)) byId.set(config.site.id, { config, file });
      } catch {
        // configs list reports invalid files; skip here
      }
    }
  }
  return [...byId.values()];
}

function* walkYaml(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkYaml(full);
    else if (/\.ya?ml$/.test(entry.name)) yield full;
  }
}

function loadConfigFile(file: string): SiteConfig {
  const { config, issues } = lintConfig(parse(fs.readFileSync(file, "utf8")));
  const errors = issues.filter((i) => i.level === "error");
  if (!config || errors.length) {
    for (const i of errors) console.error(`  ${i.path}: ${i.message}`);
    throw new BlockedError(`Config failed lint: ${file}`);
  }
  return config;
}

function findConfig(ref: string): { file: string; config: SiteConfig } {
  if (fs.existsSync(ref) && fs.statSync(ref).isFile()) {
    return { file: ref, config: loadConfigFile(ref) };
  }
  for (const dir of CONFIG_DIRS) {
    for (const file of walkYaml(dir)) {
      try {
        const config = loadConfigFile(file);
        if (config.site.id === ref) return { file, config };
      } catch {
        // skip broken configs when searching by id
      }
    }
  }
  throw new BlockedError(`No config found for \`${ref}\` (looked in ${CONFIG_DIRS.join(", ")})`);
}

const parseInputs = (pairs: string[]) =>
  Object.fromEntries(
    pairs.map((pair) => {
      const eq = pair.indexOf("=");
      return [pair.slice(0, eq), pair.slice(eq + 1)];
    }),
  );

const program = new Command("scholar").description(
  "Config-driven scholarship application assistant. Fills, you review, you submit.",
);

program
  .command("lint")
  .argument("<files...>", "config files to lint")
  .description("Validate configs: schema, purity (no user data), PII tripwires")
  .action((files: string[]) => {
    let failed = false;
    for (const file of files) {
      const { issues } = lintConfig(parse(fs.readFileSync(file, "utf8")));
      if (!issues.length) {
        console.log(`ok  ${file}`);
        continue;
      }
      for (const i of issues)
        console.log(`${i.level === "error" ? "ERR " : "warn"} ${file} ${i.path}: ${i.message}`);
      if (issues.some((i) => i.level === "error")) failed = true;
    }
    process.exitCode = failed ? 1 : 0;
  });

program
  .command("run")
  .argument("[config]", "config file path or site id (omit to pick from a list)")
  .requiredOption("--flow <name>", "flow to run", "apply")
  .option("--mode <mode>", "step (confirm each page) or auto (confirm only submit)", "step")
  .option("--dry-run", "fill everything, stop before submit", false)
  .option("--profile <path>", "profile file", PROFILE_PATH)
  .option("--input <k=v...>", "flow inputs", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--no-repair", "disable LLM locator repair (rung 2)")
  .option("--headless", "headless browser (tests only; challenges need a visible browser)", false)
  .description("Run a flow. The final submit ALWAYS asks for your confirmation, in every mode.")
  .action(async (ref: string | undefined, o) => {
    if (!ref) {
      // No argument: numbered picker with deadline context from the tracker.
      if (!stdin.isTTY) throw new BlockedError("No config given. Usage: scholar run <site-id or file>");
      const entries = allConfigs();
      if (!entries.length) throw new BlockedError(`No configs found in ${CONFIG_DIRS.join(", ")}`);
      const apps = loadApps();
      entries.forEach(({ config }, i) => {
        const app = apps.find((a) => a.site === config.site.id && a.deadline && a.state !== "submitted");
        const dl = app?.deadline ? `  deadline in ${timeLeft(app.deadline).human}` : "";
        console.log(`  ${String(i + 1).padStart(2)}. ${config.site.id.padEnd(22)} flows: ${Object.keys(config.flows).join(",")}${dl}`);
      });
      const picked = Number(await ask(`Run which? [1-${entries.length}] `));
      if (!Number.isInteger(picked) || picked < 1 || picked > entries.length) {
        throw new BlockedError("No valid selection — nothing run.");
      }
      ref = entries[picked - 1].config.site.id;
    }
    const { config, file } = findConfig(ref);
    const repair = o.repair && (await claudeAvailable());
    if (o.repair && !repair) console.log("note: `claude` CLI not found; locator repair disabled");
    const result = await runFlow(config, {
      flow: o.flow,
      mode: o.mode as Mode,
      dryRun: o.dryRun,
      headless: o.headless,
      profilePath: o.profile,
      repair,
      inputs: parseInputs(o.input),
    });
    console.log(`\n${result.status}${result.reason ? `: ${result.reason}` : ""}`);
    console.log(`Run artifacts: ${result.runDir}`);
    if (result.patches.length) {
      console.log(
        `${result.patches.length} locator repair(s) proposed. Review, then:\n` +
          `  scholar config promote ${result.runDir} --config ${file}`,
      );
    }
    if (result.status === "submitted") {
      const apps = loadApps();
      const app = addApp(
        apps,
        { site: config.site.id, award: `${config.site.name ?? config.site.id} (${o.flow})` },
        true,
      );
      setState(apps, app.id, "submitted");
      app.run_dir = result.runDir;
      saveApps(apps);
      console.log(`Tracked as submitted (id ${app.id}). See: scholar track list`);
    }
    if (result.status === "blocked") process.exitCode = 2;
    if (result.status === "aborted") process.exitCode = 3;
  });

// --- onboarding & health ---
const doctorChecks = async () => {
  const chromiumPath = chromium.executablePath();
  return {
    node: Number(process.versions.node.split(".")[0]) >= 20,
    chromium: fs.existsSync(chromiumPath),
    profile: fs.existsSync(PROFILE_PATH),
    configs: allConfigs().length,
    claude: await claudeAvailable(),
    display: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
  };
};

const installChromium = (): boolean => {
  // playwright doesn't export cli.js through its exports map; find it on disk
  // next to the resolved module.
  const pwDir = path.dirname(createRequire(import.meta.url).resolve("playwright"));
  const r = spawnSync(process.execPath, [path.join(pwDir, "cli.js"), "install", "chromium"], {
    stdio: "inherit",
  });
  return r.status === 0;
};

program
  .command("doctor")
  .description("Check everything scholar needs and say how to fix what's missing")
  .action(async () => {
    const c = await doctorChecks();
    const row = (ok: boolean, label: string, fix: string) =>
      console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  → ${fix}`}`);
    row(c.node, `node ${process.versions.node}`, "install Node 20+");
    row(c.chromium, "chromium (Playwright)", "scholar start installs it, or: npx playwright install chromium");
    row(c.profile, `profile (${PROFILE_PATH})`, "scholar start");
    row(c.configs > 0, `site configs (${c.configs} found)`, `put configs in ${CONFIG_DIRS[1]}`);
    row(c.claude, "claude CLI (locator repair)", "optional — runs still work, drift won't self-heal");
    row(c.display, "display (headed browser)", "run from a graphical session");
    process.exitCode = c.node && c.chromium && c.configs > 0 ? 0 : 1;
  });

program
  .command("start")
  .description("Guided first run: install the browser, set up your profile, watch a demo fill")
  .action(async () => {
    // 1. Browser
    if (!fs.existsSync(chromium.executablePath())) {
      console.log("Installing the Playwright Chromium browser (one time)...");
      if (!installChromium()) {
        throw new BlockedError("Browser install failed. Run manually: npx playwright install chromium");
      }
    }
    // 2. Profile + the universal keys, interviewed inline. Site-specific keys
    //    are asked lazily by each run's pre-flight, so this stays short.
    if (initProfile()) console.log(`Created ${PROFILE_PATH}`);
    const profile = loadProfile();
    const universal = ["applicant.given_name", "applicant.family_name", "applicant.email", "applicant.country"];
    const empty = universal.filter((k) => {
      try {
        return !resolveKey(profile, k).trim();
      } catch {
        return true;
      }
    });
    if (empty.length && stdin.isTTY) {
      console.log("\nA few basics every application asks for (saved locally, empty to skip):");
      for (const key of empty) {
        const v = await ask(`  ${key}: `);
        if (v) setProfileKey(key, v);
      }
    }
    // 3. Demo against the bundled fixture form — fictional data, zero stakes.
    const demoConfig = path.join(ROOT, "test", "fixtures", "testsite", "apply.yaml");
    const demoProfile = path.join(ROOT, "test", "fixtures", "profile.yaml");
    const demoForm = path.join(ROOT, "test", "fixtures", "testsite", "form.html");
    if (fs.existsSync(demoConfig) && stdin.isTTY) {
      const go = await ask("\nWatch a demo fill in a real browser (fictional data, nothing submitted)? [Y/n] ");
      if (go.toLowerCase() !== "n") {
        const result = await runFlow(loadConfigFile(demoConfig), {
          flow: "apply",
          mode: "auto",
          dryRun: true,
          profilePath: demoProfile,
          inputs: { form_url: `file://${demoForm}` },
        });
        console.log(`\nDemo ${result.status} — that review table is the gate every real run stops at.`);
      }
    }
    console.log(
      [
        "\nYou're set. Next:",
        "  scholar docs add ~/path/to/cv.pdf --as cv     # register documents once",
        "  scholar profile import <your-portfolio-url>   # pull basics from your site",
        "  scholar run                                   # pick a scholarship and go",
      ].join("\n"),
    );
  });

// --- documents ---
const docsCmd = program.command("docs").description(`Reusable application documents (${DOCS_DIR})`);
docsCmd
  .command("add")
  .argument("<file>", "document to register (pdf etc.)")
  .option("--as <name>", "canonical name, e.g. cv, transcript, passport")
  .description("Copy a document into the docs folder and bind it to a profile key")
  .action((file: string, o) => {
    const doc = addDoc(file, o.as);
    console.log(`${doc.key} -> ${doc.file} (${doc.sizeMB.toFixed(1)} MB)`);
    if (doc.sizeMB > SIZE_WARN_MB) {
      console.log(`warn: over ${SIZE_WARN_MB} MB — many portals cap uploads below this`);
    }
  });
docsCmd
  .command("list")
  .description("List registered documents and whether their files still exist")
  .action(() => {
    const docs = listDocs();
    if (!docs.length) return console.log("(none — scholar docs add <file> --as cv)");
    for (const d of docs) {
      console.log(`  ${d.exists ? "✓" : "✗ MISSING"} ${d.key.padEnd(28)} ${d.file}${d.exists ? ` (${d.sizeMB.toFixed(1)} MB)` : ""}`);
    }
  });

// --- config subcommands ---
const configCmd = program.command("config").description("Create, verify, and improve site configs");

configCmd
  .command("record")
  .argument("<url>", "application page to record")
  .option("--out <dir>", "output directory", path.join(process.cwd(), "configs"))
  .description("Record yourself applying by hand; drafts a config. Typed values are never captured.")
  .action(async (url: string, o) => {
    const file = await recordConfig(url, o.out);
    console.log(`\nDraft written: ${file}`);
    console.log(`Next: edit todo.* keys, then scholar lint ${file} && scholar config verify ${file}`);
  });

configCmd
  .command("import-recording")
  .argument("<json>", "Chrome DevTools Recorder JSON export")
  .option("--out <dir>", "output directory", path.join(process.cwd(), "configs"))
  .description("Convert a Chrome DevTools Recorder export into a draft config (values discarded)")
  .action((jsonFile: string, o) => {
    const { yaml, warnings } = importRecording(fs.readFileSync(jsonFile, "utf8"));
    for (const w of warnings) console.log(`warn: ${w}`);
    fs.mkdirSync(o.out, { recursive: true });
    const outFile = path.join(o.out, path.basename(jsonFile).replace(/\.json$/, "") + ".yaml");
    fs.writeFileSync(outFile, yaml);
    console.log(`Draft written: ${outFile}`);
  });

configCmd
  .command("verify")
  .argument("<config>", "config file path or site id")
  .option("--flow <name>", "flow to verify", "apply")
  .option("--profile <path>", "profile file", PROFILE_PATH)
  .option("--input <k=v...>", "flow inputs", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--headless", "headless browser", false)
  .description("Dry-run the flow and report which rung each locator needed (drift check)")
  .action(async (ref: string, o) => {
    const { config } = findConfig(ref);
    const result = await runFlow(config, {
      flow: o.flow,
      mode: "auto",
      dryRun: true,
      headless: o.headless,
      profilePath: o.profile,
      repair: false,
      inputs: parseInputs(o.input),
    });
    const counts = [0, 0, 0];
    for (const r of result.rungsUsed) counts[r] = (counts[r] ?? 0) + 1;
    console.log(`\n${result.status}${result.reason ? `: ${result.reason}` : ""}`);
    console.log(`rungs: primary=${counts[0]} fallback=${counts[1]}`);
    if (counts[1] > 0) console.log("Fallbacks in use — the primary locators have drifted; consider updating them.");
    process.exitCode = result.status === "blocked" ? 1 : 0;
  });

configCmd
  .command("promote")
  .argument("<runDir>", "run directory containing proposed-patch.json")
  .requiredOption("--config <file>", "config file to update")
  .description("Append a run's verified repair proposals as fallback locators")
  .action((runDir: string, o) => {
    const { applied, skipped } = promotePatches(runDir, o.config);
    console.log(`applied ${applied} fallback(s)${skipped.length ? `, skipped: ${skipped.join("; ")}` : ""}`);
    if (applied) console.log(`Next: scholar config verify ${o.config}`);
  });

// --- profile ---
const profileCmd = program.command("profile").description("Manage your local profile");
profileCmd
  .command("init")
  .description(`Create a profile template at ${PROFILE_PATH}`)
  .action(() => {
    console.log(initProfile() ? `Created ${PROFILE_PATH} — fill it in.` : `Already exists: ${PROFILE_PATH}`);
  });
profileCmd.command("path").action(() => console.log(PROFILE_PATH));
profileCmd
  .command("import")
  .argument("<url>", "your portfolio/CV page")
  .description("Propose profile values found on your own website; you confirm each before it saves")
  .action(async (url: string) => {
    if (!stdin.isTTY) throw new BlockedError("profile import is interactive — run it in a terminal.");
    initProfile();
    console.log(`Reading ${url} ...`);
    const text = await fetchPageText(url);
    const candidates: Candidate[] = extractCandidates(text, url);
    if (await claudeAvailable()) {
      console.log("Asking claude to extract more (page text only — your profile is never sent)...");
      for (const c of await llmCandidates(text)) {
        if (!candidates.some((x) => x.key === c.key)) candidates.push(c);
      }
    }
    if (!candidates.length) return console.log("Nothing extractable found on that page.");
    const profile = loadProfile();
    let saved = 0;
    for (const c of candidates) {
      let current: string | undefined;
      try {
        current = resolveKey(profile, c.key);
      } catch {
        current = undefined;
      }
      if (current?.trim()) continue; // never overwrite what the user already set
      const answer = (
        await ask(`  ${c.key} = "${c.value}"  (${c.evidence})  save? [y/N/e=edit] `)
      ).toLowerCase();
      let value = c.value;
      if (answer === "e") value = await ask(`    ${c.key}: `);
      else if (answer !== "y") continue;
      if (!value) continue;
      setProfileKey(c.key, value);
      saved++;
    }
    console.log(`Saved ${saved} value(s) to ${PROFILE_PATH}. Review with: scholar profile show`);
  });
profileCmd
  .command("show")
  .description("List profile keys (values truncated)")
  .action(() => {
    const flat: string[] = [];
    const walk = (obj: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === "object") walk(v as Record<string, unknown>, `${prefix}${k}.`);
        else {
          const s = String(v ?? "");
          flat.push(`${prefix}${k} = ${s.length > 40 ? s.slice(0, 37) + "..." : s}`);
        }
      }
    };
    walk(loadProfile(), "");
    console.log(flat.join("\n") || "(empty)");
  });

// --- tracker ---
const trackCmd = program.command("track").description(`Application tracker (${TRACK_PATH})`);
trackCmd
  .command("add")
  .argument("<site>", "site id or name")
  .requiredOption("--award <name>", "scholarship/award name")
  .option("--cycle <cycle>", "cycle for recurring awards, e.g. 2026-09")
  .option("--deadline <when>", 'deadline WITH timezone, e.g. "6 Oct 2026 11:00 UTC" or an ISO instant')
  .option("--tz <zone>", "deadline timezone as the sponsor states it, e.g. 'Pacific Time'")
  .option("--notes <text>")
  .option("--force", "add despite a duplicate warning", false)
  .action((site: string, o) => {
    const deadline = o.deadline ? parseDeadlineInput(o.deadline) : undefined;
    if (deadline && deadline !== o.deadline) {
      console.log(`deadline understood as ${deadline} (${timeLeft(deadline).human} from now)`);
    }
    const apps = loadApps();
    const app = addApp(
      apps,
      { site, award: o.award, cycle: o.cycle, deadline, deadline_tz: o.tz, notes: o.notes },
      o.force,
    );
    saveApps(apps);
    console.log(`tracked ${app.id}: ${site}: ${o.award}`);
  });
trackCmd.command("list").action(() => console.log(formatList(loadApps())));
trackCmd
  .command("set")
  .argument("<id>")
  .argument("<state>")
  .option("--notes <text>")
  .action((id: string, state: string, o) => {
    const apps = loadApps();
    const app = setState(apps, id, state as AppState, o.notes);
    saveApps(apps);
    console.log(`${app.id} -> ${app.state}`);
  });

// --- misc ---
program
  .command("snapshot")
  .argument("<url>")
  .option("--container <css>", "snapshot only this container")
  .option("--headless", "", false)
  .description("Write an accessibility snapshot of a page to disk; prints the path")
  .action(async (url: string, o) => {
    const engine = await Engine.launch({ headless: o.headless });
    await engine.page.goto(url);
    const snap = await engine.page.locator(o.container ?? "body").ariaSnapshot();
    const dir = path.join(os.homedir(), ".local", "state", "scholar", "snapshots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}.yaml`);
    fs.writeFileSync(file, snap);
    await engine.close();
    console.log(file);
  });

program
  .command("explain")
  .argument("<runDir>", "run directory")
  .description("Compact summary of a run: status, fills, rungs, failures")
  .action((runDir: string) => {
    const summary = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"));
    console.log(`${summary.site} ${summary.flow}: ${summary.status}${summary.reason ? ` (${summary.reason})` : ""}`);
    for (const f of summary.fills ?? []) {
      console.log(`  ${String(f.field).padEnd(28)} rung ${f.rung}  ${f.locator}`);
    }
    for (const p of summary.patches ?? []) {
      console.log(`  patch ${p.where}: +${JSON.stringify(p.add_fallback)}`);
    }
  });

program
  .command("skills")
  .command("get")
  .argument("<name>", "guide name (core)")
  .description("Print the version-matched agent guide")
  .action((name: string) => {
    if (name !== "core") throw new BlockedError(`Unknown guide \`${name}\`. Available: core`);
    console.log(CORE_GUIDE);
  });

const configsCmd = program.command("configs");
configsCmd
  .command("list")
  .description("List available site configs")
  .action(() => {
    for (const { config, file } of allConfigs()) {
      console.log(
        `${config.site.id.padEnd(20)} flows: ${Object.keys(config.flows).join(",")}  ${file}`,
      );
    }
  });

program.parseAsync().catch((err: unknown) => {
  if (err instanceof BlockedError) {
    console.error(`blocked: ${err.message}`);
    process.exit(2);
  }
  throw err;
});
