#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { parse } from "yaml";
import { lintConfig } from "./lint.js";
import { BlockedError, PROFILE_PATH, initProfile, loadProfile } from "./profile.js";
import { runFlow, type Mode } from "./run.js";
import { recordConfig } from "./record.js";
import { importRecording } from "./importrec.js";
import { promotePatches } from "./promote.js";
import { claudeAvailable } from "./repair.js";
import { CORE_GUIDE } from "./skills.js";
import { Engine } from "./engine.js";
import { TRACK_PATH, addApp, formatList, loadApps, saveApps, setState, type AppState } from "./track.js";
import type { SiteConfig } from "./schema.js";

const CONFIG_DIRS = [
  path.join(process.cwd(), "configs"),
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "scholar", "configs"),
];

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
  .argument("<config>", "config file path or site id")
  .requiredOption("--flow <name>", "flow to run", "apply")
  .option("--mode <mode>", "step (confirm each page) or auto (confirm only submit)", "step")
  .option("--dry-run", "fill everything, stop before submit", false)
  .option("--profile <path>", "profile file", PROFILE_PATH)
  .option("--input <k=v...>", "flow inputs", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--no-repair", "disable LLM locator repair (rung 2)")
  .option("--headless", "headless browser (tests only; challenges need a visible browser)", false)
  .description("Run a flow. The final submit ALWAYS asks for your confirmation, in every mode.")
  .action(async (ref: string, o) => {
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
  .option("--deadline <iso>", "deadline as ISO instant WITH offset, e.g. 2026-10-07T12:00:00Z")
  .option("--tz <zone>", "deadline timezone as the sponsor states it, e.g. 'Pacific Time'")
  .option("--notes <text>")
  .option("--force", "add despite a duplicate warning", false)
  .action((site: string, o) => {
    const apps = loadApps();
    const app = addApp(
      apps,
      { site, award: o.award, cycle: o.cycle, deadline: o.deadline, deadline_tz: o.tz, notes: o.notes },
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
    for (const dir of CONFIG_DIRS) {
      for (const file of walkYaml(dir)) {
        try {
          const config = loadConfigFile(file);
          console.log(
            `${config.site.id.padEnd(20)} flows: ${Object.keys(config.flows).join(",")}  ${file}`,
          );
        } catch {
          console.log(`(invalid)            ${file}`);
        }
      }
    }
  });

program.parseAsync().catch((err: unknown) => {
  if (err instanceof BlockedError) {
    console.error(`blocked: ${err.message}`);
    process.exit(2);
  }
  throw err;
});
