import { chromium } from "@playwright/test";

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(() => {
  localStorage.setItem(
    "setu-session",
    JSON.stringify({
      kind: "readonly",
      pubkey:
        "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240",
    }),
  );
  // Count REQ frames per relay, and remember each filter shape.
  window.__reqs = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (...args) {
    const [data] = args;
    try {
      if (typeof data === "string" && data.startsWith('["REQ"')) {
        const msg = JSON.parse(data);
        window.__reqs.push({
          url: this.url,
          subId: msg[1],
          filters: msg.slice(2),
          t: Date.now(),
        });
      }
      if (typeof data === "string" && data.startsWith('["CLOSE"')) {
        window.__reqs.push({
          url: this.url,
          close: JSON.parse(data)[1],
          t: Date.now(),
        });
      }
    } catch {}
    return send.apply(this, args);
  };
});
await page.goto("http://localhost:4273/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("article", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(14000);

const report = async (label) => {
  const r = await page.evaluate(() => {
    const reqs = window.__reqs.filter((x) => !x.close);
    const closes = window.__reqs.filter((x) => x.close);
    const open = reqs.length - closes.length;
    // Group by filter shape so duplicates are obvious.
    const shapes = {};
    for (const q of reqs) {
      for (const f of q.filters) {
        const shape =
          `kinds=[${(f.kinds || []).join(",")}] ` +
          Object.keys(f)
            .filter((k) => k !== "kinds")
            .map(
              (k) => `${k}=${Array.isArray(f[k]) ? `[${f[k].length}]` : f[k]}`,
            )
            .join(" ");
        shapes[shape] = (shapes[shape] || 0) + 1;
      }
    }
    const noLimit = reqs
      .flatMap((q) => q.filters)
      .filter((f) => f.limit === undefined).length;
    // A filter with no `kinds` is the broadest question we could have asked, and
    // some relays gate or deprioritise it.
    const noKinds = reqs
      .flatMap((q) => q.filters)
      .filter((f) => !f.kinds || f.kinds.length === 0).length;
    const perRelay = {};
    for (const q of reqs) {
      perRelay[q.url] = (perRelay[q.url] || 0) + 1;
    }
    // Open subscriptions *per relay* is the number a relay caps, so it is the one
    // that decides whether a relay quietly stops answering.
    const openPerRelay = {};
    for (const q of reqs) {
      openPerRelay[q.url] = (openPerRelay[q.url] || 0) + 1;
    }
    for (const c of closes) {
      openPerRelay[c.url] = (openPerRelay[c.url] || 0) - 1;
    }
    return {
      totalReq: reqs.length,
      closes: closes.length,
      open,
      shapes,
      noLimit,
      noKinds,
      perRelay,
      openPerRelay,
    };
  });
  console.log(`\n===== ${label}`);
  console.log(
    `REQ frames sent: ${r.totalReq}   CLOSEs: ${r.closes}   still open: ${r.open}`,
  );
  console.log(
    `filters with NO limit: ${r.noLimit}   filters with NO kinds: ${r.noKinds}`,
  );
  console.log("per relay:", JSON.stringify(r.perRelay));
  console.log("open per relay:", JSON.stringify(r.openPerRelay));
  console.log("filter shapes (count × shape):");
  for (const [shape, n] of Object.entries(r.shapes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)) {
    console.log(`  ${String(n).padStart(3)} × ${shape}`);
  }
};
await report("HOME only, 14s");

// Open a thread — does it duplicate the interaction/bookmark subscriptions?
await page
  .locator("article")
  .first()
  .locator("div.whitespace-pre-wrap")
  .click()
  .catch(() => {});
await page.waitForTimeout(9000);
await report("HOME + THREAD open");

// And a profile on top, because the ceiling that matters is every surface a reader
// can have open at once: relays cap concurrent subscriptions, and a relay at its
// cap stops answering instead of complaining.
await page
  .locator('article button[aria-label^="Open "]')
  .first()
  .click()
  .catch(() => {});
await page.waitForTimeout(9000);
await report("HOME + THREAD + PROFILE open");
await b.close();
