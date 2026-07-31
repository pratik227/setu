/**
 * Theme catalog.
 *
 * A theme is a light seed, a dark seed, and two flags. Because `deriveTheme`
 * generates every surface from those seeds, adding a theme costs three colors.
 *
 * Scaling the catalog is a drop-in later: a syntax-highlighting theme carries
 * exactly the colors `deriveTheme` needs, so importing a Shiki theme's JSON and
 * reading `editor.background` / `editor.foreground` / the `comment` scope turns
 * every one of its ~60 themes into a Setu theme. A curated set ships first to keep
 * that dependency out of the initial build.
 */

import type { PaletteSeed } from "./adaptiveTheme";

export interface ThemeDefinition {
  readonly id: string;
  readonly label: string;
  /**
   * Seeds for each mode. Omit entirely to use the hand-tuned default palette in
   * `tokens.css` with no runtime derivation at all.
   */
  readonly light?: PaletteSeed;
  readonly dark?: PaletteSeed;
  /** Paint the Setu brand gradient behind all chrome. */
  readonly gradient?: boolean;
  /**
   * Neutral-pinned themes hide the accent picker. Over a gradient a saturated
   * accent reads as noise, so the brand look is neutral ink on the ramp.
   */
  readonly pinNeutralAccent?: boolean;
}

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: "setu",
    label: "Setu",
    // No seeds and no gradient: the default look is the hand-tuned neutral
    // palette in tokens.css. The derivation engine is for *other* themes; the
    // house style is worth tuning by hand.
  },
  {
    id: "dawn",
    label: "Dawn",
    // The optional painted canvas: sage-teal into warm sand, neutral ink on top.
    gradient: true,
    pinNeutralAccent: true,
    light: {
      background: "#ffffff",
      foreground: "#1f2328",
      comment: "#59636e",
      destructive: "#cf222e",
    },
    dark: {
      background: "#151019",
      foreground: "#e6e0e9",
      comment: "#9a8fa3",
      destructive: "#f85149",
    },
  },
  {
    id: "github",
    label: "GitHub",
    light: {
      background: "#ffffff",
      foreground: "#1f2328",
      comment: "#59636e",
      destructive: "#cf222e",
    },
    dark: {
      background: "#0d1117",
      foreground: "#e6edf3",
      comment: "#8b949e",
      destructive: "#f85149",
    },
  },
  {
    id: "nord",
    label: "Nord",
    light: {
      background: "#eceff4",
      foreground: "#2e3440",
      comment: "#4c566a",
      destructive: "#bf616a",
    },
    dark: {
      background: "#2e3440",
      foreground: "#d8dee9",
      comment: "#7b88a1",
      destructive: "#bf616a",
    },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    light: {
      background: "#fbf1c7",
      foreground: "#3c3836",
      comment: "#7c6f64",
      destructive: "#9d0006",
    },
    dark: {
      background: "#282828",
      foreground: "#ebdbb2",
      comment: "#928374",
      destructive: "#fb4934",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    light: {
      background: "#e6e7ed",
      foreground: "#343b58",
      comment: "#707280",
      destructive: "#8c4351",
    },
    dark: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      comment: "#565f89",
      destructive: "#f7768e",
    },
  },
  {
    id: "solarized",
    label: "Solarized",
    light: {
      background: "#fdf6e3",
      foreground: "#586e75",
      comment: "#93a1a1",
      destructive: "#dc322f",
    },
    dark: {
      background: "#002b36",
      foreground: "#93a1a1",
      comment: "#657b83",
      destructive: "#dc322f",
    },
  },
];

export const DEFAULT_THEME_ID = "setu";

export function findTheme(id: string): ThemeDefinition {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/**
 * Selectable accent colors. The accent overrides `--primary` and the sidebar
 * active tokens only — it never repaints surfaces, so a bold accent stays a
 * highlight rather than becoming the theme.
 */
export interface AccentDefinition {
  readonly id: string;
  readonly label: string;
  /** `undefined` means "use the theme foreground" (neutral). */
  readonly hex?: string;
}

export const ACCENTS: readonly AccentDefinition[] = [
  // No hex: inherit whatever primary the active theme defines (teal for Setu,
  // neutral ink for the gradient themes).
  { id: "neutral", label: "Theme default" },
  { id: "violet", label: "Violet", hex: "#8b5cf6" },
  { id: "blue", label: "Blue", hex: "#3b82f6" },
  { id: "cyan", label: "Cyan", hex: "#06b6d4" },
  { id: "teal", label: "Teal", hex: "#14b8a6" },
  { id: "green", label: "Green", hex: "#22c55e" },
  { id: "amber", label: "Amber", hex: "#f59e0b" },
  { id: "orange", label: "Orange", hex: "#f97316" },
  { id: "red", label: "Red", hex: "#ef4444" },
  { id: "pink", label: "Pink", hex: "#ec4899" },
];

export const DEFAULT_ACCENT_ID = "neutral";

export function findAccent(id: string): AccentDefinition {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0]!;
}
