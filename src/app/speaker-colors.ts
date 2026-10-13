// Speaker identity colors. Eight categorical slots, each with a light-theme
// and a dark-theme step (validated as a set for color-vision deficiency and
// contrast against light and dark surfaces); CSS light-dark() picks the step
// from the theme's color-scheme (bb sets color-scheme on .light/.dark). Slots
// are handed out in order of first appearance and never cycled: the 9th
// speaker on, and the "unknown" speaker, get a neutral color — the name text
// next to every mark carries identity anyway.
const PALETTE: ReadonlyArray<readonly [light: string, dark: string]> = [
  ["#2a78d6", "#3987e5"], // blue
  ["#eb6834", "#d95926"], // orange
  ["#1baf7a", "#199e70"], // aqua
  ["#eda100", "#c98500"], // yellow
  ["#e87ba4", "#d55181"], // magenta
  ["#008300", "#008300"], // green
  ["#6250d6", "#9085e9"], // violet
  ["#e34948", "#e66767"], // red
];

export const NEUTRAL_SPEAKER_COLOR = "var(--muted-foreground)";
export const UNKNOWN_SPEAKER_KEY = "unknown";

export function speakerColors(orderedKeys: readonly string[]): Map<string, string> {
  const colors = new Map<string, string>();
  let slot = 0;
  for (const key of orderedKeys) {
    if (colors.has(key)) continue;
    const pair = key === UNKNOWN_SPEAKER_KEY ? undefined : PALETTE[slot];
    if (pair === undefined) {
      colors.set(key, NEUTRAL_SPEAKER_COLOR);
      continue;
    }
    slot += 1;
    colors.set(key, `light-dark(${pair[0]}, ${pair[1]})`);
  }
  return colors;
}

export function colorFor(colors: ReadonlyMap<string, string>, key: string): string {
  return colors.get(key) ?? NEUTRAL_SPEAKER_COLOR;
}
