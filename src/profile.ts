import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

// ponytail: plaintext YAML at 0600, same posture as ~/.aws/credentials.
// Upgrade path when the registry ships: AES-256-GCM at rest, key in the OS
// keychain via @napi-rs/keyring.
export const PROFILE_PATH = path.join(os.homedir(), ".config", "scholar", "profile.yaml");

export type Profile = Record<string, unknown>;

export class BlockedError extends Error {}

export function loadProfile(profilePath = PROFILE_PATH): Profile {
  if (!fs.existsSync(profilePath)) {
    throw new BlockedError(
      `No profile at ${profilePath}. Run \`scholar profile init\` and fill it in.`,
    );
  }
  const data = parse(fs.readFileSync(profilePath, "utf8"));
  if (!data || typeof data !== "object") throw new BlockedError("Profile is empty or not a map.");
  return data as Profile;
}

// Resolve a dot path like "applicant.given_name". Missing values BLOCK the
// run — the tool never invents, defaults, or leaves-blank-and-continues.
export function resolveKey(profile: Profile, dotPath: string): string {
  let cur: unknown = profile;
  for (const part of dotPath.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as object)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      throw new BlockedError(
        `Profile is missing \`${dotPath}\`. Add it to your profile and re-run — I won't guess.`,
      );
    }
  }
  if (cur === null || cur === undefined || (typeof cur === "object" && cur !== null)) {
    throw new BlockedError(`Profile key \`${dotPath}\` is not a scalar value.`);
  }
  return String(cur);
}

const TEMPLATE_RE = /^\{\{\s*(profile|inputs)\.([\w.]+)\s*\}\}$/;

export function resolveTemplate(
  template: string,
  profile: Profile,
  inputs: Record<string, string | number | boolean>,
): { value: string; source: string } {
  const m = TEMPLATE_RE.exec(template);
  if (!m) throw new BlockedError(`Not a valid template: ${template}`);
  if (m[1] === "profile") {
    return { value: resolveKey(profile, m[2]), source: `profile.${m[2]}` };
  }
  if (!(m[2] in inputs)) {
    throw new BlockedError(`Missing flow input \`${m[2]}\`. Pass it with --input ${m[2]}=...`);
  }
  return { value: String(inputs[m[2]]), source: `inputs.${m[2]}` };
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

const PROFILE_TEMPLATE = `# scholar profile — this file never leaves your machine.
# Every value here is YOURS; the tool only transports it, never invents it.
applicant:
  given_name: ""
  family_name: ""
  email: ""
  phone: ""
  country: ""
edu:
  institution: ""
  gpa: ""
  graduation_year: ""
  major: ""
essay:
  # Your own writing only. Add one key per reusable essay.
  # why_deserve: |
  #   ...
documents:
  # transcript: ~/Documents/transcript.pdf
`;

export function initProfile(profilePath = PROFILE_PATH): boolean {
  if (fs.existsSync(profilePath)) return false;
  fs.mkdirSync(path.dirname(profilePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(profilePath, PROFILE_TEMPLATE, { mode: 0o600 });
  return true;
}
