#!/usr/bin/env node
/**
 * Enforces a hard per-file line ceiling.
 *
 * Long files in this kind of codebase are not a style problem, they are where god
 * objects come from: a cache that also parses, a view model that also owns
 * networking, a switch statement that also mutates global state. Every one of
 * those starts as a reasonable file and is never split later, because by then
 * splitting it is a project.
 *
 * When this trips: SPLIT THE FILE. Never raise the limit and never add an
 * override to slip under it.
 */

import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LIMIT = 700;
/** Tests may be longer — a thorough table-driven suite is not a god object. */
const TEST_LIMIT = 1000;

const files = [];
for await (const entry of glob("{packages,apps}/**/*.{ts,tsx}", {
  cwd: ROOT,
  exclude: (p) => p.includes("node_modules") || p.includes("dist"),
})) {
  files.push(entry);
}

const violations = [];
for (const file of files) {
  const isTest = /\.(test|spec)\.tsx?$/.test(file);
  const limit = isTest ? TEST_LIMIT : LIMIT;
  const lines = readFileSync(resolve(ROOT, file), "utf8").split("\n").length;
  if (lines > limit) violations.push({ file, lines, limit });
}

if (violations.length > 0) {
  console.error(`\n✖ ${violations.length} file(s) over the line ceiling.\n`);
  for (const v of violations) {
    console.error(`  ${v.file}  ${v.lines} lines (limit ${v.limit})`);
  }
  console.error("\nSplit the file. Do not raise the limit.\n");
  process.exit(1);
}

console.log(`✓ all ${files.length} files within the line ceiling`);
