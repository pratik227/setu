import { describe, expect, it } from "vitest";
import { deriveTheme } from "./adaptiveTheme";
import { labLightness, luminance, parseHex } from "./colorMath";

/** Parse an emitted HSL triplet back to an approximate L\* for assertions. */
function lightnessOfTriplet(triplet: string): number {
  const [h, s, l] = triplet.split(" ");
  const hue = Number.parseFloat(h ?? "0");
  const sat = Number.parseFloat((s ?? "0").replace("%", ""));
  const lig = Number.parseFloat((l ?? "0").replace("%", ""));
  // Round-trip through the same HSL→RGB path the browser will use.
  const c = (1 - Math.abs((2 * lig) / 100 - 1)) * (sat / 100);
  const hp = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = lig / 100 - c / 2;
  const parts: [number, number, number] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  return labLightness({
    r: Math.round((parts[0] + m) * 255),
    g: Math.round((parts[1] + m) * 255),
    b: Math.round((parts[2] + m) * 255),
  });
}

describe("deriveTheme", () => {
  it("classifies dark and light seeds by perceptual lightness", () => {
    expect(
      deriveTheme({ background: "#0d1117", foreground: "#e6edf3" }).isDark,
    ).toBe(true);
    expect(
      deriveTheme({ background: "#ffffff", foreground: "#1f2328" }).isDark,
    ).toBe(false);
    // A mid-tone background: luminance 0.5 is already a light grey, so splitting
    // on luminance would misread this as dark. L* puts it correctly on the light
    // side of the boundary.
    expect(
      deriveTheme({ background: "#8a8a8a", foreground: "#111111" }).isDark,
    ).toBe(false);
  });

  it("steps chrome by a consistent perceptual amount at every brightness", () => {
    const seeds = [
      { background: "#ffffff", foreground: "#1f2328" },
      { background: "#eceff4", foreground: "#2e3440" },
      { background: "#8a8a8a", foreground: "#111111" },
      { background: "#282828", foreground: "#ebdbb2" },
      { background: "#0d1117", foreground: "#e6edf3" },
    ];

    const deltas = seeds.map((seed) => {
      const { vars } = deriveTheme(seed);
      const canvas = labLightness(parseHex(seed.background));
      const chrome = lightnessOfTriplet(vars["sidebar-background"]!);
      return Math.abs(canvas - chrome);
    });

    // Every step lands near the same L* delta. This is the property that a
    // luminance-based step does not have: there, the spread across this range of
    // seeds is several-fold.
    for (const delta of deltas) {
      expect(delta).toBeGreaterThan(1.5);
      expect(delta).toBeLessThan(4);
    }
  });

  it("lifts chrome instead of sinking it on a near-black canvas", () => {
    // There is no room below near-black: sinking would clamp to pure black and
    // erase the boundary between chrome and content.
    const { vars } = deriveTheme({
      background: "#010101",
      foreground: "#f0f0f0",
    });
    const chrome = lightnessOfTriplet(vars["sidebar-background"]!);
    expect(chrome).toBeGreaterThan(labLightness(parseHex("#010101")));
  });

  it("keeps raised surfaces further from the canvas than subtle ones", () => {
    for (const seed of [
      { background: "#ffffff", foreground: "#1f2328" },
      { background: "#0d1117", foreground: "#e6edf3" },
    ]) {
      const { vars } = deriveTheme(seed);
      const canvas = labLightness(parseHex(seed.background));
      const muted = Math.abs(canvas - lightnessOfTriplet(vars.muted!));
      const popover = Math.abs(canvas - lightnessOfTriplet(vars.popover!));
      expect(popover).toBeGreaterThan(muted);
    }
  });

  it("picks a button label color that contrasts with the fill", () => {
    // A filled button uses the foreground as its fill, so its label must be the
    // opposite ink or it washes out.
    const dark = deriveTheme({ background: "#0d1117", foreground: "#e6edf3" });
    const light = deriveTheme({ background: "#ffffff", foreground: "#1f2328" });
    // Light foreground (dark theme) → dark label; dark foreground → light label.
    expect(lightnessOfTriplet(dark.vars["primary-foreground"]!)).toBeLessThan(
      50,
    );
    expect(
      lightnessOfTriplet(light.vars["primary-foreground"]!),
    ).toBeGreaterThan(50);
  });

  it("emits every token the stylesheet expects", () => {
    const { vars } = deriveTheme({
      background: "#0d1117",
      foreground: "#e6edf3",
    });
    for (const token of [
      "background",
      "foreground",
      "card",
      "popover",
      "primary",
      "primary-foreground",
      "muted",
      "muted-foreground",
      "accent",
      "destructive",
      "border",
      "input",
      "ring",
      "sidebar-background",
      "sidebar-accent",
      "sidebar-border",
    ]) {
      expect(vars[token], token).toMatch(/^[\d.]+ [\d.]+% [\d.]+%$/);
    }
  });

  it("derives a usable secondary text color when the seed omits one", () => {
    const { vars } = deriveTheme({
      background: "#ffffff",
      foreground: "#000000",
    });
    const muted = lightnessOfTriplet(vars["muted-foreground"]!);
    // Between the canvas and the primary text, not equal to either.
    expect(muted).toBeGreaterThan(10);
    expect(muted).toBeLessThan(90);
  });

  it("is deterministic", () => {
    const seed = { background: "#282828", foreground: "#ebdbb2" };
    expect(deriveTheme(seed).vars).toEqual(deriveTheme(seed).vars);
  });
});

describe("labLightness", () => {
  it("spans 0 to 100 for black to white", () => {
    expect(labLightness({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(labLightness({ r: 255, g: 255, b: 255 })).toBeCloseTo(100, 5);
  });

  it("puts mid-grey near L* 50 where luminance puts it near 0.2", () => {
    const midGrey = parseHex("#777777");
    expect(labLightness(midGrey)).toBeGreaterThan(45);
    expect(labLightness(midGrey)).toBeLessThan(55);
    // The contrast with relative luminance is the whole reason L* is used here.
    expect(luminance(midGrey)).toBeLessThan(0.25);
  });
});
