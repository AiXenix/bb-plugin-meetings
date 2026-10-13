import { describe, expect, it } from "vitest";
import {
  clock,
  contentDisposition,
  downloadFileName,
  groupTurns,
  humanDuration,
  renderTranscript,
  withNames,
  type FormatMeeting,
  type FormatSegment,
} from "../src/server/format.js";

const segments: FormatSegment[] = [
  { id: 0, start: 1.2, end: 3.5, speakerKey: "ui:Анна", speaker: "Анна", source: "ui", text: "Всем привет." },
  { id: 1, start: 4.0, end: 6.0, speakerKey: "ui:Анна", speaker: "Анна", source: "ui", text: "Начнём с бюджета." },
  { id: 2, start: 6.5, end: 9.25, speakerKey: "spk:2", speaker: "Спикер 2", source: "acoustic", text: "Бюджет утверждён <почти>." },
  { id: 3, start: 12.0, end: 13.0, speakerKey: "spk:2", speaker: "Спикер 2", source: "acoustic", text: "   " },
  { id: 4, start: 3725.4, end: 3727.0, speakerKey: "ui:Анна", speaker: "Анна", source: "mixed", text: "Спасибо, *все* свободны." },
];

const meeting: FormatMeeting = {
  id: "mtg_abc123def",
  title: "Планёрка",
  url: "https://zoom.us/j/123456789?pwd=***",
  startedAt: Date.UTC(2026, 9, 13, 7, 0, 0),
  durationSec: 3727,
  final: true,
  summaryMd: "Решили всё.",
};

const names = { "spk:2": "Борис" };

describe("turn grouping", () => {
  it("merges the same speaker when the gap is under 2 s, skipping empty text", () => {
    const turns = groupTurns(withNames(segments, names));
    expect(turns.map((t) => [t.speaker, t.firstId, t.lastId, t.text])).toEqual([
      ["Анна", 0, 1, "Всем привет. Начнём с бюджета."],
      ["Борис", 2, 2, "Бюджет утверждён <почти>."],
      ["Анна", 4, 4, "Спасибо, *все* свободны."],
    ]);
  });

  it("splits a speaker's turn at a long pause", () => {
    const turns = groupTurns([
      { ...segments[0]!, end: 2 },
      { ...segments[1]!, start: 4.5 },
    ]);
    expect(turns).toHaveLength(2);
  });
});

describe("renderers", () => {
  it("renders markdown with header, summary and renamed speakers", () => {
    const md = renderTranscript("md", meeting, segments, names, { timeZone: "Europe/Moscow" });
    expect(md).toBe(
      [
        "# Планёрка",
        "",
        "- Дата: 13.10.2026, 10:00",
        "- Длительность: 1 ч 2 мин",
        "- Участники: Анна, Борис",
        "- Ссылка: https://zoom.us/j/123456789?pwd=***",
        "",
        "## Резюме",
        "",
        "Решили всё.",
        "",
        "## Транскрипт",
        "",
        "**[00:00:01] Анна:** Всем привет. Начнём с бюджета.",
        "",
        "**[00:00:06] Борис:** Бюджет утверждён <почти>.",
        "",
        "**[01:02:05] Анна:** Спасибо, *все* свободны.",
        "",
      ].join("\n"),
    );
  });

  it("renders plain text turns, without header on later pages", () => {
    const txt = renderTranscript("txt", { ...meeting, final: false }, segments.slice(2), names, { header: false });
    expect(txt).toBe("[00:00:06] Борис: Бюджет утверждён <почти>.\n\n[01:02:05] Анна: Спасибо, *все* свободны.\n");
    const withHeader = renderTranscript("txt", { ...meeting, final: false }, segments, {}, { timeZone: "UTC" });
    expect(withHeader.split("\n").slice(0, 2)).toEqual(["Планёрка", "Дата: 13.10.2026, 07:00"]);
    expect(withHeader).toContain("Транскрипт предварительный");
    expect(withHeader).toContain("Спикер 2: Бюджет");
  });

  it("renders SRT cues per segment", () => {
    const srt = renderTranscript("srt", meeting, segments, names);
    expect(srt.split("\n\n")[0]).toBe("1\n00:00:01,200 --> 00:00:03,500\nАнна: Всем привет.");
    expect(srt).toContain("3\n00:00:06,500 --> 00:00:09,250\nБорис: Бюджет утверждён <почти>.");
    expect(srt).toContain("4\n01:02:05,400 --> 01:02:07,000\nАнна: Спасибо, *все* свободны.");
    expect(srt).not.toContain("00:00:12,000");
  });

  it("renders WebVTT with escaped voice spans", () => {
    const vtt = renderTranscript("vtt", meeting, segments, names);
    expect(vtt.startsWith("WEBVTT\n\n0\n00:00:01.200 --> 00:00:03.500\n<v Анна>Всем привет.\n")).toBe(true);
    expect(vtt).toContain("<v Борис>Бюджет утверждён &lt;почти&gt;.");
  });

  it("renders JSON with renamed speakers and talk time", () => {
    const parsed = JSON.parse(renderTranscript("json", meeting, segments, names)) as {
      speakers: Array<{ key: string; label: string; talkSec: number; segments: number }>;
      segments: Array<{ speaker: string; speakerKey: string }>;
    };
    expect(parsed.speakers).toEqual([
      { key: "ui:Анна", label: "Анна", talkSec: 5.9, segments: 3 },
      { key: "spk:2", label: "Борис", talkSec: 3.8, segments: 2 },
    ]);
    expect(parsed.segments[2]).toMatchObject({ speaker: "Борис", speakerKey: "spk:2" });
  });
});

describe("helpers", () => {
  it("formats clocks and durations", () => {
    expect(clock(0)).toBe("00:00:00");
    expect(clock(3725.9)).toBe("01:02:05");
    expect(humanDuration(42)).toBe("42 с");
    expect(humanDuration(125)).toBe("2 мин 5 с");
    expect(humanDuration(3600)).toBe("1 ч");
    expect(humanDuration(3725, "en")).toBe("1 h 2 min");
  });

  it("builds safe download names and Content-Disposition with a UTF-8 name", () => {
    const name = downloadFileName('Планёрка: "итоги"/Q3', Date.UTC(2026, 9, 13, 7), "md", "UTC");
    expect(name).toBe("Планёрка итоги Q3 2026-10-13.md");
    expect(contentDisposition(name)).toBe(
      `attachment; filename="_ _ Q3 2026-10-13.md"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    expect(contentDisposition("Café (1).md")).toBe(`attachment; filename="Cafe (1).md"; filename*=UTF-8''Caf%C3%A9%20%281%29.md`);
    expect(downloadFileName("   ", null, "txt")).toBe("meeting.txt");
  });
});
