#!/usr/bin/env node
/**
 * Capture app screenshots for design review.
 *
 * Usage: node scripts/screenshot.mjs [--url http://localhost:4273] [--out dir]
 *
 * Shoots each theme in both appearances. Screenshot-driven review is how the
 * gradient, the content-card lift and the interaction states get checked at all
 * — none of them are visible in a diff, and all of them are easy to break.
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const url = flag("url", "http://localhost:4273");
const outDir = resolve(process.cwd(), flag("out", "test-results/screenshots"));
const themes = flag("themes", "setu,dawn,github,nord").split(",");

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

/** Wait for every running CSS animation/transition to settle. */
async function settle() {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

const shots = [];
for (const themeId of themes) {
  for (const mode of ["light", "dark"]) {
    await page.addInitScript(
      ([id, m]) => {
        localStorage.setItem(
          "setu-theme",
          JSON.stringify({ mode: m, themeId: id, accentId: "neutral" }),
        );
      },
      [themeId, mode],
    );
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await settle();

    const name = `${themeId}-${mode}.png`;
    await page.screenshot({ path: resolve(outDir, name) });
    shots.push(name);
    console.log(`✓ ${name}`);
  }
}

await browser.close();
console.log(`\n${shots.length} screenshots → ${outDir}`);
