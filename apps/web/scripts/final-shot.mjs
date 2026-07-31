import { chromium } from "@playwright/test";

const b = await chromium.launch();
const page = await b.newPage({
  viewport: { width: 1500, height: 950 },
  deviceScaleFactor: 2,
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
await page.waitForTimeout(13000);
// Count how many rows still show a raw npub as the author name.
const npubNames = await page.evaluate(
  () =>
    [...document.querySelectorAll("article")]
      .map(
        (a) =>
          a.querySelector("button.font-semibold")?.textContent?.trim() ?? "",
      )
      .filter((n) => n.startsWith("npub1")).length,
);
const total = await page.locator("article").count();
console.log(`rows: ${total}, still showing raw npub as name: ${npubNames}`);
await page.evaluate(() =>
  Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))),
);
await page.screenshot({ path: "test-results/screenshots/final-home.png" });
await page.getByRole("button", { name: "Notifications", exact: true }).click();
await page.waitForTimeout(6000);
await page.evaluate(() =>
  Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))),
);
await page.screenshot({
  path: "test-results/screenshots/final-notifications.png",
});
console.log(
  "notification tabs:",
  (await page.getByRole("tab").allTextContents()).join(" | "),
);
await b.close();
