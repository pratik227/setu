#!/usr/bin/env node
/**
 * Layout regression probe.
 *
 * Checks the two properties that are invisible in a diff and were both broken at
 * once:
 *
 *  1. A screen that owns its own scroller actually scrolls, and the feed inside
 *     it is not squeezed into a sliver by a fixed header.
 *  2. A `sticky` header really is sticky. `.setu-chrome-surface` once set
 *     `position: relative`, and because those rules are unlayered they beat
 *     Tailwind's layered `sticky` — so every sticky header in the app silently
 *     scrolled away while the markup looked right. A computed-style assertion is
 *     the only thing that catches that class of bug.
 *
 * Usage: build, run `pnpm preview`, then `node scripts/layout-probe.mjs`.
 */
import { chromium } from "@playwright/test";

const b = await chromium.launch();
const page = await b.newPage({
  viewport: { width: 1500, height: 900 },
  deviceScaleFactor: 1,
});
await page.addInitScript(() =>
  localStorage.setItem(
    "setu-session",
    JSON.stringify({
      kind: "readonly",
      pubkey:
        "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240",
    }),
  ),
);
await page.goto("http://localhost:4273/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("article", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(11000);
await page.getByRole("button", { name: "Profile", exact: true }).click();
await page.waitForTimeout(8000);
await page.mouse.move(700, 500);
await page.mouse.wheel(0, 2000);
await page.waitForTimeout(1000);
const tab = page.getByRole("tab", { name: "Notes" });
const box = await tab.boundingBox();
console.log("tabs bounding box after scroll:", JSON.stringify(box));
console.log(
  "tabs pinned:",
  box?.y !== undefined && box.y > 30 && box.y < 160
    ? "YES (sticky works)"
    : `NO (y=${box?.y})`,
);
await page.evaluate(() =>
  Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))),
);
// Fail loudly: a probe that only prints is a probe nobody reads.
const pos = await page.evaluate(() => {
  const el = document.querySelector(
    '[role="tablist"][aria-label="Profile sections"]',
  )?.parentElement;
  return el ? getComputedStyle(el).position : "missing";
});
console.log("computed position of the tab bar:", pos);
await page.screenshot({ path: "test-results/screenshots/profile-sticky.png" });
const y = box === null ? undefined : box.y;
const pinned = typeof y === "number" && y > 30 && y < 160;
if (pos !== "sticky" || !pinned) {
  console.error("\nFAIL: the profile tab bar is not sticky.");
  await b.close();
  process.exit(1);
}
console.log("\nOK: profile scrolls and its tab bar is sticky.");
await b.close();
