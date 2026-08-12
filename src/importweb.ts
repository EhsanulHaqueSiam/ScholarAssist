import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BlockedError } from "./profile.js";

const exec = promisify(execFile);

// `scholar profile import <url>`: pull candidate profile values from the
// user's OWN portfolio/CV page. Candidates are only ever proposals — the CLI
// shows each one and the human confirms or edits before anything is saved.
// Deterministic regexes always run; the claude CLI (if installed) adds
// harder-to-pattern keys. Keys outside the allowlist are dropped.
export interface Candidate {
  key: string;
  value: string;
  evidence: string;
}

export const IMPORTABLE_KEYS = [
  "applicant.given_name",
  "applicant.family_name",
  "applicant.email",
  "applicant.phone",
  "applicant.country",
  "edu.institution",
  "edu.major",
  "edu.gpa",
  "edu.graduation_year",
  "links.website",
  "links.github",
  "links.linkedin",
] as const;

export async function fetchPageText(url: string): Promise<string> {
  if (!/^https?:\/\//.test(url)) throw new BlockedError(`Not an http(s) URL: ${url}`);
  const res = await fetch(url, { redirect: "follow" }).catch((e: Error) => {
    throw new BlockedError(`Could not fetch ${url}: ${e.message}`);
  });
  if (!res.ok) throw new BlockedError(`Could not fetch ${url}: HTTP ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 15_000);
}

// Deterministic candidates: things a regex finds unambiguously.
export function extractCandidates(text: string, sourceUrl = ""): Candidate[] {
  const out: Candidate[] = [];
  const add = (key: string, value: string, evidence: string) => {
    if (value && !out.some((c) => c.key === key)) out.push({ key, value, evidence });
  };
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text);
  if (email) add("applicant.email", email[0], "email address on the page");
  const gh = /https?:\/\/(?:www\.)?github\.com\/[\w-]+/i.exec(text);
  if (gh) add("links.github", gh[0], "GitHub link on the page");
  const li = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w-]+/i.exec(text);
  if (li) add("links.linkedin", li[0], "LinkedIn link on the page");
  if (sourceUrl) add("links.website", sourceUrl, "the page itself");
  return out;
}

// LLM candidates via the user's own claude CLI (same posture as locator
// repair: page text goes to the model, profile data never does).
export async function llmCandidates(text: string): Promise<Candidate[]> {
  const prompt = [
    `Extract profile facts about the page's OWNER from this personal portfolio/CV text.`,
    `Allowed keys (use no others): ${IMPORTABLE_KEYS.join(", ")}`,
    `Only include a key when the text states it explicitly — never infer or guess.`,
    `Reply with ONLY a JSON array: [{"key":"...","value":"...","evidence":"<short quote from the text>"}]`,
    `Text:`,
    text,
  ].join("\n");
  try {
    const { stdout } = await exec("claude", ["-p", prompt], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const m = /\[[\s\S]*\]/.exec(stdout);
    if (!m) return [];
    const parsed = JSON.parse(m[0]) as Candidate[];
    return parsed.filter(
      (c) =>
        c && typeof c.key === "string" && typeof c.value === "string" && c.value.length > 0 &&
        (IMPORTABLE_KEYS as readonly string[]).includes(c.key),
    );
  } catch {
    return [];
  }
}
