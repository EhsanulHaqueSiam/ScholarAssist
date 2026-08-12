#!/usr/bin/env node
// Records docs/demo.gif: the engine filling the demo scholarship form and
// stopping at the review gate. Human-paced typing so the GIF reads well.
// Usage: node scripts/record-demo.mjs   (needs chromium + ffmpeg)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const videoDir = path.join(root, ".demo-video");
fs.rmSync(videoDir, { recursive: true, force: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1100, height: 780 },
  recordVideo: { dir: videoDir, size: { width: 1100, height: 780 } },
});
const page = await context.newPage();
await page.goto(pathToFileURL(path.join(root, "test/fixtures/demo/form.html")).href);
await page.waitForTimeout(900);

const fills = [
  ["First name", "Ada", 70],
  ["Last name", "Lovelace", 70],
  ["Email address", "ada@example.org", 45],
  ["Country of citizenship", "Bangladesh", 55],
  ["Current institution", "Example University of Dhaka", 35],
  ["Cumulative GPA", "3.85", 90],
];
for (const [label, value, delay] of fills) {
  const loc = page.getByLabel(label);
  await loc.click();
  await loc.pressSequentially(value, { delay });
  await page.waitForTimeout(250);
}
const essay = page.getByLabel(/Why do you deserve/);
await essay.click();
await essay.pressSequentially(
  "I build things. Last year I taught forty students in my neighbourhood how to code, " +
    "and I want to keep building for the people around me.",
  { delay: 14 },
);
await page.waitForTimeout(600);

// The review gate: hover submit, never click it.
const submit = page.getByRole("button", { name: "Submit application" });
await submit.scrollIntoViewIfNeeded();
await submit.hover();
await page.waitForTimeout(400);
await page.evaluate(() => document.getElementById("gate").classList.add("show"));
await page.waitForTimeout(2600);

await context.close();
await browser.close();

const webm = fs.readdirSync(videoDir).find((f) => f.endsWith(".webm"));
const docsDir = path.join(root, "docs");
fs.mkdirSync(docsDir, { recursive: true });
const gif = path.join(docsDir, "demo.gif");
const palette = path.join(videoDir, "palette.png");
const src = path.join(videoDir, webm);
execFileSync("ffmpeg", ["-y", "-i", src, "-vf", "fps=12,scale=880:-1:flags=lanczos,palettegen", palette]);
execFileSync("ffmpeg", ["-y", "-i", src, "-i", palette, "-filter_complex", "fps=12,scale=880:-1:flags=lanczos[x];[x][1:v]paletteuse", gif]);
fs.rmSync(videoDir, { recursive: true, force: true });
console.log(`${gif} (${Math.round(fs.statSync(gif).size / 1024)} KB)`);
