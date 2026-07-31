/**
 * Color math for the adaptive theme engine.
 *
 * Everything works in sRGB with WCAG relative luminance, and emits HSL
 * *component triplets* (`"220 23% 95%"`) because that is the shape the token
 * layer consumes via `hsl(var(--token))`.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

/** Parse `#rgb`, `#rrggbb`, or `#rrggbbaa` (alpha ignored). Returns black on junk. */
export function parseHex(hex: string): Rgb {
  const raw = hex.trim().replace(/^#/, "");
  const expanded =
    raw.length === 3 || raw.length === 4
      ? raw
          .slice(0, 3)
          .split("")
          .map((c) => c + c)
          .join("")
      : raw.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return { r: 0, g: 0, b: 0 };
  const n = Number.parseInt(expanded, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  if (delta === 0) return { h: 0, s: 0, l: l * 100 };

  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;

  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = ln - c / 2;

  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  return {
    r: Math.round((rgb[0] + m) * 255),
    g: Math.round((rgb[1] + m) * 255),
    b: Math.round((rgb[2] + m) * 255),
  };
}

/** Format as the HSL component triplet the CSS tokens expect. */
export function toTriplet(input: Rgb | Hsl): string {
  const hsl = "r" in input ? rgbToHsl(input) : input;
  const round = (n: number, p = 2) => Number(n.toFixed(p));
  return `${round(hsl.h)} ${round(hsl.s)}% ${round(hsl.l)}%`;
}

/** Linear mix of two colors in sRGB. `amount` 0 → a, 1 → b. */
export function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = Math.min(1, Math.max(0, amount));
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };
export const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** CIE L\* transfer-function threshold and constants (D65, sRGB). */
const LSTAR_EPSILON = 216 / 24389;
const LSTAR_KAPPA = 24389 / 27;

/**
 * Perceptual lightness (CIE L\*, 0–100) of a color.
 *
 * L\* is designed so equal numeric steps look like equal perceptual steps, which
 * relative luminance emphatically is not — luminance 0.1→0.2 is a large visible
 * jump while 0.8→0.9 is barely perceptible. Any "one step darker" decision should
 * be made here.
 */
export function labLightness(color: Rgb): number {
  const y = luminance(color);
  const f = y > LSTAR_EPSILON ? Math.cbrt(y) : (LSTAR_KAPPA * y + 16) / 116;
  return 116 * f - 16;
}

/** Inverse of {@link labLightness}: the relative luminance for an L\* value. */
export function luminanceForLightness(lightness: number): number {
  const l = Math.min(100, Math.max(0, lightness));
  const f = (l + 16) / 116;
  return f ** 3 > LSTAR_EPSILON ? f ** 3 : (116 * f - 16) / LSTAR_KAPPA;
}

/**
 * Find the nearest color to `base` (same hue and saturation) whose relative
 * luminance matches `targetLum`.
 *
 * Binary search over HSL lightness rather than arithmetic on the channels, so hue
 * and saturation survive the adjustment. 20 iterations resolves finer than 8-bit
 * output can represent.
 */
export function withLuminance(base: Rgb, targetLum: number): Rgb {
  const hsl = rgbToHsl(base);
  const target = Math.min(1, Math.max(0, targetLum));
  let lo = 0;
  let hi = 100;
  let result = base;

  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const candidate = hslToRgb({ ...hsl, l: mid });
    const lum = luminance(candidate);
    result = candidate;
    if (Math.abs(lum - target) < 0.0001) break;
    if (lum < target) lo = mid;
    else hi = mid;
  }
  return result;
}

/** Pick whichever of black/white contrasts better against `bg`. */
export function contrastingInk(bg: Rgb): Rgb {
  return luminance(bg) > 0.45 ? BLACK : WHITE;
}
