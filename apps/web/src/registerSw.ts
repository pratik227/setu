/**
 * Registers the offline shell worker (`public/sw.js`).
 *
 * Three guards, each for a real environment:
 *
 *  - **Production builds only.** Under the dev server a worker would cache Vite's
 *    on-the-fly module transforms, and every edit after that would fight a cache
 *    the dev server does not know exists. HMR and service workers do not share a
 *    world view.
 *  - **Feature-checked**, because the desktop shell serves the same bundle over a
 *    custom protocol where service workers may simply not exist — and needs none:
 *    its assets are on disk, which is the property the worker exists to fake.
 *  - **Failure is silence.** Registration failing leaves exactly the behaviour the
 *    app had before the worker existed: online works, offline does not. That is a
 *    degradation, not an error a user can act on, so nothing is thrown or shown.
 *
 * Fired from `main.tsx` after the app mounts rather than awaited before it — the
 * worker helps the *next* launch, and this one must not wait on it.
 */
export function registerOfflineShell(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  try {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // See above: the pre-worker behaviour is the fallback, and it works.
    });
  } catch {
    // Some embedded webviews throw on access rather than lacking the property.
  }
}
