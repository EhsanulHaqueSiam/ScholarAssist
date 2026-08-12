import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BlockedError, expandHome, loadProfile, setProfileKey } from "./profile.js";

// One folder for the documents applications keep asking for (CV, transcript,
// passport scan, ...). `docs add` copies the file in and binds a profile key
// (documents.<name>) so file-kind config fields find it by name forever,
// wherever the original lived.
export const DOCS_DIR = path.join(os.homedir(), ".config", "scholar", "docs");

// Common per-site upload cap; we warn (not block) above it.
export const SIZE_WARN_MB = 10;

export interface DocEntry {
  key: string; // documents.<name>
  file: string;
  exists: boolean;
  sizeMB: number;
}

export function addDoc(
  file: string,
  as?: string,
  opts: { docsDir?: string; profilePath?: string } = {},
): DocEntry {
  const src = expandHome(file);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new BlockedError(`No such file: ${src}`);
  }
  const ext = path.extname(src).toLowerCase();
  const name = (as ?? path.basename(src, path.extname(src)))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) throw new BlockedError("Could not derive a name from the filename; pass --as <name>");
  const dir = opts.docsDir ?? DOCS_DIR;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, name + ext);
  fs.copyFileSync(src, dest);
  const key = `documents.${name}`;
  setProfileKey(key, dest, opts.profilePath);
  return { key, file: dest, exists: true, sizeMB: fs.statSync(dest).size / 1e6 };
}

export function listDocs(profilePath?: string): DocEntry[] {
  const docs = loadProfile(profilePath).documents;
  if (!docs || typeof docs !== "object") return [];
  return Object.entries(docs as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string" && v)
    .map(([name, v]) => {
      const file = expandHome(String(v));
      const exists = fs.existsSync(file);
      return { key: `documents.${name}`, file, exists, sizeMB: exists ? fs.statSync(file).size / 1e6 : 0 };
    });
}
