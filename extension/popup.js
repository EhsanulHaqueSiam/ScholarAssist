// Popup: inject the recorder (activeTab), review proposed bindings, export a
// draft config YAML. Mirrors src/fieldmatch.ts — keep the two in sync.

const AUTOCOMPLETE_MAP = {
  "given-name": "applicant.given_name", "additional-name": "applicant.middle_name",
  "family-name": "applicant.family_name", name: "applicant.full_name", email: "applicant.email",
  tel: "applicant.phone", "tel-national": "applicant.phone", bday: "applicant.dob",
  country: "applicant.country", "country-name": "applicant.country",
  "street-address": "applicant.address.street", "address-line1": "applicant.address.street",
  "address-level2": "applicant.address.city", "address-level1": "applicant.address.region",
  "postal-code": "applicant.address.postal_code", organization: "edu.institution",
};

const SYNONYMS = [
  [/first\s*name|given\s*name/i, "applicant.given_name"],
  [/last\s*name|family\s*name|surname/i, "applicant.family_name"],
  [/full\s*name|your\s*name/i, "applicant.full_name"],
  [/e-?mail/i, "applicant.email"],
  [/phone|mobile|cell/i, "applicant.phone"],
  [/date\s*of\s*birth|birth\s*date|\bdob\b/i, "applicant.dob"],
  [/nationality|citizenship/i, "applicant.nationality"],
  [/country/i, "applicant.country"],
  [/postal|zip/i, "applicant.address.postal_code"],
  [/city|town/i, "applicant.address.city"],
  [/\bgpa\b|\bcgpa\b|grade\s*point/i, "edu.gpa"],
  [/university|college|institution|school/i, "edu.institution"],
  [/major|field\s*of\s*study/i, "edu.major"],
  [/graduat/i, "edu.graduation_year"],
  [/transcript/i, "documents.transcript"],
  [/resume|\bcv\b/i, "documents.resume"],
];

const slug = (s) => (s || "field").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

function propose(ev) {
  const token = (ev.autocomplete || "").split(/\s+/).filter((t) => t && !/^(section-|shipping$|billing$)/.test(t)).pop();
  if (token && AUTOCOMPLETE_MAP[token]) return AUTOCOMPLETE_MAP[token];
  if (ev.tag === "textarea") return "essay." + slug(ev.label || ev.name || "answer");
  for (const text of [ev.label, ev.ariaLabel, ev.placeholder, ev.name, ev.id]) {
    if (!text) continue;
    for (const [re, key] of SYNONYMS) if (re.test(text)) return key;
  }
  return "todo." + slug(ev.label || ev.name || ev.id);
}

const $ = (id) => document.getElementById(id);

async function load() {
  const { scholarEvents = [], scholarUrl = "" } = await chrome.storage.session.get(["scholarEvents", "scholarUrl"]);
  const fields = scholarEvents.filter((e) => e.kind === "field");
  $("status").textContent = scholarEvents.length
    ? `${fields.length} field(s), ${scholarEvents.filter((e) => e.kind === "click").length} click(s) captured on ${scholarUrl}`
    : "Not recording.";
  $("fields").innerHTML = "";
  fields.forEach((f, i) => {
    const div = document.createElement("div");
    div.className = "field";
    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = f.evidence.label || f.evidence.ariaLabel || f.evidence.name || f.evidence.id || "(unnamed)";
    const input = document.createElement("input");
    input.value = f.bind || propose(f.evidence);
    input.dataset.index = String(i);
    input.addEventListener("change", async () => {
      f.bind = input.value.trim();
      const all = scholarEvents;
      await chrome.storage.session.set({ scholarEvents: all });
    });
    div.append(desc, input);
    $("fields").append(div);
  });
  return { scholarEvents, scholarUrl };
}

$("record").addEventListener("click", async () => {
  // Content scripts can't touch storage.session unless we widen access.
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  $("status").textContent = "Recording. Fill the form by hand, then come back and Export.";
});

$("clear").addEventListener("click", async () => {
  await chrome.storage.session.remove(["scholarEvents", "scholarUrl"]);
  load();
});

$("export").addEventListener("click", async () => {
  const { scholarEvents, scholarUrl } = await load();
  const fields = scholarEvents.filter((e) => e.kind === "field");
  const clicks = scholarEvents.filter((e) => e.kind === "click");
  if (!fields.length) { $("status").textContent = "Nothing captured yet."; return; }

  let host = "site";
  let globs = [];
  try {
    const u = new URL(scholarUrl);
    host = u.hostname.replace(/^www\./, "");
    globs = [`https://*.${host}/**`, `https://${host}/**`];
  } catch { globs = [scholarUrl]; }

  const yamlLoc = (l) => Object.entries(l).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
  const lines = [
    "# Draft recorded with the ScholarAssist extension. Review before use.",
    "# Rename any todo.* keys, verify with: scholar lint && scholar config verify",
    "schema_version: 1",
    "site:",
    `  id: ${host.split(".")[0]}`,
    `  match: [${globs.map((g) => JSON.stringify(g)).join(", ")}]`,
    `  last_verified: ${new Date().toISOString().slice(0, 10)}`,
    "fields:",
  ];
  const keys = [];
  for (const f of fields) {
    const key = f.bind || propose(f.evidence);
    if (keys.includes(key)) continue;
    keys.push(key);
    lines.push(`  ${key}:`);
    lines.push(`    locator:`);
    lines.push(`      primary: { ${yamlLoc(f.selectors[0])} }`);
    if (f.selectors.length > 1) {
      lines.push(`      fallbacks:`);
      for (const s of f.selectors.slice(1)) lines.push(`        - { ${yamlLoc(s)} }`);
    }
    if (f.evidence.tag === "textarea") lines.push(`    kind: freeform`);
    if (f.evidence.autocomplete) lines.push(`    autocomplete: ${f.evidence.autocomplete}`);
  }
  const advance = clicks.at(-1);
  lines.push("flows:", "  apply:", "    pages:", "      - id: start", "        steps:");
  lines.push(`          - { action: navigate, url: ${JSON.stringify(scholarUrl)} }`);
  lines.push(`          - { action: fill_fields, fields: [${keys.join(", ")}] }`);
  if (advance) {
    lines.push("        advance:");
    lines.push(`          target: { primary: { ${yamlLoc(advance.selectors[0])} } }`);
    if (/submit|apply|finish/i.test(advance.text || "")) lines.push("          submit: true");
  }

  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/yaml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `draft-${host}.yaml`;
  a.click();
});

load();
