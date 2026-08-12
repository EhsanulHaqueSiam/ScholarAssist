// Served by `scholar skills get core`. The SKILL.md on disk is a thin stub;
// this guide ships inside the binary so instructions can never drift from
// the commands that will actually run.
export const CORE_GUIDE = `# scholar — agent guide

Config-driven scholarship application assistant. It fills, the human reviews,
the human submits. You (the agent) orchestrate; the CLI does the browser work
deterministically and writes artifacts to disk — read paths, not pages.

## Cost-ordered decision hierarchy (cheapest first)

1. scholar configs list                 — what sites are covered (no browser)
2. scholar lint <file>                  — validate a config (no browser)
3. scholar run <site> --flow apply --dry-run --mode auto
                                        — fill everything, stop before submit;
                                          summary.json + screenshots in run dir
4. scholar run <site> --flow apply      — real run; the human confirms pages
                                          and MUST type "submit" at the gate
5. scholar config verify <site>         — dry-run + rung report (drift check)
6. scholar snapshot <url>               — a11y snapshot to disk when you need
                                          to see a page; read the file, don't
                                          screenshot
7. scholar config record <url>          — human records a new site by hand
8. scholar config import-recording <f>  — convert Chrome DevTools Recorder JSON

Repair: runs use --repair by default; broken locators are fixed via the
claude CLI, verified, and written to <runDir>/proposed-patch.json. Promote
with: scholar config promote <runDir> --config <file>, then verify.

## Non-negotiable safety rules

- NEVER attempt to bypass a CAPTCHA, bot check, or 2FA. The browser is headed;
  tell the human to solve it and re-run or resume.
- NEVER put profile values into your own context or into prompts. The CLI
  resolves {{ profile.* }} templates locally; you handle field NAMES only.
- NEVER generate essay or answer prose. Missing profile keys block the run:
  relay the block message to the human, do not invent a value.
- The submit review gate is the human's. Do not answer it, script it, pipe
  input to it, or advise bypassing it.
- One human, one account, one submission per opportunity. Duplicate warnings
  from scholar track are stop signs, not obstacles.

## Reading results

Every run writes ~/.local/state/scholar/runs/<ts>/:
  summary.json   status, fills (field/value/source/rung), patches, rungsUsed
  audit.jsonl    append-only action log with value provenance
  page-*.png     per-page screenshots; blocked.png on failure
  proposed-patch.json  repair proposals awaiting promotion

status meanings: dry-run (stopped before submit), submitted, aborted (human
declined), blocked (missing data, tripwire, or unresolvable locator — read
the reason, fix the cause, re-run).

## Tracker

scholar track add <site> --award "..." [--deadline ISO-with-offset --tz "..."]
scholar track list
scholar track set <id> <state>   — planned|in_progress|blocked_on_human|
                                   ready_to_submit|submitted|won|rejected
`;
