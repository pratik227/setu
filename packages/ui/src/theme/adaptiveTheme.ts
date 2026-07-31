/**
 * Palette derivation.
 *
 * Give it three or four colors — a background, a foreground, a secondary-text
 * grey, optionally a red — and it derives the whole token set. That is what makes
 * broad theming cheap: a theme is a handful of colors, not a hand-tuned
 * spreadsheet, and every derived surface keeps its correct relative order
 * automatically.
 *
 * The load-bearing idea is that all the steps are taken in **CIE L\*** rather
 * than in relative luminance or raw channel values. L\* is designed to be
 * perceptually uniform, so a fixed step looks equally subtle whether the theme is
 * near-white or near-black. Stepping luminance by a fixed amount instead would
 * read as a gentle recession on a bright theme and a hard band on a dark one, and
 * stepping RGB channels would shift hue as a side effect.
 */

import {
  BLACK,
  contrastingInk,
  labLightness,
  luminanceForLightness,
  mix,
  parseHex,
  type Rgb,
  toTriplet,
  WHITE,
  withLuminance,
} from "./colorMath";

/**
 * How far chrome sits below the reading surface, in L\* units.
 *
 * 2.6 is about the smallest step that still reads as a distinct plane on a
 * calibrated display without becoming a visible seam. Raising it makes the app
 * look striped; lowering it makes the sidebar look like an unpainted gap.
 */
const CHROME_STEP_LSTAR = 2.6;

/** L\* below which we lift chrome instead of sinking it (see `chromeFor`). */
const CHROME_FLOOR_LSTAR = 4;

/** Elevation steps, as a fraction mixed toward the far end of the value range. */
const ELEVATION = {
  /** Cards and inputs: barely distinct from the canvas. */
  subtle: 0.05,
  /** Menus and popovers: must read as floating above content. */
  raised: 0.09,
} as const;

/** How far borders travel from the canvas toward the text color. */
const BORDER_MIX = { dark: 0.16, light: 0.13 } as const;

export interface PaletteSeed {
  /** Content background. */
  readonly background: string;
  /** Primary text. */
  readonly foreground: string;
  /** Secondary text — becomes `--muted-foreground`. */
  readonly comment?: string;
  readonly destructive?: string;
  /** Force dark/light instead of deriving it from the background. */
  readonly dark?: boolean;
}

/** The emitted token set, keyed by CSS custom-property name (no `--` prefix). */
export type ThemeVars = Record<string, string>;

export interface DerivedTheme {
  readonly isDark: boolean;
  readonly vars: ThemeVars;
}

/**
 * The chrome color for a given canvas.
 *
 * Normally one perceptual step *below* the canvas, so navigation reads as being
 * behind the content it navigates to. Near the bottom of the range there is no
 * room left to sink into, so it lifts by the same step instead — otherwise every
 * very dark theme collapses to pure black chrome against near-black content and
 * the boundary disappears entirely.
 */
function chromeFor(canvas: Rgb): Rgb {
  const lightness = labLightness(canvas);
  const target =
    lightness <= CHROME_FLOOR_LSTAR
      ? lightness + CHROME_STEP_LSTAR
      : lightness - CHROME_STEP_LSTAR;
  return withLuminance(canvas, luminanceForLightness(target));
}

/**
 * Derive a full palette from a seed.
 *
 * Returns HSL triplets ready to assign to `:root` custom properties.
 */
export function deriveTheme(seed: PaletteSeed): DerivedTheme {
  const bg = parseHex(seed.background);
  const fg = parseHex(seed.foreground);
  // Midpoint of L\*, not of luminance: 50% luminance is already a light grey, so
  // splitting there misclassifies mid-tone themes as dark.
  const isDark = seed.dark ?? labLightness(bg) < 50;

  const comment = seed.comment
    ? parseHex(seed.comment)
    : mix(bg, fg, isDark ? 0.62 : 0.58);

  const destructive = seed.destructive
    ? parseHex(seed.destructive)
    : parseHex(isDark ? "#f2545b" : "#c8102e");

  // "Elevated" means further from the canvas: toward white on a dark theme,
  // toward black on a light one, so raised always reads as raised.
  const elevate = (amount: number): Rgb =>
    mix(bg, isDark ? WHITE : BLACK, amount);

  const chrome = chromeFor(bg);
  const border = mix(bg, fg, isDark ? BORDER_MIX.dark : BORDER_MIX.light);
  const ink = contrastingInk(fg);

  const vars: ThemeVars = {
    background: toTriplet(bg),
    foreground: toTriplet(fg),
    card: toTriplet(bg),
    "card-foreground": toTriplet(fg),
    popover: toTriplet(elevate(ELEVATION.raised)),
    "popover-foreground": toTriplet(fg),
    muted: toTriplet(elevate(ELEVATION.subtle)),
    "muted-foreground": toTriplet(comment),
    accent: toTriplet(elevate(ELEVATION.subtle)),
    "accent-foreground": toTriplet(fg),
    secondary: toTriplet(elevate(ELEVATION.subtle)),
    "secondary-foreground": toTriplet(fg),
    // Contrast-picked so a filled button's label never washes out against it.
    primary: toTriplet(fg),
    "primary-foreground": toTriplet(ink),
    destructive: toTriplet(destructive),
    "destructive-foreground": toTriplet(contrastingInk(destructive)),
    border: toTriplet(border),
    input: toTriplet(border),
    ring: toTriplet(fg),

    "sidebar-background": toTriplet(chrome),
    "sidebar-foreground": toTriplet(fg),
    "sidebar-primary": toTriplet(fg),
    "sidebar-primary-foreground": toTriplet(ink),
    // Hover on a nav row lands on the *content* canvas, so the row lifts out of
    // the chrome toward the surface it will show.
    "sidebar-accent": toTriplet(bg),
    "sidebar-accent-foreground": toTriplet(fg),
    "sidebar-border": toTriplet(border),
  };

  return { isDark, vars };
}

/** Apply derived vars to an element (normally `document.documentElement`). */
export function applyThemeVars(target: HTMLElement, vars: ThemeVars): void {
  for (const [name, value] of Object.entries(vars)) {
    target.style.setProperty(`--${name}`, value);
  }
}

/** Remove previously applied vars so the stylesheet defaults take over again. */
export function clearThemeVars(target: HTMLElement, vars: ThemeVars): void {
  for (const name of Object.keys(vars)) {
    target.style.removeProperty(`--${name}`);
  }
}
