#!/usr/bin/env node
/**
 * Overlay motion + affordance probe.
 *
 * The overlay keyframes are hand-written against our own `--motion-duration-*`
 * tokens, and a mistake there is invisible: a misspelled keyframe name, or a
 * token that resolves to nothing, leaves `animation-name: none` and the panel
 * simply snaps in. That reads as "no animation was written" rather than "the
 * animation is broken", so nobody files it. Only a computed-style assertion
 * catches it.
 *
 * It also checks the note overflow button actually opens something, since that
 * button spent a while rendering on hover and doing nothing at all.
 *
 * Usage: build, run `pnpm preview`, then `node scripts/overlay-probe.mjs`.
 */
import { chromium } from "@playwright/test";

const FAIL = [];
function check(name, actual, want) {
  const ok =
    typeof want === "function" ? want(actual) : String(actual) === String(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${actual}`);
  if (!ok) FAIL.push(name);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
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
await page.waitForSelector("article", { timeout: 30000 });
await page.waitForTimeout(6000);

/* ---- note overflow menu ------------------------------------------------- */

const note = page.locator("article").first();
await note.hover();
const overflow = note.getByRole("button", { name: "More actions" });
check("overflow button present", await overflow.count(), (n) => Number(n) > 0);
await overflow.click();

const menu = page.getByRole("menu");
await menu.waitFor({ timeout: 5000 });
const menuStyle = await menu.evaluate((el) => {
  const s = getComputedStyle(el);
  return {
    animationName: s.animationName,
    animationDuration: s.animationDuration,
    animationTimingFunction: s.animationTimingFunction,
    transformOrigin: s.transformOrigin,
  };
});
check("menu animation-name", menuStyle.animationName, "motion-pop-in");
check(
  "menu animation-duration",
  menuStyle.animationDuration,
  (v) => v !== "0s",
);
check("menu easing is a curve", menuStyle.animationTimingFunction, (v) =>
  v.startsWith("cubic-bezier"),
);

const items = await page.getByRole("menuitem").allInnerTexts();
console.log("      menu items:", JSON.stringify(items));
check("menu has working actions", items.length, (n) => Number(n) >= 3);

await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("menu closes", await page.getByRole("menu").count(), 0);

/* ---- tooltip ------------------------------------------------------------ */

const themeToggle = page
  .getByRole("button", { name: /theme|dark|light/i })
  .first();
if ((await themeToggle.count()) > 0) {
  await themeToggle.hover();
  const tip = page.locator("[data-radix-popper-content-wrapper]").first();
  await tip.waitFor({ timeout: 5000 }).catch(() => {});
  const tipName = await tip
    .locator(".motion-popover")
    .first()
    .evaluate((el) => getComputedStyle(el).animationName)
    .catch(() => "missing");
  check("tooltip animation-name", tipName, "motion-pop-in");
}

/* ---- reduced motion still unmounts ------------------------------------- */

await page.emulateMedia({ reducedMotion: "reduce" });
await note.hover();
await overflow.click();
await page.getByRole("menu").waitFor({ timeout: 5000 });
const reducedDuration = await page
  .getByRole("menu")
  .evaluate((el) => getComputedStyle(el).animationDuration);
// Not `none`: Radix waits on animationend before unmounting, so killing the
// animation outright strands the exit state and the panel never leaves.
check(
  "reduced-motion duration is ~instant, not none",
  reducedDuration,
  "0.001s",
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(
  "menu still unmounts under reduced motion",
  await page.getByRole("menu").count(),
  0,
);

await browser.close();
if (FAIL.length > 0) {
  console.error(`\n${FAIL.length} overlay check(s) failed: ${FAIL.join(", ")}`);
  process.exit(1);
}
console.log("\nall overlay checks passed");
