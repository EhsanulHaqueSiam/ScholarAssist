# Contributing a site config

## Before you write anything

1. Check the site's terms. If it explicitly prohibits automated form filling, the config cannot be accepted; open an issue instead so the README can list the site as unsupported with the citation.
2. Check the sponsor is real: sponsor legal name, the sponsor's own domain, no application fee, no SSN/banking request. Any fee or SSN/banking request makes the config unpublishable, no exceptions.

## Authoring

The fast path is recording:

```sh
scholar config record https://apply.example.org
# or convert a Chrome DevTools Recorder export:
scholar config import-recording recording.json
```

Then clean up the draft:

- Rename every `todo.*` field to a real profile key (see the vocabulary in the repo README).
- Locator quality rubric: `role` + accessible name first, `label` second, `testid` third, `css` last and only as a ranked fallback. A config whose primaries are CSS selectors will be asked to improve them.
- Mark essay boxes `kind: freeform` with the site's `max_chars`.
- The submit button's advance must carry `submit: true` and be the last page.
- Declare `requires:` honestly (`login`, `file-upload`).

## Validate

```sh
scholar lint configs/your-site.yaml          # must pass with zero errors
scholar config verify configs/your-site.yaml # dry-run against the live site
```

CI re-runs the lint and rejects: any literal value in a fill, any PII pattern, any navigate outside the declared origins.

## Review tiers

- Plain configs (no `login`/`file-upload`): merged after one maintainer review with green CI.
- Configs declaring `login` or `file-upload`: mandatory closer human review, since they run inside authenticated sessions.

By contributing you agree your config is released under CC0.
