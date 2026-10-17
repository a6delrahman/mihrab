// Extracts Mihrab's palette from a reference image and writes
// apps/web/src/styles/mihrab-theme.css.
//
//   pnpm mihrab:palette [image-url]
//
// The image's pixels are clustered in OKLab (perceptual distance), six roles
// are picked from the clusters by lightness, chroma and hue, and the UI
// tokens are derived from them with WCAG contrast enforced in light and dark
// mode. The raw extracted colours are kept as --mihrab-palette-* so the
// derivation can be audited.
import jpeg from "jpeg-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REFERENCE_URL =
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRx10aMjfQS9aM0u8SnEEFbBz1qGvDDkO6ErJMAiXPS2FOhPqmk0MdXVOM-&s=10";
// Dark mode takes its colours from a second image: a blue tiled mihrab.
export const DARK_REFERENCE = "docs/assets/mihrab-palette-dark.jpg";
const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/web/src/styles/mihrab-theme.css",
);

// ---------- colour math (sRGB <-> OKLab <-> OKLCH) ----------
export type Lab = [number, number, number];
type Rgb = [number, number, number];
const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toGamma = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
export function rgbToOklab([r8, g8, b8]: Rgb): Lab {
  const [r, g, b] = [r8, g8, b8].map((c) => toLinear(c / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
export function oklabToRgb([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((c) =>
    Math.round(Math.min(1, Math.max(0, toGamma(c))) * 255),
  ) as Rgb;
}
const chroma = ([, a, b]: Lab) => Math.hypot(a, b);
const hue = ([, a, b]: Lab) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
const fromLch = (L: number, C: number, h: number): Lab => [
  L,
  C * Math.cos((h * Math.PI) / 180),
  C * Math.sin((h * Math.PI) / 180),
];
export const hex = (lab: Lab) =>
  "#" +
  oklabToRgb(lab)
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("");
function luminance(lab: Lab) {
  const [r, g, b] = oklabToRgb(lab).map((c) => toLinear(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(x: Lab, y: Lab) {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}
// Moves a colour's lightness (keeping hue and, as far as sRGB allows,
// chroma) until it reaches the contrast ratio against a background.
export function ensureContrast(fg: Lab, bg: Lab, ratio: number): Lab {
  if (contrast(fg, bg) >= ratio) return fg;
  const darker = luminance(bg) > 0.18,
    C = chroma(fg),
    h = hue(fg);
  for (let L = fg[0]; L >= 0 && L <= 1; L += darker ? -0.005 : 0.005) {
    const c = rgbToOklab(oklabToRgb(fromLch(L, C, h)));
    if (contrast(c, bg) >= ratio) return c;
  }
  return darker ? [0, 0, 0] : [1, 0, 0];
}
const withL = (lab: Lab, L: number, scaleC = 1): Lab =>
  rgbToOklab(oklabToRgb(fromLch(L, chroma(lab) * scaleC, hue(lab))));

// ---------- clustering ----------
export type Cluster = { lab: Lab; weight: number };
const dist = (p: Lab, q: Lab) =>
  (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
// k-means with k-means++ seeding from a fixed-seed PRNG, so the same image
// always gives the same palette.
export function kmeans(points: Lab[], k: number, iterations = 30): Cluster[] {
  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 2 ** 32;
  };
  const centers: Lab[] = [points[Math.floor(rand() * points.length)]];
  const d2 = points.map((p) => dist(p, centers[0]));
  while (centers.length < k) {
    const total = d2.reduce((s, d) => s + d, 0);
    let r = rand() * total,
      i = 0;
    while (r > d2[i] && i < points.length - 1) r -= d2[i++];
    centers.push(points[i]);
    for (let j = 0; j < points.length; j++)
      d2[j] = Math.min(d2[j], dist(points[j], points[i]));
  }
  const assign = new Int32Array(points.length);
  for (let it = 0; it < iterations; it++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let j = 0; j < points.length; j++) {
      let best = 0,
        bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist(points[j], centers[c]);
        if (d < bestD) [best, bestD] = [c, d];
      }
      assign[j] = best;
      const s = sums[best];
      s[0] += points[j][0];
      s[1] += points[j][1];
      s[2] += points[j][2];
      s[3]++;
    }
    for (let c = 0; c < k; c++)
      if (sums[c][3])
        centers[c] = [
          sums[c][0] / sums[c][3],
          sums[c][1] / sums[c][3],
          sums[c][2] / sums[c][3],
        ];
  }
  const counts = new Array(k).fill(0);
  for (const a of assign) counts[a]++;
  return centers
    .map((lab, c) => ({ lab, weight: counts[c] / points.length }))
    .filter((c) => c.weight > 0.004)
    .sort((x, y) => y.weight - x.weight);
}

// ---------- role assignment ----------
export type Roles = {
  primary: Lab; // Primary Deep Tone
  secondary: Lab; // Secondary Rich Tone
  accent: Lab; // Warm Accent / Highlight
  parchment: Lab; // Light Background / Parchment
  dark: Lab; // Dark Surface
  border: Lab; // Muted Border
};
const hueGap = (x: number, y: number) => {
  const d = Math.abs(x - y) % 360;
  return d > 180 ? 360 - d : d;
};
export function assignRoles(clusters: Cluster[]): Roles {
  const pool = [...clusters];
  const take = (score: (c: Cluster) => number) => {
    const best = pool.reduce((a, b) => (score(b) > score(a) ? b : a));
    pool.splice(pool.indexOf(best), 1);
    return best.lab;
  };
  // Light, quiet and plentiful: the stone the image is built from.
  const parchment = take(
    (c) => c.lab[0] * 2 - chroma(c.lab) * 6 + Math.sqrt(c.weight),
  );
  // A deep colour with some colour left in it (the cedar wood, not the
  // near-black of a shadow).
  const dark = take(
    (c) =>
      -Math.abs(c.lab[0] - 0.2) * 3 +
      chroma(c.lab) * 3 +
      Math.sqrt(c.weight) * 0.5,
  );
  // Warm (orange-gold hues, OKLCH 35-105 degrees), saturated and light
  // enough to read as a highlight.
  const warm = (c: Cluster) => hueGap(hue(c.lab), 70) <= 35;
  const accent = take(
    (c) =>
      (warm(c) ? 1 : 0) +
      chroma(c.lab) * 4 +
      (c.lab[0] > 0.55 && c.lab[0] < 0.85 ? 0.3 : 0),
  );
  // The most saturated deep colour that is not warm: the image's signature.
  const primary = take(
    (c) =>
      chroma(c.lab) * 5 +
      (c.lab[0] < 0.7 ? 0.4 : 0) +
      (hueGap(hue(c.lab), hue(accent)) > 60 ? 0.5 : 0) +
      Math.sqrt(c.weight) * 0.5,
  );
  // A second rich tone, away from both the primary's and the accent's hue.
  const secondary = take(
    (c) =>
      chroma(c.lab) * 4 +
      Math.min(hueGap(hue(c.lab), hue(primary)), 90) / 90 +
      Math.min(hueGap(hue(c.lab), hue(accent)), 90) / 90 +
      (c.lab[0] < 0.7 ? 0.3 : 0),
  );
  // Mid-light and quiet: a border between parchment and ink.
  const border = take(
    (c) => -Math.abs(c.lab[0] - 0.75) * 2 - chroma(c.lab) * 4 + c.weight,
  );
  return { primary, secondary, accent, parchment, dark, border };
}

// ---------- token derivation ----------
export function deriveTokens(r: Roles) {
  const paper = withL(r.parchment, Math.max(r.parchment[0], 0.95), 0.6);
  const light = {
    bg: paper,
    surface: withL(r.parchment, Math.min(0.99, paper[0] + 0.025), 0.35),
    "surface-sunken": withL(r.parchment, paper[0] - 0.035, 0.9),
    primary: ensureContrast(r.primary, paper, 4.5),
    secondary: ensureContrast(r.secondary, paper, 4.5),
    accent: ensureContrast(r.accent, paper, 3),
    "accent-soft": withL(r.accent, 0.9, 0.45),
    "primary-soft": withL(r.primary, 0.93, 0.35),
    text: ensureContrast(withL(r.dark, 0.25), paper, 7),
    muted: ensureContrast(withL(r.border, 0.5, 1.2), paper, 4.5),
    border: withL(r.border, Math.min(0.87, paper[0] - 0.09), 0.6),
    "dark-surface": r.dark,
  };
  const night = withL(r.dark, Math.min(r.dark[0], 0.2), 0.8);
  const dark = {
    bg: night,
    surface: withL(r.dark, night[0] + 0.045, 0.8),
    "surface-sunken": withL(r.dark, night[0] - 0.03, 0.8),
    primary: ensureContrast(withL(r.primary, 0.78), night, 4.5),
    secondary: ensureContrast(withL(r.secondary, 0.78), night, 4.5),
    accent: ensureContrast(withL(r.accent, 0.8), night, 4.5),
    "accent-soft": withL(r.accent, night[0] + 0.1, 0.5),
    "primary-soft": withL(r.primary, night[0] + 0.1, 0.5),
    text: ensureContrast(withL(r.parchment, 0.94, 0.6), night, 7),
    muted: ensureContrast(withL(r.border, 0.72), night, 4.5),
    border: withL(r.dark, night[0] + 0.12, 0.6),
    "dark-surface": withL(r.dark, Math.max(0.12, night[0] - 0.06), 0.8),
  };
  return { light, dark };
}

// ---------- dark mode from its own image ----------
export type DarkRoles = {
  night: Lab; // the deepest blue: page background
  primary: Lab; // the brightest saturated tile colour
  secondary: Lab; // a deeper saturated tone
  accent: Lab; // warm highlight (gold calligraphy)
  pale: Lab; // light, quiet: muted text
};
export function assignDarkRoles(clusters: Cluster[]): DarkRoles {
  const pool = [...clusters];
  const take = (score: (c: Cluster) => number) => {
    const best = pool.reduce((a, b) => (score(b) > score(a) ? b : a));
    pool.splice(pool.indexOf(best), 1);
    return best.lab;
  };
  const night = take((c) => (chroma(c.lab) >= 0.03 ? 1 : 0) - c.lab[0] * 2);
  const near = (c: Cluster) => hueGap(hue(c.lab), hue(night)) < 70;
  const primary = take((c) => (near(c) ? 1 : 0) + chroma(c.lab) * 4 + c.lab[0]);
  // A second blue, away from the primary's hue (lapis next to turquoise).
  const secondary = take(
    (c) => (near(c) ? 1 : 0) + chroma(c.lab) * 5 + Math.min(hueGap(hue(c.lab), hue(primary)), 30) / 30,
  );
  const accent = take((c) => (hueGap(hue(c.lab), 80) <= 40 ? 1 : 0) + chroma(c.lab) * 4 + c.lab[0] * 0.5);
  const pale = take((c) => c.lab[0] * 2 - chroma(c.lab) * 6 + (near(c) ? 0.3 : 0));
  return { night, primary, secondary, accent, pale };
}
// Gold reads as gold only with some chroma; photographs of thin
// calligraphy average it towards beige.
const atLeastChroma = (lab: Lab, c: number) => fromLch(lab[0], Math.max(chroma(lab), c), hue(lab));
// A tint: `share` of a colour laid over a background, mixed in OKLab.
const mix = (bg: Lab, fg: Lab, share: number): Lab =>
  rgbToOklab(oklabToRgb([0, 1, 2].map((i) => bg[i] + (fg[i] - bg[i]) * share) as Lab));
export function deriveDarkTokens(r: DarkRoles) {
  const h = hue(r.night);
  const night = rgbToOklab(oklabToRgb(fromLch(0.2, Math.min(chroma(r.night), 0.07), h)));
  const tone = (L: number, C: number) => rgbToOklab(oklabToRgb(fromLch(L, C, h)));
  const gold = atLeastChroma(r.accent, 0.11);
  const surface = tone(0.245, 0.065);
  const primary = ensureContrast(withL(r.primary, 0.78), night, 4.5);
  const accent = ensureContrast(withL(gold, 0.82), night, 4.5);
  return {
    bg: night,
    surface,
    "surface-sunken": tone(0.17, 0.06),
    primary,
    secondary: ensureContrast(withL(r.secondary, 0.76, 1.2), night, 4.5),
    accent,
    "accent-soft": mix(surface, accent, 0.16),
    "primary-soft": mix(surface, primary, 0.18),
    text: ensureContrast(tone(0.95, 0.015), night, 7),
    muted: ensureContrast(withL(r.pale, 0.78), night, 4.5),
    border: tone(0.33, 0.06),
    "dark-surface": tone(0.14, 0.05),
  };
}

export function renderCss(opts: {
  roles: Roles;
  darkRoles?: DarkRoles;
  tokens: { light: Record<string, Lab>; dark: Record<string, Lab> };
  sources: { light: string; dark?: string };
}) {
  const { roles, darkRoles, tokens } = opts;
  const block = (t: Record<string, Lab>) =>
    Object.entries(t)
      .map(([k, v]) => `  --mihrab-${k}: ${hex(v)};`)
      .join("\n");
  const rows = (prefix: string, r: Record<string, Lab>) =>
    Object.entries(r)
      .map(([k, v]) => `  --mihrab-${prefix}-${k}: ${hex(v)};`)
      .join("\n");
  const ratio = (t: Record<string, Lab>, k: string) => contrast(t[k], t.bg).toFixed(1);
  return `/* Generated by scripts/extract_palette.ts — do not edit by hand.
 * Light mode: ${opts.sources.light}
 * Dark mode: ${opts.sources.dark || "derived from the light image"}
 * Contrast on --mihrab-bg (WCAG): light text ${ratio(tokens.light, "text")}:1,
 * primary ${ratio(tokens.light, "primary")}:1, muted ${ratio(tokens.light, "muted")}:1;
 * dark text ${ratio(tokens.dark, "text")}:1, primary ${ratio(tokens.dark, "primary")}:1,
 * accent ${ratio(tokens.dark, "accent")}:1, muted ${ratio(tokens.dark, "muted")}:1. */
:root {
  /* The dominant colours, as extracted. */
${rows("palette", roles)}
${darkRoles ? rows("palette-dark", darkRoles) + "\n" : ""}
  /* Light mode (default). */
${block(tokens.light)}

  --mihrab-font-arabic: "Amiri", "Scheherazade New", "Noto Naskh Arabic", serif;
  --mihrab-font-ui: "Plus Jakarta Sans", "Inter", system-ui, sans-serif;
  --mihrab-font-reading: "Noto Serif", "Source Serif 4", Georgia, serif;
  --mihrab-font-mono: "JetBrains Mono", ui-monospace, monospace;
  --mihrab-arabic-line-height: 1.9;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-mihrab-theme="light"]) {
${block(tokens.dark).replaceAll("\n", "\n  ").replace(/^/, "  ")}
    color-scheme: dark;
  }
}
:root[data-mihrab-theme="dark"] {
${block(tokens.dark)}
  color-scheme: dark;
}
`;
}

// A JPEG from a URL or a file in the repository.
async function loadJpeg(src: string) {
  let buf: Buffer;
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { headers: { "user-agent": "Mihrab/1.0" } });
    if (!res.ok) throw new Error(`Image request failed: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else buf = await readFile(resolve(dirname(OUT), "../../../..", src));
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) throw new Error(`Expected a JPEG image: ${src}`);
  return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
}
export async function clustersOf(src: string, k = 12) {
  const img = await loadJpeg(src);
  const points: Lab[] = [];
  // Every other pixel in each direction is plenty for a palette.
  for (let y = 0; y < img.height; y += 2)
    for (let x = 0; x < img.width; x += 2) {
      const i = (y * img.width + x) * 4;
      points.push(rgbToOklab([img.data[i], img.data[i + 1], img.data[i + 2]]));
    }
  return kmeans(points, k);
}
export async function extractPalette(light: string, dark?: string) {
  const clusters = await clustersOf(light);
  const roles = assignRoles(clusters);
  const tokens = deriveTokens(roles);
  if (!dark) return { clusters, roles, tokens };
  const darkClusters = await clustersOf(dark, 14);
  const darkRoles = assignDarkRoles(darkClusters);
  return { clusters, roles, darkClusters, darkRoles, tokens: { ...tokens, dark: deriveDarkTokens(darkRoles) } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--dark");
  const dark = at >= 0 ? args[at + 1] : DARK_REFERENCE;
  const light = args.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1)) || REFERENCE_URL;
  const r = await extractPalette(light, dark);
  const show = (label: string, cs: Cluster[]) => {
    console.log(`${label} clusters (by share of pixels):`);
    for (const c of cs)
      console.log(`  ${hex(c.lab)}  ${(c.weight * 100).toFixed(1).padStart(5)}%  L=${c.lab[0].toFixed(2)} C=${chroma(c.lab).toFixed(3)} h=${hue(c.lab).toFixed(0)}`);
  };
  show("Light", r.clusters);
  console.log("Light roles:", Object.fromEntries(Object.entries(r.roles).map(([k, v]) => [k, hex(v)])));
  if (r.darkClusters && r.darkRoles) {
    show("Dark", r.darkClusters);
    console.log("Dark roles:", Object.fromEntries(Object.entries(r.darkRoles).map(([k, v]) => [k, hex(v)])));
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, renderCss({ roles: r.roles, darkRoles: r.darkRoles, tokens: r.tokens, sources: { light, dark } }));
  console.log(`Wrote ${OUT}`);
}
