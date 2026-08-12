import { type } from "arktype";

// A locator names ONE way to find an element. Exactly one kind key must be set
// (role may carry an accessible `name`); enforced by lint, kept loose here so
// schema errors stay readable.
export const Locator = type({
  "role?": "string",
  "name?": "string",
  "label?": "string",
  "text?": "string",
  "testid?": "string",
  "css?": "string",
  "placeholder?": "string",
});
export type Locator = typeof Locator.infer;

// Ranked targeting: semantic primary, cheaper-to-break fallbacks after it.
export const Target = type({
  primary: Locator,
  "fallbacks?": Locator.array(),
});
export type Target = typeof Target.infer;

export const Wait = type({
  "url_contains?": "string",
  "locator?": Locator,
});
export type Wait = typeof Wait.infer;

export const Step = type({
  "id?": "string",
  action: "'navigate'|'fill'|'fill_fields'|'select'|'click'|'press'|'upload'|'wait'",
  "url?": "string",
  "target?": Target,
  "value?": "string",
  "fields?": "string[]",
  "key?": "string",
  "file?": "string",
  "for?": Wait,
});
export type Step = typeof Step.infer;

// A flow is a list of pages. Steps fill within a page; `advance` is the click
// that leaves it. `submit: true` marks the advance that submits the
// application — the runtime always demands explicit human confirmation there,
// in every mode. That invariant lives in code, not config.
export const PageDef = type({
  id: "string",
  "steps?": Step.array(),
  "advance?": {
    target: Target,
    "submit?": "boolean",
    "wait_for?": Wait,
  },
});
export type PageDef = typeof PageDef.infer;

export const FlowInput = type({
  name: "string",
  type: "'string'|'number'|'boolean'",
  "required?": "boolean",
  "default?": "string|number|boolean",
});

export const Flow = type({
  "inputs?": FlowInput.array(),
  pages: PageDef.array(),
});
export type Flow = typeof Flow.infer;

// fields: canonical profile key -> how this site asks for it. The config names
// profile KEYS, never values — there is no syntactic slot for user data.
export const FieldDef = type({
  locator: Target,
  "kind?": "'text'|'freeform'|'select'|'file'",
  "max_chars?": "number",
  "autocomplete?": "string",
});
export type FieldDef = typeof FieldDef.infer;

export const SiteConfig = type({
  schema_version: "1",
  site: {
    id: "string",
    "name?": "string",
    match: "string[]",
    "maintainer?": "string",
    "last_verified?": "string",
  },
  "requires?": "('login'|'file-upload')[]",
  "fields?": type({ "[string]": FieldDef }),
  flows: type({ "[string]": Flow }),
});
export type SiteConfig = typeof SiteConfig.infer;

export const validateConfig = (data: unknown): SiteConfig | type.errors =>
  SiteConfig(data);
