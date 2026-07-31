import { useCallback, useMemo, useState } from "react";
import { type Route, sameRoute } from "../features/shell/routes";

const PINNED_KEY = "setu-pinned-hashtags";

function loadPinned(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

function savePinned(tags: readonly string[]): void {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(tags));
  } catch {
    // Storage unavailable: pins last for the session only.
  }
}

export interface Navigation {
  readonly route: Route;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly pinnedHashtags: readonly string[];
  go(route: Route): void;
  back(): void;
  forward(): void;
  pinHashtag(tag: string): void;
  unpinHashtag(tag: string): void;
}

/**
 * In-app history.
 *
 * A cursor into an array rather than the browser's history: the app is a single
 * document with no URLs yet, so `popstate` has nothing to restore from. Keeping
 * our own stack means the back button in the chrome is honest about what it can
 * do, and it swaps for a real router without the call sites changing when the
 * desktop shell needs `nostr:` deep links.
 */
export function useNavigation(initial: Route = { name: "home" }): Navigation {
  const [stack, setStack] = useState<readonly Route[]>([initial]);
  const [index, setIndex] = useState(0);
  const [pinned, setPinned] = useState<readonly string[]>(loadPinned);

  const go = useCallback(
    (route: Route) => {
      setStack((current) => {
        const here = current[index];
        // Re-navigating to where we already are must not grow the stack, or the
        // back button starts undoing nothing.
        if (here && sameRoute(here, route)) return current;
        // Navigating after going back discards the forward entries, matching
        // every browser's behaviour.
        const truncated = current.slice(0, index + 1);
        setIndex(truncated.length);
        return [...truncated, route];
      });
    },
    [index],
  );

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const forward = useCallback(
    () => setIndex((i) => Math.min(stack.length - 1, i + 1)),
    [stack.length],
  );

  const pinHashtag = useCallback((tag: string) => {
    const normalized = tag.toLowerCase().replace(/^#/, "");
    setPinned((current) => {
      if (current.includes(normalized)) return current;
      const next = [...current, normalized];
      savePinned(next);
      return next;
    });
  }, []);

  const unpinHashtag = useCallback((tag: string) => {
    setPinned((current) => {
      const next = current.filter((t) => t !== tag);
      savePinned(next);
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      route: stack[index] ?? initial,
      canGoBack: index > 0,
      canGoForward: index < stack.length - 1,
      pinnedHashtags: pinned,
      go,
      back,
      forward,
      pinHashtag,
      unpinHashtag,
    }),
    [
      stack,
      index,
      initial,
      pinned,
      go,
      back,
      forward,
      pinHashtag,
      unpinHashtag,
    ],
  );
}
