/**
 * Theme state: mode (light/dark/system), theme id, accent id.
 *
 * Applies everything as inline custom properties on `<html>` and mirrors the
 * choice to `localStorage` under the same key the anti-FOUC boot script reads,
 * so a reload paints the right background on the very first frame.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { applyThemeVars, deriveTheme } from "./adaptiveTheme";
import { contrastingInk, parseHex, toTriplet } from "./colorMath";
import {
  DEFAULT_ACCENT_ID,
  DEFAULT_THEME_ID,
  findAccent,
  findTheme,
  type ThemeDefinition,
} from "./palettes";

export type ThemeMode = "light" | "dark" | "system";

/** Must match the key read by the boot script in `index.html`. */
const STORAGE_KEY = "setu-theme";

interface PersistedTheme {
  mode: ThemeMode;
  themeId: string;
  accentId: string;
}

interface ThemeContextValue extends PersistedTheme {
  /** Resolved appearance after applying `system`. */
  readonly isDark: boolean;
  readonly theme: ThemeDefinition;
  setMode(mode: ThemeMode): void;
  setThemeId(id: string): void;
  setAccentId(id: string): void;
  /**
   * Apply several appearance values at once.
   *
   * Exists for updates that arrive from outside the UI — settings restored from
   * another device, in Setu's case. Doing that through the three setters is not
   * equivalent: each one is its own state update and its own persist, so a reader
   * sees the new theme against the old accent for a frame, and an interrupted
   * sequence leaves a half-applied appearance in `localStorage` that the next
   * reload paints. One update, one write.
   */
  setAppearance(next: Partial<PersistedTheme>): void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readPersisted(): PersistedTheme {
  const fallback: PersistedTheme = {
    mode: "system",
    themeId: DEFAULT_THEME_ID,
    accentId: DEFAULT_ACCENT_ID,
  };
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<PersistedTheme>) };
  } catch {
    return fallback;
  }
}

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PersistedTheme>(readPersisted);
  const [systemDark, setSystemDark] = useState(prefersDark);

  // Track the OS preference only while mode is "system" — but subscribe
  // unconditionally, because switching back to "system" must already know.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const isDark = state.mode === "system" ? systemDark : state.mode === "dark";
  const theme = useMemo(() => findTheme(state.themeId), [state.themeId]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;

    root.classList.toggle("dark", isDark);

    if (theme.gradient) root.dataset.setuGradient = "";
    else delete root.dataset.setuGradient;

    // Derive and apply the palette. A theme with no seed for this mode falls
    // back to the stylesheet tokens, so clear any previously applied vars
    // first — otherwise switching from a seeded theme leaves its values behind.
    const seed = isDark ? theme.dark : theme.light;
    const previous = root.getAttribute("data-setu-applied-vars");
    if (previous) {
      for (const name of previous.split(",")) root.style.removeProperty(name);
      root.removeAttribute("data-setu-applied-vars");
    }

    if (seed) {
      const derived = deriveTheme({ ...seed, dark: isDark });
      applyThemeVars(root, derived.vars);
      root.setAttribute(
        "data-setu-applied-vars",
        Object.keys(derived.vars)
          .map((n) => `--${n}`)
          .join(","),
      );
    }

    // Accent last so it wins over the derived primary.
    const accent = theme.pinNeutralAccent
      ? findAccent("neutral")
      : findAccent(state.accentId);
    if (accent.hex) {
      const rgb = parseHex(accent.hex);
      const triplet = toTriplet(rgb);
      const ink = toTriplet(contrastingInk(rgb));
      root.style.setProperty("--primary", triplet);
      root.style.setProperty("--primary-foreground", ink);
      root.style.setProperty("--sidebar-primary", triplet);
      root.style.setProperty("--sidebar-primary-foreground", ink);
    }

    root.style.backgroundColor = "";
  }, [isDark, theme, state.accentId]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Private-mode / disabled storage: theming still works, just not sticky.
    }
  }, [state]);

  const setMode = useCallback(
    (mode: ThemeMode) => setState((s) => ({ ...s, mode })),
    [],
  );
  const setThemeId = useCallback(
    (themeId: string) => setState((s) => ({ ...s, themeId })),
    [],
  );
  const setAccentId = useCallback(
    (accentId: string) => setState((s) => ({ ...s, accentId })),
    [],
  );

  const setAppearance = useCallback(
    (next: Partial<PersistedTheme>) =>
      setState((s) => {
        // Bail out when nothing differs, so an external synchroniser confirming
        // that the stored appearance already matches does not re-render the tree
        // or rewrite `localStorage` on every check.
        const merged = { ...s, ...next };
        return merged.mode === s.mode &&
          merged.themeId === s.themeId &&
          merged.accentId === s.accentId
          ? s
          : merged;
      }),
    [],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      ...state,
      isDark,
      theme,
      setMode,
      setThemeId,
      setAccentId,
      setAppearance,
    }),
    [state, isDark, theme, setMode, setThemeId, setAccentId, setAppearance],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
