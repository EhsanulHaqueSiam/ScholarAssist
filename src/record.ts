import fs from "node:fs";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Engine } from "./engine.js";
import {
  buildDraft,
  proposeBindings,
  type RecordedClick,
  type RecordedField,
  type RecordedNav,
  type Recording,
} from "./draft.js";

// In-browser recorder: you apply once by hand, it watches WHERE you typed and
// clicked (selectors + label evidence) and drafts a config. It deliberately
// never reads what you typed — recordings are PII-free by construction.
const CAPTURE_SCRIPT = `(() => {
  if (window.__scholarInstalled) return; window.__scholarInstalled = true;
  const evidenceOf = (el) => {
    const labelEl = el.labels && el.labels[0] ? el.labels[0] : el.closest("label");
    const label = labelEl ? labelEl.textContent.replace(/\\s+/g, " ").trim().slice(0, 120) : undefined;
    return {
      label,
      ariaLabel: el.getAttribute("aria-label") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      name: el.getAttribute("name") || undefined,
      id: el.id || undefined,
      autocomplete: el.getAttribute("autocomplete") || undefined,
      type: el.getAttribute("type") || undefined,
      tag: el.tagName.toLowerCase(),
    };
  };
  const cssOf = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const name = el.getAttribute("name");
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur.tagName !== "BODY" && parts.length < 4) {
      const idx = Array.from(cur.parentElement ? cur.parentElement.children : []).filter(c => c.tagName === cur.tagName).indexOf(cur) + 1;
      parts.unshift(cur.tagName.toLowerCase() + ":nth-of-type(" + idx + ")");
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  const selectorsOf = (el, ev) => {
    const out = [];
    const testid = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa");
    if (ev.label) out.push({ label: ev.label });
    if (ev.ariaLabel) out.push({ label: ev.ariaLabel });
    if (ev.placeholder) out.push({ placeholder: ev.placeholder });
    if (testid) out.push({ testid });
    out.push({ css: cssOf(el) });
    return out;
  };
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!el || !/^(input|textarea|select)$/i.test(el.tagName)) return;
    const ev = evidenceOf(el);
    window.__scholarRecord({ kind: "field", evidence: ev, selectors: selectorsOf(el, ev), ts: Date.now() });
  }, true);
  document.addEventListener("click", (e) => {
    const el = e.target && e.target.closest ? e.target.closest("button, a, [role=button], input[type=submit]") : null;
    if (!el) return;
    const text = (el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    const role = el.tagName === "A" ? "link" : "button";
    const sels = [];
    if (text) sels.push({ role, name: text });
    const testid = el.getAttribute("data-testid");
    if (testid) sels.push({ testid });
    sels.push({ css: el.id ? "#" + CSS.escape(el.id) : el.tagName.toLowerCase() });
    window.__scholarRecord({ kind: "click", text, role, selectors: sels, ts: Date.now() });
  }, true);
})();`;

export async function recordConfig(url: string, outDir: string): Promise<string> {
  const fields: RecordedField[] = [];
  const clicks: RecordedClick[] = [];
  const navs: RecordedNav[] = [];

  const engine = await Engine.launch({ headless: false });
  const page = engine.page;
  await page.exposeFunction("__scholarRecord", (e: Record<string, unknown>) => {
    if (e.kind === "field") fields.push(e as unknown as RecordedField);
    else clicks.push(e as unknown as RecordedClick);
  });
  await page.addInitScript(CAPTURE_SCRIPT);
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && !frame.url().startsWith("about:")) {
      navs.push({ url: frame.url(), ts: Date.now() });
    }
  });
  await page.goto(url);
  await page.evaluate(CAPTURE_SCRIPT).catch(() => {});

  console.log("\nRecording. Walk through the application by hand (typed values are NOT captured).");
  console.log("Stop BEFORE the final submit if you don't want to submit for real.");
  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question("Press Enter here when done... ");

  const recording: Recording = { startUrl: url, fields, clicks, navs };
  const bindings = proposeBindings(fields);

  // Confirm each proposed binding in the terminal.
  console.log(`\nCaptured ${bindings.length} field(s). Confirm profile-key bindings:`);
  for (const b of bindings) {
    const desc = b.evidence.label ?? b.evidence.ariaLabel ?? b.evidence.name ?? b.evidence.id ?? "(unnamed)";
    const answer = await rl.question(
      `  "${desc}" -> ${b.key} (${b.confidence})  [Enter=keep / type new key / s=skip]: `,
    );
    if (answer.trim() === "s") b.key = "";
    else if (answer.trim()) b.key = answer.trim();
  }
  rl.close();

  const kept = bindings.filter((b) => b.key);
  const yaml = buildDraft(recording, kept);
  fs.mkdirSync(outDir, { recursive: true });
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "") || "local";
    } catch {
      return "local";
    }
  })();
  const outFile = path.join(outDir, `draft-${host}.yaml`);
  fs.writeFileSync(outFile, yaml);
  await engine.close();
  return outFile;
}
