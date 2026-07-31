import { chromium } from "@playwright/test";
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 950 } });
const errs = new Set();
page.on("console", m => { const t = m.text();
  if ((m.type()==="error"||m.type()==="warning") && !/CORS|ERR_|WebSocket|Failed to load resource|Download the React/.test(t)) errs.add(t.slice(0,150)); });
page.on("pageerror", e => errs.add("PAGEERROR " + String(e).slice(0,150)));
await page.addInitScript(() => localStorage.setItem("setu-session", JSON.stringify({ kind: "readonly", pubkey: "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240" })));
await page.goto("http://localhost:4173/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("article", { timeout: 30000 });
await page.waitForTimeout(11000);
console.log("feed rows:", await page.locator("article").count());
console.log("reserved media boxes:", await page.locator('article [style*="aspect-ratio"]').count());
// Every route still mounts
for (const n of ["Explore","Reads","Articles","Messages","Notifications","Mentions","Bookmarks","Profile","Home"]) {
  const btn = page.getByRole("button", { name: n, exact: true });
  if (await btn.count() === 0) { console.log("MISSING NAV:", n); continue; }
  await btn.click(); await page.waitForTimeout(1200);
}
await page.locator('button[aria-label="Settings"]').click(); await page.waitForTimeout(3500);
const st = await page.locator("body").innerText();
console.log("settings sections:", ["Appearance","Profile","Relays","Message relays","Sync"].filter(s => st.includes(s)).join(", "));
// Account switcher
await page.getByRole("button", { name: "Home", exact: true }).click(); await page.waitForTimeout(1200);
const acct = await page.locator('aside button').filter({ hasText: /Snowden|read-only/ }).count();
console.log("account footer present:", acct > 0);
// Search palette
await page.keyboard.press("Meta+k"); await page.waitForTimeout(800);
console.log("search opens:", await page.locator('[role="dialog"],[aria-activedescendant]').count() > 0);
await page.keyboard.press("Escape");
console.log("errors:", errs.size ? [...errs] : "none");
await b.close();
