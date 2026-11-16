/**
 * The visual template every rebuilt slide is drawn on.
 *
 * The artwork is vector, not a bitmap, for two reasons: it stays sharp at any
 * export size, and it can be tuned without shipping an asset. It is also
 * deliberately isolated in this module, so swapping it for the final design
 * means touching one file.
 */

type CanvasModule = typeof import("@napi-rs/canvas");
type RasterContext = import("@napi-rs/canvas").SKRSContext2D;

/** Base design size: every metric below is expressed in these pixels. */
export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;

export const COLORS = {
  paper: "#ffffff",
  navy: "#1b3c5f",
  blue: "#3d78bd",
  steel: "#2f6ba8",
  lightBlue: "#aecbe8",
  paleBlue: "#d7e5f4",
  orange: "#e07b2a",
  ink: "#1d3348",
  muted: "#5a7186",
  faint: "#8fa6ba",
  panel: "#f3f8fd",
  panelBorder: "#d5e3f1",
  code: "#15344f",
  codeText: "#e8f1f9",
  white: "#ffffff",
} as const;

export const FONTS = {
  sans: "Segoe UI",
  mono: "Consolas",
};

/** Picks a font that exists on the machine running the renderer. */
export function resolveFonts(canvas: CanvasModule): void {
  const available = new Set(canvas.GlobalFonts.families.map((entry) => entry.family));
  const pick = (candidates: string[], fallback: string): string =>
    candidates.find((candidate) => available.has(candidate)) ?? fallback;

  FONTS.sans = pick(
    ["Segoe UI", "Arial", "Helvetica Neue", "Helvetica", "DejaVu Sans", "Liberation Sans"],
    "sans-serif",
  );
  FONTS.mono = pick(
    ["Consolas", "Cascadia Mono", "Courier New", "DejaVu Sans Mono", "Liberation Mono"],
    "monospace",
  );
}

/** Catmull-Rom through the given points, closed: an organic blob. */
function blob(context: RasterContext, points: [number, number][]): void {
  const count = points.length;
  const at = (index: number): [number, number] => points[((index % count) + count) % count];

  context.beginPath();
  context.moveTo(points[0][0], points[0][1]);

  for (let i = 0; i < count; i += 1) {
    const [x0, y0] = at(i - 1);
    const [x1, y1] = at(i);
    const [x2, y2] = at(i + 1);
    const [x3, y3] = at(i + 2);

    context.bezierCurveTo(
      x1 + (x2 - x0) / 6,
      y1 + (y2 - y0) / 6,
      x2 - (x3 - x1) / 6,
      y2 - (y3 - y1) / 6,
      x2,
      y2,
    );
  }

  context.closePath();
}

function fillBlob(context: RasterContext, color: string, points: [number, number][]): void {
  context.save();
  context.fillStyle = color;
  blob(context, points);
  context.fill();
  context.restore();
}

function dot(context: RasterContext, x: number, y: number, radius: number, color: string): void {
  context.save();
  context.fillStyle = color;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.restore();
}


/**
 * The watercolour frame of the template: white paper, four corner clusters in
 * three blues, a warm accent at the bottom right.
 *
 * Nothing is drawn inside the safe area, which starts at y = 200 and ends at
 * y = 1000, so the laid-out text never sits on top of the artwork.
 */
export function drawSlideBackground(context: RasterContext): void {
  context.save();
  context.fillStyle = COLORS.paper;
  context.fillRect(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT);

  // Top left: the wide pale shape the navy and blue waves sit on.
  fillBlob(context, COLORS.paleBlue, [
    [-60, -60],
    [520, -50],
    [700, 35],
    [610, 120],
    [420, 170],
    [190, 196],
    [-60, 180],
  ]);
  fillBlob(context, COLORS.lightBlue, [
    [-60, -60],
    [430, -45],
    [600, 20],
    [520, 80],
    [330, 125],
    [120, 145],
    [-60, 136],
  ]);
  fillBlob(context, COLORS.blue, [
    [-60, -60],
    [1010, -50],
    [960, 10],
    [800, 55],
    [560, 80],
    [300, 78],
    [80, 40],
    [-60, 5],
  ]);
  fillBlob(context, COLORS.navy, [
    [-60, -60],
    [1180, -60],
    [1120, -10],
    [930, 25],
    [690, 42],
    [430, 35],
    [180, 10],
    [-60, -25],
  ]);
  // Top right: navy mass with a pale crescent over it.
  fillBlob(context, COLORS.navy, [
    [1980, -60],
    [1300, -55],
    [1330, 20],
    [1420, 90],
    [1580, 130],
    [1760, 145],
    [1980, 150],
  ]);
  fillBlob(context, COLORS.steel, [
    [1980, 140],
    [1760, 135],
    [1600, 115],
    [1480, 75],
    [1420, 20],
    [1400, -55],
    [1560, -50],
    [1980, -50],
  ]);
  fillBlob(context, COLORS.lightBlue, [
    [1980, 60],
    [1810, 55],
    [1700, 30],
    [1650, -10],
    [1660, -55],
    [1980, -55],
  ]);
  dot(context, 1832, 1002, 48, COLORS.steel);
  dot(context, 1772, 1046, 15, COLORS.blue);


  // Bottom left: pale wave climbing the edge with a navy swell underneath.
  fillBlob(context, COLORS.paleBlue, [
    [-60, 1080],
    [-60, 690],
    [90, 700],
    [190, 760],
    [240, 860],
    [270, 960],
    [320, 1040],
    [420, 1080],
  ]);
  fillBlob(context, COLORS.lightBlue, [
    [-60, 1080],
    [-60, 760],
    [60, 775],
    [140, 830],
    [180, 920],
    [210, 1010],
    [250, 1080],
  ]);
  fillBlob(context, COLORS.navy, [
    [-60, 1080],
    [-60, 940],
    [70, 955],
    [150, 1000],
    [230, 1050],
    [300, 1080],
  ]);
  fillBlob(context, COLORS.steel, [
    [120, 1080],
    [170, 1020],
    [240, 1000],
    [300, 1030],
    [340, 1080],
  ]);
  dot(context, 66, 845, 24, COLORS.navy);
  dot(context, 108, 905, 16, COLORS.steel);
  dot(context, 74, 952, 12, COLORS.lightBlue);

  // Bottom right: navy swell, warm accent, one blue bead.
  fillBlob(context, COLORS.navy, [
    [1980, 1080],
    [1980, 890],
    [1928, 898],
    [1874, 940],
    [1810, 978],
    [1730, 1014],
    [1650, 1046],
    [1570, 1080],
  ]);
  fillBlob(context, COLORS.orange, [
    [1980, 1080],
    [1980, 860],
    [1930, 880],
    [1895, 940],
    [1880, 1010],
    [1878, 1080],
  ]);
  fillBlob(context, COLORS.lightBlue, [
    [1980, 1080],
    [1960, 1010],
    [1905, 975],
    [1855, 995],
    [1840, 1040],
    [1850, 1080],
  ]);
  dot(context, 1806, 944, 62, COLORS.steel);
  dot(context, 1750, 1016, 18, COLORS.blue);

  context.restore();
}

