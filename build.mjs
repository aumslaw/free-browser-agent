#!/usr/bin/env node
// build.mjs — runs `vite build` then copies manifest.json + icons/ into dist/.
// This keeps the MV3 root layout (manifest.json + sidepanel.html + options.html
// + background.js + content.js + icons/) clean and predictable.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname.replace(/^\//, "");
const DIST = join(ROOT, "dist");

console.log("[build] running vite build...");
execSync("vite build", { stdio: "inherit", cwd: ROOT });

console.log("[build] copying manifest + icons into dist/...");
if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });

cpSync(join(ROOT, "manifest.json"), join(DIST, "manifest.json"));

const iconsDir = join(ROOT, "icons");
if (existsSync(iconsDir)) {
  cpSync(iconsDir, join(DIST, "icons"), { recursive: true });
}

// Vite emits sidepanel.html / options.html under their input-relative paths;
// the manifest references them at dist root, so flatten if needed.
for (const html of ["sidepanel.html", "options.html"]) {
  const nested = join(DIST, "src", html.replace(".html", ""), "index.html");
  const flat = join(DIST, html);
  if (existsSync(nested) && !existsSync(flat)) {
    cpSync(nested, flat);
  }
}

// Flatten offscreen.html (Vite emits it under src/offscreen/offscreen.html)
const offscreenNested = join(DIST, "src", "offscreen", "offscreen.html");
const offscreenFlat = join(DIST, "offscreen.html");
if (existsSync(offscreenNested) && !existsSync(offscreenFlat)) {
  cpSync(offscreenNested, offscreenFlat);
}

console.log("[build] done — dist/ ready to load as unpacked extension.");
