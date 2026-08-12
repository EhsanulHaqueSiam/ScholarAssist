// UX machinery: pre-flight interview (lazy profile building), human deadline
// parsing, the docs folder, and portfolio-import candidate extraction.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { addDoc, listDocs } from "../src/docs.js";
import { extractCandidates } from "../src/importweb.js";
import { lintConfig } from "../src/lint.js";
import { loadProfile, resolveKey } from "../src/profile.js";
import { runFlow } from "../src/run.js";
import { parseDeadlineInput } from "../src/track.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (...p: string[]) => path.join(here, "fixtures", ...p);
const { config } = lintConfig(parse(fs.readFileSync(fixture("testsite", "apply.yaml"), "utf8")));
assert.ok(config);

test("pre-flight interviews missing keys, saves them, and the run proceeds", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scholar-ux-"));
  const profilePath = path.join(tmp, "profile.yaml");
  fs.writeFileSync(profilePath, "applicant:\n  given_name: Ada\n");

  const answers: Record<string, string> = {
    "applicant.email": "ada@example.org",
    "edu.gpa": "3.85",
    "essay.why": "Because I build things.",
  };
  const result = await runFlow(config, {
    flow: "apply",
    mode: "auto",
    dryRun: true,
    headless: true,
    profilePath,
    browserProfileDir: path.join(tmp, "browser"),
    runDir: path.join(tmp, "run"),
    inputs: { form_url: pathToFileURL(fixture("testsite", "form.html")).href },
    confirm: async (q) => {
      const key = Object.keys(answers).find((k) => q.includes(k));
      assert.ok(key, `unexpected prompt: ${q}`);
      return answers[key];
    },
  });

  assert.equal(result.status, "dry-run", result.reason);
  // interviewed values were persisted to the profile, not just used once
  const saved = loadProfile(profilePath);
  for (const [key, value] of Object.entries(answers)) {
    assert.equal(resolveKey(saved, key), value);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("pre-flight without a prompt blocks once, listing every missing key", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scholar-ux-"));
  const profilePath = path.join(tmp, "profile.yaml");
  fs.writeFileSync(profilePath, "applicant:\n  given_name: Ada\n");
  const result = await runFlow(config, {
    flow: "apply",
    mode: "auto",
    dryRun: true,
    headless: true,
    profilePath,
    browserProfileDir: path.join(tmp, "browser"),
    runDir: path.join(tmp, "run"),
    inputs: { form_url: pathToFileURL(fixture("testsite", "form.html")).href },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /applicant\.email/);
  assert.match(result.reason ?? "", /essay\.why/); // all at once, not one per run
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("deadline input: human formats with a zone parse, naive input refuses", () => {
  assert.equal(parseDeadlineInput("6 Oct 2026 11:00 UTC"), "2026-10-06T11:00:00.000Z");
  assert.equal(parseDeadlineInput("2026-10-07T23:59:00-07:00"), "2026-10-08T06:59:00.000Z");
  assert.throws(() => parseDeadlineInput("6 Oct 2026 11:00"), /no explicit timezone/);
  assert.throws(() => parseDeadlineInput("sometime in October UTC"), /Could not parse/);
});

test("docs add copies the file and binds a documents.* profile key", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scholar-ux-"));
  const profilePath = path.join(tmp, "profile.yaml");
  fs.writeFileSync(profilePath, "applicant: {}\n");
  const src = path.join(tmp, "My Résumé (2026).pdf");
  fs.writeFileSync(src, "%PDF-1.4 fake");

  const doc = addDoc(src, "cv", { docsDir: path.join(tmp, "docs"), profilePath });
  assert.equal(doc.key, "documents.cv");
  assert.ok(fs.existsSync(doc.file));
  assert.equal(resolveKey(loadProfile(profilePath), "documents.cv"), doc.file);
  assert.deepEqual(listDocs(profilePath).map((d) => [d.key, d.exists]), [["documents.cv", true]]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("portfolio import: regex candidates from page text, nothing invented", () => {
  const text =
    "Hi, I'm Ada. Reach me at ada@example.org or github.com/example — " +
    "profile: https://github.com/adalovelace and https://www.linkedin.com/in/adalovelace";
  const got = extractCandidates(text, "https://ada.dev");
  const byKey = Object.fromEntries(got.map((c) => [c.key, c.value]));
  assert.equal(byKey["applicant.email"], "ada@example.org");
  assert.equal(byKey["links.github"], "https://github.com/adalovelace");
  assert.equal(byKey["links.linkedin"], "https://www.linkedin.com/in/adalovelace");
  assert.equal(byKey["links.website"], "https://ada.dev");
  assert.ok(!got.some((c) => c.key.includes("gpa")), "no invented keys");
});
