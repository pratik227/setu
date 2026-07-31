#!/usr/bin/env node
/**
 * Fails on arbitrary text-size literals — px *and* rem.
 *
 * Zoom works by scaling the root font-size, so a px text size is frozen against
 * Cmd +/-. Arbitrary rem literals zoom correctly but re-fragment the type scale
 * one component at a time, which is how a codebase ends up with text-[0.9rem]
 * next to text-[0.875rem]. Both are rejected: use a named token, and if the
 * scale genuinely cannot express a size, add a rem token to the @theme block.
 *
 * Allowlist entries are `path:line` and must carry a comment saying why.
 */

import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** `path:line` exemptions for genuinely decorative, non-text glyphs. */
const ALLOWLIST = new Set([
  // The badge's optical vertical padding — padding, not a text size, but it
  // shares the arbitrary-value syntax the scanner looks for.
]);

const PATTERNS = [
  // Tailwind arbitrary text size: text-[13px], text-[0.9rem], text-[1em]
  /\btext-\[[^\]]*\d(?:px|rem|em)[^\]]*\]/g,
  // Raw CSS font-size in a style prop or stylesheet
  /font-size:\s*[\d.]+(?:px|rem|em)/g,
];

const files = [];
for await (const entry of glob("{packages,apps}/**/*.{ts,tsx,css}", {
  cwd: ROOT,
  // `src-tauri` is Cargo's build cache plus Tauri's generated bindings, none of it
  // committed. It matters here specifically because Tauri's asset codegen copies
  // the *built* stylesheet into `target/`, where every Tailwind-emitted
  // `font-size:` would read as a violation in a file with no author to fix it.
  // Today that copy happens to be brotli-compressed so the regex finds nothing —
  // a guard that passes by luck is a guard that breaks on the next Tauri release.
  exclude: (p) =>
    p.includes("node_modules") || p.includes("dist") || p.includes("src-tauri"),
})) {
  files.push(entry);
}

const violations = [];
for (const file of files) {
  const abs = resolve(ROOT, file);
  const rel = relative(ROOT, abs);
  // The token definitions themselves are where sizes are allowed to be literal.
  if (rel.endsWith("styles/index.css")) continue;

  const lines = readFileSync(abs, "utf8").split("\n");
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (ALLOWLIST.has(`${rel}:${lineNo}`)) return;
    for (const pattern of PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        violations.push({ rel, lineNo, text: match[0] });
      }
    }
  });
}

if (violations.length > 0) {
  console.error(
    `\n✖ ${violations.length} arbitrary text-size literal(s) found.\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.lineNo}  ${v.text}`);
  }
  console.error(
    "\nUse a named token (text-sm, text-2xs, …). If the scale cannot express\n" +
      "the size, add a rem-based token in packages/ui/src/styles/index.css\n" +
      "under @theme — do not inline a literal.\n",
  );
  process.exit(1);
}

console.log(
  `✓ no arbitrary text-size literals (${files.length} files scanned)`,
);
