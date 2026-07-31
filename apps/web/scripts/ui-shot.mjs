import { chromium } from "@playwright/test";

const b = await chromium.launch();
for (const mode of ["light", "dark"]) {
  const page = await b.newPage({
    viewport: { width: 1500, height: 950 },
    deviceScaleFactor: 2,
  });
  await page.addInitScript((m) => {
    localStorage.setItem(
      "setu-theme",
      JSON.stringify({ mode: m, themeId: "setu", accentId: "neutral" }),
    );
  }, mode);
  await page.goto("http://localhost:4273/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // Login screen exercises Input, Label, Button.
  await page.getByRole("button", { name: /Paste a private key/i }).click();
  await page.waitForTimeout(600);
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((a) => a.finished.catch(() => {})),
    ),
  );
  await page.screenshot({
    path: `test-results/screenshots/ui-form-${mode}.png`,
  });
  await page.close();
}
await b.close();
