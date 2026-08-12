import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { lintConfig } from "../src/lint.js";
import { runFlow } from "../src/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (...p: string[]) => path.join(here, "fixtures", ...p);
const configData = parse(fs.readFileSync(fixture("testsite", "apply.yaml"), "utf8"));

test("fixture config passes lint", () => {
  const { config, issues } = lintConfig(configData);
  assert.ok(config, JSON.stringify(issues, null, 2));
  assert.deepEqual(issues.filter((i) => i.level === "error"), []);
});

test("lint rejects literal values and PII in configs", () => {
  const bad = structuredClone(configData);
  bad.flows.apply.pages[0].steps.push({
    action: "fill",
    target: { primary: { label: "Email" } },
    value: "ada@example.org", // literal PII, must be rejected twice over
  });
  const { issues } = lintConfig(bad);
  assert.ok(issues.some((i) => i.message.includes("never a literal")));
  assert.ok(issues.some((i) => i.message.includes("email address")));
});

test("dry run fills the form, uses the fallback rung for GPA, never submits", async () => {
  const { config } = lintConfig(configData);
  assert.ok(config);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scholar-test-"));
  const result = await runFlow(config, {
    flow: "apply",
    mode: "auto",
    dryRun: true,
    headless: true,
    profilePath: fixture("profile.yaml"),
    browserProfileDir: path.join(tmp, "browser"),
    runDir: path.join(tmp, "run"),
    inputs: { form_url: pathToFileURL(fixture("testsite", "form.html")).href },
  });

  assert.equal(result.status, "dry-run", result.reason);
  const byField = Object.fromEntries(result.fills.map((f) => [f.field, f]));
  assert.equal(byField["applicant.given_name"].value, "Ada");
  assert.equal(byField["applicant.given_name"].rung, 0);
  assert.equal(byField["edu.gpa"].value, "3.85");
  assert.equal(byField["edu.gpa"].rung, 1, "GPA must resolve via CSS fallback");
  assert.equal(byField["essay.why"].source, "profile.essay.why");

  // artifacts exist: audit log + screenshot
  const audit = fs.readFileSync(path.join(tmp, "run", "audit.jsonl"), "utf8").trim().split("\n");
  assert.ok(audit.length >= 5);
  assert.ok(fs.existsSync(path.join(tmp, "run", "page-0-main.png")));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("missing profile key blocks instead of guessing", async () => {
  const { config } = lintConfig(configData);
  assert.ok(config);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scholar-test-"));
  const gapProfile = path.join(tmp, "profile.yaml");
  fs.writeFileSync(gapProfile, "applicant:\n  given_name: Ada\n"); // no email/gpa/essay
  const result = await runFlow(config, {
    flow: "apply",
    mode: "auto",
    dryRun: true,
    headless: true,
    profilePath: gapProfile,
    browserProfileDir: path.join(tmp, "browser"),
    runDir: path.join(tmp, "run"),
    inputs: { form_url: pathToFileURL(fixture("testsite", "form.html")).href },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /applicant\.email/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
