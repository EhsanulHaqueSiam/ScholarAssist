# Site configs

One YAML file per site, keyed by the site's domain: `configs/org/<domain>/<flow-set>.yaml`.

Hard rules (enforced by `scholar lint` and CI):
- Strictly declarative. A closed step vocabulary; no code, no expressions.
- Zero user data. Field entries name profile keys (`applicant.email`), never values. Literal values in `fill`/`upload` fail lint; PII patterns fail lint.
- Semantic locators first (`role` + accessible name, `label`); CSS/XPath as ranked fallbacks only.
- A `submit: true` advance is the only way to submit, and the runtime always demands typed human confirmation there. No config can opt out.
- Declare what the site requires (`requires: [login]`) honestly.

This directory will move to its own registry repo (`scholarassist/configs`) once the format stabilizes.
