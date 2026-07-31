#!/usr/bin/env node
/**
 * Enforces the layer dependency graph.
 *
 *   protocol  ←  core  ←  app/shells
 *   ui        (imports neither protocol nor core)
 *
 * What keeps the shared layer honest is a headless CLI that consumes it: the
 * moment client logic can reach for a UI framework, it starts living in the wrong
 * place. So `core` may not import React or any DOM-framework package at all, and
 * `ui` may not import client logic. If a feature cannot be exercised from
 * `apps/cli`, it is misplaced.
 */

import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** package dir -> specifiers it must never import (prefix match). */
const RULES = {
  "packages/protocol": {
    forbidden: ["@setu/core", "@setu/ui", "react", "react-dom", "dexie"],
    why: "protocol is the bottom layer: wire types and crypto only",
  },
  "packages/core": {
    forbidden: ["@setu/ui", "react", "react-dom", "@tanstack/react-query"],
    why: "core must stay headless so apps/cli can exercise every feature",
  },
  "packages/ui": {
    forbidden: ["@setu/core", "@setu/protocol", "dexie"],
    why: "ui is presentation only; it must not know about relays or events",
  },
};

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

const violations = [];

for (const [dir, rule] of Object.entries(RULES)) {
  const files = [];
  for await (const entry of glob(`${dir}/**/*.{ts,tsx}`, {
    cwd: ROOT,
    exclude: (p) => p.includes("node_modules") || p.includes("dist"),
  })) {
    files.push(entry);
  }

  for (const file of files) {
    const source = readFileSync(resolve(ROOT, file), "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      const hit = rule.forbidden.find(
        (f) => spec === f || spec.startsWith(`${f}/`),
      );
      if (hit) violations.push({ file, spec, hit, why: rule.why });
    }
  }
}

if (violations.length > 0) {
  console.error(`\n✖ ${violations.length} layer violation(s).\n`);
  for (const v of violations) {
    console.error(`  ${v.file}\n    imports "${v.spec}" — ${v.why}\n`);
  }
  process.exit(1);
}

console.log("✓ layer dependency graph intact");
