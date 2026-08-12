---
name: dev-local
description: >-
  Start ScholarAssist's local dev stack. Use when asked to "start the dev
  stack", "run the site locally", "serve the config browser", "preview the
  fixture form", or to get an http:// URL for a headed manual run.
---

# dev-local

One command: `scripts/dev-local.sh up`. It builds `site/index.html` from
`configs/` and serves the repo root in a tmux window. This repo is a CLI — the
static server is the entire stack; there is no DB, cache, or other infra.

| Service | Command (inside tmux) | Port |
|---|---|---|
| site | `node scripts/build-site.mjs && python3 -m http.server 8410` | 127.0.0.1:8410 |

URLs after `up`:
- Config browser: http://127.0.0.1:8410/site/
- Fixture form: http://127.0.0.1:8410/test/fixtures/testsite/form.html
  (usable as `--input form_url=...` for a headed `scholar run`)

Prerequisites: tmux, pnpm, python3. First run: `scripts/dev-local.sh setup`
(pnpm install + Playwright chromium).

Subcommands: `up` (idempotent) · `down` · `status` · `logs site` ·
`restart site` (also rebuilds site/) · `attach` · `setup`.

Troubleshooting:
- Port 8410 in use → something else holds it; `lsof -i :8410`, then `down` and retry.
- `status` shows the window but the port stays `·` → `logs site`; usually the
  site build failed (broken config YAML — run `pnpm dev lint <file>`).
- Edited configs but the browser shows old data → `restart site`.
