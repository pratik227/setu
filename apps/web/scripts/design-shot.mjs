import { chromium } from "@playwright/test";

const browser = await chromium.launch();
for (const mode of ["dark", "light"]) {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 950 },
    deviceScaleFactor: 2,
  });
  await page.addInitScript((m) => {
    localStorage.setItem(
      "setu-session",
      JSON.stringify({
        kind: "readonly",
        pubkey:
          "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240",
      }),
    );
    localStorage.setItem(
      "setu-theme",
      JSON.stringify({ mode: m, themeId: "setu", accentId: "neutral" }),
    );
  }, mode);
  await page.goto("http://localhost:4273/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("article", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(11000);
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((a) => a.finished.catch(() => {})),
    ),
  );
  await page.screenshot({
    path: `test-results/screenshots/design-${mode}.png`,
  });
  console.log(`${mode}: articles=${await page.locator("article").count()}`);
  await page.close();
}
await browser.close();
