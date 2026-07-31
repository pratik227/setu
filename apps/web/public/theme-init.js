/*
 * Applies the saved theme before anything else paints.
 *
 * An external file rather than an inline <script>, so the Content-Security-Policy
 * can be `script-src 'self'` with no `'unsafe-inline'` and no hash to keep in sync.
 * A client that holds a signing key should not permit arbitrary inline script, and
 * a CSP hash that drifts out of date fails closed — a blank page on deploy.
 *
 * Must stay a plain, non-deferred <script> in <head>: it is fetched and executed
 * synchronously before the module bundle, which is the only way to set the
 * background before first paint. Move it to `defer` or `type="module"` and every
 * load flashes the wrong colour.
 */
(() => {
  // Gradient theme ids are duplicated here on purpose: this runs before
  // any module loads, so it cannot import the catalog. Keep in sync with
  // `gradient: true` entries in packages/ui/src/theme/palettes.ts.
  const GRADIENT_THEMES = ["dawn"];
  const FLAT_BG = { light: "#fbfaf9", dark: "#14161a" };
  const GRADIENT_BG = { light: "#e9dcd2", dark: "#1b1420" };
  try {
    const saved = JSON.parse(localStorage.getItem("setu-theme") || "{}");
    const mode = saved.mode || "system";
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    const dark = mode === "dark" || (mode !== "light" && prefersDark);
    const gradient = GRADIENT_THEMES.includes(saved.themeId);

    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    if (gradient) root.dataset.setuGradient = "";
    const bg = gradient ? GRADIENT_BG : FLAT_BG;
    root.style.backgroundColor = dark ? bg.dark : bg.light;
  } catch {}
})();
