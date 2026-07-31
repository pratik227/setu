import { chromium } from "@playwright/test";
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(() => localStorage.setItem("setu-session", JSON.stringify({ kind: "readonly", pubkey: "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240" })));
await page.goto("http://localhost:4173/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("article", { timeout: 30000 });
await page.waitForTimeout(9000);
// Count how many <article> elements are replaced over a live window: a memoised
// row keeps its DOM node, an unmemoised one is torn down and rebuilt.
const churn = await page.evaluate(async () => {
  const root = document.querySelector(".setu-feed-column");
  if (!root) return "no feed";
  let added = 0, removed = 0;
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeName === "ARTICLE") added++;
      for (const n of r.removedNodes) if (n.nodeName === "ARTICLE") removed++;
    }
  });
  obs.observe(root, { childList: true, subtree: true });
  await new Promise((r) => setTimeout(r, 15000));
  obs.disconnect();
  return { added, removed, rows: document.querySelectorAll("article").length };
});
console.log("article DOM churn over 15s:", JSON.stringify(churn));
await b.close();
