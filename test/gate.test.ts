// E2e for the runner's safety invariants through the real path: the review
// gate on an actual (non-dry-run) submit, and the scam tripwire. Uses the
// `confirm` test hook — the only supported way to answer prompts in tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { lintConfig } from "../src/lint.js";
import { runFlow, type RunOptions } from "../src/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (...p: string[]) => path.join(here, "fixtures", ...p);
const { config } = lintConfig(parse(fs.readFileSync(fixture("testsite", "apply.yaml"), "utf8")));
assert.ok(config);

const run = (tmp: string, page: string, confirm: RunOptions["confirm"]) =>
  runFlow(config, {
    flow: "apply",
    mode: "auto",
    dryRun: false,
    headless: true,
    profilePath: fixture("profile.yaml"),
    browserProfileDir: path.join(tmp, "browser"),
    runDir: path.join(tmp, "run"),
    inputs: { form_url: pathToFileURL(fixture("testsite", page)).href },
    confirm,
  });

const auditActions = (tmp: string) =>
  fs
    .readFileSync(path.join(tmp, "run", "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).action as string);

test("review gate: typing `submit` submits and captures confirmation proof", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scholar-gate-"));
  const questions: string[] = [];
  const result = await run(tmp, "form.html", async (q) => {
    questions.push(q);
    return "submit";
  });

  assert.equal(result.status, "submitted", result.reason);
  assert.equal(questions.length, 1, "the gate must ask exactly once");
  assert.match(questions[0], /"submit"/, "the gate must demand the literal word");
  // proof-of-submission artifacts, per the P1 mandate
  assert.ok(fs.existsSync(path.join(tmp, "run", "confirmation.png")));
  assert.ok(fs.readFileSync(path.join(tmp, "run", "confirmation.url.txt"), "utf8").length > 0);
  assert.ok(auditActions(tmp).includes("submit"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("review gate: any answer but the literal `submit` aborts without submitting", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scholar-gate-"));
  const result = await run(tmp, "form.html", async () => "yes"); // an affirmative is not consent

  assert.equal(result.status, "aborted");
  assert.ok(!fs.existsSync(path.join(tmp, "run", "confirmation.png")));
  assert.ok(!auditActions(tmp).includes("submit"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("tripwire: a page asking for an SSN blocks with a scam warning before any fill", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scholar-gate-"));
  const result = await run(tmp, "scam.html", async () => {
    throw new Error("the tripwire must fire before any prompt");
  });

  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /reportfraud\.ftc\.gov/);
  assert.equal(result.fills.length, 0, "nothing may be typed into a tripwired page");
  assert.ok(fs.existsSync(path.join(tmp, "run", "blocked.png")));
  fs.rmSync(tmp, { recursive: true, force: true });
});
