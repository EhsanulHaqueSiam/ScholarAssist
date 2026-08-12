import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { matchField } from "../src/fieldmatch.js";
import { importRecording } from "../src/importrec.js";
import { lintConfig } from "../src/lint.js";
import { addApp, findDuplicate, setState, type Application } from "../src/track.js";
import { BlockedError } from "../src/profile.js";

test("fieldmatch: autocomplete beats synonyms, machine names are weak", () => {
  assert.deepEqual(matchField({ autocomplete: "section-a shipping given-name", label: "GPA" }), {
    key: "applicant.given_name",
    confidence: "autocomplete",
  });
  assert.deepEqual(matchField({ label: "Cumulative GPA" }), { key: "edu.gpa", confidence: "synonym" });
  assert.deepEqual(matchField({ name: "fld_email_addr" }), { key: "applicant.email", confidence: "weak" });
  assert.equal(matchField({ label: "Favourite colour" }), null);
});

test("import-recording: converts recorder JSON, discards values, output passes lint", () => {
  const recorderExport = JSON.stringify({
    title: "example flow",
    steps: [
      { type: "setViewport", width: 1280, height: 720 },
      { type: "navigate", url: "https://apply.example.org/start" },
      {
        type: "change",
        value: "SECRET VALUE MUST NOT SURVIVE",
        selectors: [["aria/Email address"], ["#email"], ["xpath///input[1]"]],
      },
      { type: "change", value: "3.9", selectors: [["#gpa"]] },
      { type: "click", selectors: [["aria/Submit application"], ["#submit"]] },
    ],
  });
  const { yaml, warnings } = importRecording(recorderExport);
  assert.ok(!yaml.includes("SECRET"), "typed values must be discarded");
  assert.ok(warnings.some((w) => w.includes("Discarded")));
  const { config, issues } = lintConfig(parse(yaml));
  assert.ok(config, JSON.stringify(issues, null, 2));
  assert.deepEqual(issues.filter((i) => i.level === "error"), []);
  assert.ok(yaml.includes("applicant.email"), "aria label should bind to profile key");
  assert.ok(config.site.match.some((m) => m.includes("example.org")));
});

test("tracker: dedupes same award+cycle, allows different cycles, blocks naive deadlines", () => {
  const apps: Application[] = [];
  addApp(apps, { site: "bold", award: "Future Leaders", cycle: "2026" });
  assert.throws(() => addApp(apps, { site: "bold", award: "future leaders!", cycle: "2026" }), BlockedError);
  addApp(apps, { site: "bold", award: "Future Leaders", cycle: "2027" }); // new cycle, fine
  assert.equal(apps.length, 2);
  assert.ok(findDuplicate(apps, { site: "bold", award: "Future Leaders Scholarship", cycle: "2026" }));
  assert.throws(
    () => addApp(apps, { site: "x", award: "Y", deadline: "2026-10-07T12:00:00" }),
    /offset/,
  );
  const app = setState(apps, apps[0].id, "blocked_on_human", "waiting on recommender");
  assert.equal(app.state, "blocked_on_human");
});
