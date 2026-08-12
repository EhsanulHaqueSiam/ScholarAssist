// Maps a recorded form field to a canonical profile key using the evidence
// around it. Resolution order: HTML autocomplete token (spec-backed) then
// label/name synonyms. Returns null rather than guessing badly — an
// unmatched field becomes a TODO in the draft config for the human to bind.

export interface FieldEvidence {
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  type?: string;
  tag?: string;
}

export interface Match {
  key: string;
  confidence: "autocomplete" | "synonym" | "weak";
}

// WHATWG autofill tokens -> canonical profile keys (identity/contact block).
const AUTOCOMPLETE_MAP: Record<string, string> = {
  "given-name": "applicant.given_name",
  "additional-name": "applicant.middle_name",
  "family-name": "applicant.family_name",
  name: "applicant.full_name",
  email: "applicant.email",
  tel: "applicant.phone",
  "tel-national": "applicant.phone",
  bday: "applicant.dob",
  country: "applicant.country",
  "country-name": "applicant.country",
  "street-address": "applicant.address.street",
  "address-line1": "applicant.address.street",
  "address-level2": "applicant.address.city",
  "address-level1": "applicant.address.region",
  "postal-code": "applicant.address.postal_code",
  organization: "edu.institution",
  url: "applicant.website",
};

// The academic core has no spec tokens; synonyms carry it.
const SYNONYMS: [RegExp, string][] = [
  [/first\s*name|given\s*name|fore\s*name/i, "applicant.given_name"],
  [/last\s*name|family\s*name|sur\s*name/i, "applicant.family_name"],
  [/full\s*name|your\s*name|applicant\s*name/i, "applicant.full_name"],
  [/e-?mail/i, "applicant.email"],
  [/phone|mobile|cell/i, "applicant.phone"],
  [/date\s*of\s*birth|birth\s*date|\bdob\b/i, "applicant.dob"],
  [/nationality|citizenship/i, "applicant.nationality"],
  [/country/i, "applicant.country"],
  [/postal|zip\s*code/i, "applicant.address.postal_code"],
  [/city|town/i, "applicant.address.city"],
  [/address/i, "applicant.address.street"],
  [/\bgpa\b|\bcgpa\b|grade\s*point/i, "edu.gpa"],
  [/university|college|institution|school\s*name|current\s*school/i, "edu.institution"],
  [/major|field\s*of\s*study|course\s*of\s*study|degree\s*program(?:me)?/i, "edu.major"],
  [/graduat/i, "edu.graduation_year"],
  [/class\s*rank/i, "edu.class_rank"],
  [/\bsat\b|\bact\b|test\s*score/i, "edu.test_scores"],
  [/transcript/i, "documents.transcript"],
  [/resume|\bcv\b|curriculum\s*vitae/i, "documents.resume"],
];

export function matchField(ev: FieldEvidence): Match | null {
  const token = ev.autocomplete
    ?.split(/\s+/)
    .filter((t) => !/^(section-|shipping$|billing$|home$|work$|mobile$)/.test(t))
    .pop();
  if (token && AUTOCOMPLETE_MAP[token]) {
    return { key: AUTOCOMPLETE_MAP[token], confidence: "autocomplete" };
  }
  // Strongest human-facing evidence first; machine names are a weak signal.
  const tiers: [string | undefined, Match["confidence"]][] = [
    [ev.label, "synonym"],
    [ev.ariaLabel, "synonym"],
    [ev.placeholder, "synonym"],
    [ev.name, "weak"],
    [ev.id, "weak"],
  ];
  for (const [text, confidence] of tiers) {
    if (!text) continue;
    for (const [re, key] of SYNONYMS) {
      if (re.test(text)) return { key, confidence };
    }
  }
  if (ev.type === "email") return { key: "applicant.email", confidence: "weak" };
  if (ev.type === "tel") return { key: "applicant.phone", confidence: "weak" };
  return null;
}

// A big free-text box is an essay answer, never an autofill target.
export function looksFreeform(ev: FieldEvidence): boolean {
  return ev.tag === "textarea";
}
