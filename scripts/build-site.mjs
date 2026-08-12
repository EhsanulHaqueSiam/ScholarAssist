#!/usr/bin/env node
// Generates site/index.html from configs/**/*.yaml. No server, no accounts:
// the repo is the registry, this is the read layer (Homebrew formulae pattern).
// Freshness comes from each config's last_verified stamp; a nightly verify
// job will update those stamps once the registry repo exists.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const configsDir = path.join(root, "configs");
const outDir = path.join(root, "site");

function* walkYaml(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkYaml(full);
    else if (/\.ya?ml$/.test(entry.name)) yield full;
  }
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const staleDays = (dateStr) => {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
};

const configs = [];
for (const file of walkYaml(configsDir)) {
  const raw = fs.readFileSync(file, "utf8");
  try {
    const data = parse(raw);
    if (data?.site?.id) configs.push({ file: path.relative(root, file), data, raw });
  } catch {
    // invalid YAML is CI's problem, not the site's
  }
}
configs.sort((a, b) => a.data.site.id.localeCompare(b.data.site.id));

const rows = configs
  .map(({ file, data, raw }) => {
    const s = data.site;
    const days = staleDays(s.last_verified);
    const fresh = days <= 30 ? "fresh" : days <= 90 ? "aging" : "stale";
    const freshLabel = s.last_verified ? `${s.last_verified} (${days}d)` : "never verified";
    return `<tr>
  <td>${esc(s.id)}</td>
  <td>${esc(s.name ?? "")}</td>
  <td>${esc(Object.keys(data.flows ?? {}).join(", "))}</td>
  <td>${esc((data.requires ?? []).join(", ") || "none")}</td>
  <td class="${fresh}">${esc(freshLabel)}</td>
  <td>${esc(s.maintainer ?? "")}</td>
</tr>
<tr class="detail"><td colspan="6"><details><summary>${esc(file)}</summary><pre>${esc(raw)}</pre></details></td></tr>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ScholarAssist configs</title>
<style>
  :root { color-scheme: dark; }
  body { background: #000; color: #fff; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem; }
  main { max-width: 72rem; margin: 0 auto; }
  h1 { font-size: 1.2rem; margin: 0 0 .25rem; }
  p { color: #9ba3ae; margin: 0 0 1.5rem; }
  a { color: #e8b64c; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th { text-align: left; font-weight: 600; border-bottom: 1px solid #2a2e35; padding: .4rem .75rem .4rem 0; }
  td { border-bottom: 1px solid #17191d; padding: .4rem .75rem .4rem 0; vertical-align: top; }
  tr.detail td { border-bottom: 1px solid #2a2e35; padding: 0 0 .6rem; }
  details summary { cursor: pointer; color: #9ba3ae; font-family: ui-monospace, monospace; font-size: 12px; }
  pre { background: #0a0b0d; border: 1px solid #17191d; padding: .75rem; overflow-x: auto; font-size: 12px; }
  .fresh { color: #4fb477; } .aging { color: #e8b64c; } .stale { color: #e5645a; }
</style>
</head>
<body>
<main>
<h1>ScholarAssist configs</h1>
<p>${configs.length} site config(s). Community-maintained, PII-free by construction, human-reviewed.
Contribute via pull request. Install: <code>scholar</code> CLI reads this repo's configs directory.</p>
<table>
<thead><tr><th>id</th><th>name</th><th>flows</th><th>requires</th><th>last verified</th><th>maintainer</th></tr></thead>
<tbody>
${rows || `<tr><td colspan="6">No configs yet. Record one: scholar config record &lt;url&gt;</td></tr>`}
</tbody>
</table>
</main>
</body>
</html>
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "index.html"), html);
console.log(`site/index.html generated (${configs.length} configs)`);
