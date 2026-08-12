# ScholarAssist — agent map

Config-driven scholarship application assistant. The CLI (`scholar`) fills portal
forms from a local profile via declarative YAML configs; a human reviews and
confirms every submission. TypeScript ESM, pnpm, Playwright, ArkType, node:test.

## Layout

```
src/
  index.ts      CLI entry (commander) — all commands wired here
  run.ts        flow runner: replay ladder (rung 0/1), review gate, artifacts
  engine.ts     Playwright wrapper (locator resolution, snapshots)
  schema.ts     ArkType config schema (the source of truth for config shape)
  lint.ts       config lint: schema + purity (no literal values) + PII tripwires
  repair.ts     rung 2: LLM locator repair via the user's own `claude` CLI
  promote.ts    apply a verified repair patch to a config file
  record.ts     `config record` — in-browser recorder (captures WHERE, never WHAT)
  importrec.ts  Chrome DevTools Recorder JSON → config (values discarded)
  fieldmatch.ts profile-key resolution ladder (autocomplete > synonyms > names)
  profile.ts    local profile load/init/setKey (~/.config/scholar/profile.yaml)
  docs.ts       documents folder: `docs add` copies + binds documents.* keys
  importweb.ts  `profile import <url>`: candidates from the user's own page,
                each confirmed by the human before saving
  track.ts      deadline tracker: tz-safe deadlines, cycle-aware dedupe
  draft.ts      essay/word-count fitting helpers
  skills.ts     `scholar skills get core` — version-matched agent guide
configs/org/<domain>/*.yaml   12 real portal configs (PII-free by construction)
test/           node:test; run.test.ts is a real headless e2e vs test/fixtures/testsite/
extension/      MV3 recorder (load unpacked)
skills/scholar/ ~40-token discovery stub; real guide served by the binary
scripts/        build-site.mjs (configs → site/index.html), record-demo.mjs
```

## Golden rules (invariants in code — never weaken, never make configurable)

1. **The review gate is absolute.** Every flow stops before submit and waits for
   the human, in every mode. No flag disables it; never add one.
2. **Values are never invented.** Every filled value traces to a profile key or a
   user-typed answer; a missing key blocks (`status: blocked`), never guesses.
3. **Configs carry zero user data.** Field entries name profile keys; literal
   values and PII are lint *errors* (`src/lint.ts`), enforced again by gitleaks CI.
4. **Never bypass CAPTCHA / 2FA / bot checks.** Challenges hand the headed
   browser to the human. No stealth, no headless authenticated flows.
5. **No SSN / banking / FSA ID fields exist in the schema.** A page requesting
   one halts with a scam warning. Do not add such fields.
6. **Deadlines require an explicit UTC offset**; duplicate site+award+cycle
   entries are refused. Both protect students from disqualification.
7. Repairs are **propose → verify → promote**, never silent config edits.

## Conventions

- No new dependencies without strong cause (current: arktype, commander,
  playwright, yaml). No `any`. Inferred types over annotations.
- Tests are node:test via tsx; the e2e drives the real runner headlessly against
  `test/fixtures/testsite/form.html` (a `file://` URL — no server, no ports).
- `test/fixtures/profile.yaml` is fictional and deliberately committed; the
  real profile lives outside the repo and must never enter it.
- Conventional commits (`feat:`, `fix(ci):`, …).

## Where to look

| Need | Place |
|---|---|
| User-facing behavior, quickstart, refusals | `README.md` |
| Research, rationale, roadmap, safety mandates in full | `PLAN.md` |
| Config format rules for contributors | `configs/CONTRIBUTING.md` |
| Agent usage guide for the CLI | `pnpm dev skills get core` |
| CI gate definition | `.github/workflows/ci.yml` |
| Local stack (site preview + fixture form over http) | `scripts/dev-local.sh up` (`/dev-local` skill) |

## Verify

`pnpm verify` = typecheck + tests + lint all configs + site build (mirrors CI).
For engine/runner changes, also prove a live fill — see `/verify` skill
(`.claude/skills/verify/SKILL.md`).
