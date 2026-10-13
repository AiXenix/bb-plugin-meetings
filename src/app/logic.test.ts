// Pure helpers of the Meetings page: formatting, routing, transcript model,
// speaker colors, the safe Markdown renderer, and constants kept in sync with
// src/shared (the page duplicates them to keep zod out of the bundle).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as shared from "../shared/rpc-contract";
import { BOT_ERROR_CODES, END_REASONS, MEETING_ID_PATTERN as SHARED_ID_PATTERN } from "../shared/runtime-files";
import * as constants from "./constants";
import {
  formatClock,
  formatDay,
  formatDuration,
  formatPercent,
  formatTimestamp,
  parseDatetimeLocal,
  pluralRu,
  toDatetimeLocal,
} from "./format";
import { END_REASON_TEXT, ERROR_TEXT, STATUS_TEXT, statusText } from "./labels";
import { parseMarkdown, renderMarkdown, safeHref } from "./markdown";
import { meetingSubPath, parseRoute } from "./route";
import { NEUTRAL_SPEAKER_COLOR, speakerColors } from "./speaker-colors";
import {
  appendSegments,
  buildTurns,
  extendTurns,
  findMatches,
  findSegmentAt,
  parseSnippet,
  searchPattern,
  speakerOrder,
  speakerStats,
  splitHighlight,
} from "./transcript-model";
import type { SegmentView } from "../shared/rpc-contract";

const seg = (id: number, start: number, end: number, speakerKey: string, text = `t${id}`): SegmentView => ({
  id,
  start,
  end,
  speakerKey,
  speaker: speakerKey.replace(/^ui:/, ""),
  source: "ui",
  text,
});

describe("constants mirror src/shared", () => {
  it("channels, snippet markers, status sets and the id pattern match", () => {
    expect(constants.CHANNEL_MEETING_CHANGED).toBe(shared.CHANNEL_MEETING_CHANGED);
    expect(constants.CHANNEL_MEETING_SEGMENTS).toBe(shared.CHANNEL_MEETING_SEGMENTS);
    expect(constants.CHANNEL_ENV_CHANGED).toBe(shared.CHANNEL_ENV_CHANGED);
    expect(constants.CHANNEL_CALENDAR_CHANGED).toBe(shared.CHANNEL_CALENDAR_CHANGED);
    expect(constants.CHANNEL_ZOOM_CHANGED).toBe(shared.CHANNEL_ZOOM_CHANGED);
    expect(constants.SNIPPET_OPEN).toBe(shared.SNIPPET_OPEN);
    expect(constants.SNIPPET_CLOSE).toBe(shared.SNIPPET_CLOSE);
    expect([...constants.ACTIVE_STATUSES].sort()).toEqual([...shared.ACTIVE_STATUSES].sort());
    expect([...constants.LIVE_STATUSES].sort()).toEqual([...shared.LIVE_STATUSES].sort());
    expect([...constants.TERMINAL_STATUSES].sort()).toEqual([...shared.TERMINAL_STATUSES].sort());
    expect(constants.MEETING_ID_PATTERN.source).toBe(SHARED_ID_PATTERN.source);
  });

  it("every status, error code and end reason has Russian text", () => {
    for (const status of shared.MEETING_STATUSES) expect(STATUS_TEXT[status]).toMatch(/[а-я]/i);
    for (const code of BOT_ERROR_CODES) expect(ERROR_TEXT[code]).toMatch(/[а-я]/i);
    for (const reason of END_REASONS) expect(END_REASON_TEXT[reason]).toMatch(/[а-я]/i);
    expect(ERROR_TEXT.invalid_meeting).toBe("Неверная ссылка или встреча ещё не началась");
    expect(statusText({ status: "processing", transcriptProgress: 0.453 })).toBe("Расшифровка 45 %");
    expect(statusText({ status: "processing", transcriptProgress: null })).toBe("Расшифровка");
  });

  it("HTTP urls escape the id", () => {
    expect(constants.audioUrl("mtg_abc123")).toBe("/api/v1/plugins/meetings/http/audio?id=mtg_abc123");
    expect(constants.screenshotUrl("mtg_abc123", 42)).toBe(
      "/api/v1/plugins/meetings/http/screenshot?id=mtg_abc123&v=42",
    );
    expect(constants.downloadUrl("mtg_abc123", "srt")).toBe(
      "/api/v1/plugins/meetings/http/download?id=mtg_abc123&format=srt",
    );
  });
});

describe("format", () => {
  it("clocks and timestamps", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65.9)).toBe("1:05");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatTimestamp(65)).toBe("00:01:05");
    expect(formatTimestamp(36_000 + 61)).toBe("10:01:01");
  });

  it("durations, percents and plurals", () => {
    expect(formatDuration(40)).toBe("40 с");
    expect(formatDuration(754)).toBe("13 мин");
    expect(formatDuration(3900)).toBe("1 ч 05 мин");
    expect(formatDuration(7200)).toBe("2 ч");
    expect(formatPercent(1.7)).toBe("100 %");
    expect(pluralRu(1, "участник", "участника", "участников")).toBe("участник");
    expect(pluralRu(3, "участник", "участника", "участников")).toBe("участника");
    expect(pluralRu(11, "участник", "участника", "участников")).toBe("участников");
    expect(pluralRu(22, "участник", "участника", "участников")).toBe("участника");
    expect(pluralRu(25, "участник", "участника", "участников")).toBe("участников");
  });

  it("relative days", () => {
    const now = new Date(2026, 9, 13, 12, 0).getTime();
    expect(formatDay(new Date(2026, 9, 13, 8, 0).getTime(), now)).toBe("сегодня");
    expect(formatDay(new Date(2026, 9, 12, 23, 59).getTime(), now)).toBe("вчера");
    expect(formatDay(new Date(2026, 9, 14, 0, 1).getTime(), now)).toBe("завтра");
    expect(formatDay(new Date(2026, 8, 1, 10, 0).getTime(), now)).toMatch(/^1 сент/);
  });

  it("datetime-local round trip in local time", () => {
    const ms = new Date(2026, 9, 13, 14, 5).getTime();
    expect(toDatetimeLocal(ms)).toBe("2026-10-13T14:05");
    expect(parseDatetimeLocal("2026-10-13T14:05")).toBe(ms);
    expect(parseDatetimeLocal("")).toBeNull();
    expect(parseDatetimeLocal("13.10.2026 14:05")).toBeNull();
  });
});

describe("route", () => {
  it("parses list, detail, segment deep links and zoom-login", () => {
    expect(parseRoute("")).toEqual({ kind: "list" });
    expect(parseRoute("/")).toEqual({ kind: "list" });
    expect(parseRoute("zoom-login")).toEqual({ kind: "zoom-login" });
    expect(parseRoute("mtg_abc123")).toEqual({ kind: "detail", id: "mtg_abc123", segmentId: null });
    expect(parseRoute("mtg_abc123/t/57")).toEqual({ kind: "detail", id: "mtg_abc123", segmentId: 57 });
    expect(parseRoute("mtg_abc123/t/x")).toEqual({ kind: "detail", id: "mtg_abc123", segmentId: null });
    expect(parseRoute("nope")).toEqual({ kind: "unknown", subPath: "nope" });
    expect(meetingSubPath("mtg_abc123", 5)).toBe("mtg_abc123/t/5");
    expect(meetingSubPath("mtg_abc123")).toBe("mtg_abc123");
  });
});

describe("transcript model", () => {
  const segments = [
    seg(0, 0, 2, "ui:Анна"),
    seg(1, 2.5, 4, "ui:Анна"),
    seg(2, 7, 9, "ui:Анна"), // gap 3 s → new turn
    seg(3, 9.2, 11, "ui:Борис"),
    seg(4, 11.1, 12, "unknown"),
  ];

  it("groups speaker turns by speaker and pause", () => {
    const turns = buildTurns(segments);
    expect(turns.map((turn) => [turn.speakerKey, turn.firstId, turn.lastId])).toEqual([
      ["ui:Анна", 0, 1],
      ["ui:Анна", 2, 2],
      ["ui:Борис", 3, 3],
      ["unknown", 4, 4],
    ]);
  });

  it("splits very long monologues into blocks", () => {
    const long = Array.from({ length: 75 }, (_, i) => seg(i, i, i + 0.9, "ui:Анна"));
    expect(buildTurns(long).map((turn) => turn.segments.length)).toEqual([30, 30, 15]);
  });

  it("extends turns incrementally, reusing closed turns", () => {
    const first = segments.slice(0, 3);
    const previous = { segments: first, turns: buildTurns(first) };
    const grown = first.concat([seg(3, 7.5, 8, "ui:Анна"), seg(4, 9.2, 11, "ui:Борис")]);
    const extended = extendTurns(previous, grown);
    expect(extended).toEqual(buildTurns(grown));
    expect(extended[0]).toBe(previous.turns[0]); // closed turn reused
    expect(extendTurns(previous, first)).toBe(previous.turns);
    const rebuilt = [{ ...first[0]! }, ...first.slice(1)];
    expect(extendTurns(previous, rebuilt)[0]).not.toBe(previous.turns[0]);
  });

  it("finds the playing segment", () => {
    expect(findSegmentAt(segments, -1)).toBeNull();
    expect(findSegmentAt(segments, 0)).toBe(0);
    expect(findSegmentAt(segments, 3)).toBe(1);
    expect(findSegmentAt(segments, 4.5)).toBe(1); // within the tolerance after the end
    expect(findSegmentAt(segments, 6)).toBeNull();
    expect(findSegmentAt(segments, 50)).toBeNull();
  });

  it("appends pages and replaces overlapping ids", () => {
    const base = segments.slice(0, 3);
    expect(appendSegments(base, []).length).toBe(3);
    expect(appendSegments(base, segments.slice(3)).map((s) => s.id)).toEqual([0, 1, 2, 3, 4]);
    const replaced = appendSegments(base, [seg(1, 2.5, 4, "ui:Анна", "new"), seg(3, 9, 10, "x")]);
    expect(replaced.map((s) => s.id)).toEqual([0, 1, 2, 3]);
    expect(replaced[1]!.text).toBe("new");
  });

  it("derives speaker stats and order, applying renames", () => {
    const stats = speakerStats([], segments, { "ui:Борис": "Борис Петров" });
    expect(stats[0]).toMatchObject({ key: "ui:Анна", segments: 3, talkSec: 5.5 });
    expect(stats.find((s) => s.key === "ui:Борис")).toMatchObject({ label: "Борис Петров", originalLabel: "Борис" });
    const fromServer = speakerStats(
      [{ key: "spk:1", label: "Спикер 1", originalLabel: "Спикер 1", source: "acoustic", talkSec: 10, segments: 2 }],
      segments,
      {},
    );
    expect(fromServer.map((s) => s.key)).toEqual(["spk:1"]);
    expect(speakerOrder(segments, [{ key: "spk:9" }, { key: "ui:Анна" }])).toEqual([
      "ui:Анна",
      "ui:Борис",
      "unknown",
      "spk:9",
    ]);
  });

  it("parses FTS snippets, also unbalanced ones", () => {
    expect(parseSnippet("до \u0002бюджет\u0003 после")).toEqual([
      { text: "до ", hit: false },
      { text: "бюджет", hit: true },
      { text: " после", hit: false },
    ]);
    expect(parseSnippet("\u0002a\u0003\u0002b\u0003")).toEqual([{ text: "ab", hit: true }]);
    expect(parseSnippet("<b>x</b>\u0003")).toEqual([{ text: "<b>x</b>", hit: false }]);
  });

  it("searches case-insensitively, treating е and ё alike, and escapes regex syntax", () => {
    const pattern = searchPattern("ЕЩЕ");
    expect(splitHighlight("Ещё раз, ещё", pattern)).toEqual([
      { text: "Ещё", hit: true },
      { text: " раз, ", hit: false },
      { text: "ещё", hit: true },
    ]);
    expect(searchPattern("  ")).toBeNull();
    expect(splitHighlight("a+b (c)", searchPattern("(c)"))).toEqual([
      { text: "a+b ", hit: false },
      { text: "(c)", hit: true },
    ]);
    expect(
      findMatches(
        [seg(0, 0, 1, "a", "Привет"), seg(1, 1, 2, "a", "пока"), seg(2, 2, 3, "a", "ПРИВЕТ")],
        searchPattern("привет"),
      ),
    ).toEqual([0, 2]);
  });
});

describe("speaker colors", () => {
  it("assigns palette slots in first-appearance order, neutral for unknown and the 9th speaker on", () => {
    const keys = ["unknown", ...Array.from({ length: 9 }, (_, i) => `ui:${i}`)];
    const colors = speakerColors(keys);
    expect(colors.get("unknown")).toBe(NEUTRAL_SPEAKER_COLOR);
    expect(colors.get("ui:0")).toBe("light-dark(#2a78d6, #3987e5)");
    expect(colors.get("ui:7")).toBe("light-dark(#e34948, #e66767)");
    expect(colors.get("ui:8")).toBe(NEUTRAL_SPEAKER_COLOR);
    expect(new Set(keys.slice(1, 9).map((key) => colors.get(key))).size).toBe(8);
  });
});

describe("safe markdown", () => {
  const html = (source: string) => renderToStaticMarkup(createElement("div", null, ...renderMarkdown(source)));

  it("renders headings, lists, tasks, emphasis, code, quotes, rules and tables", () => {
    const out = html(
      [
        "# Итоги",
        "",
        "Обсудили **бюджет** и *сроки*, а также `api_v2` и ~~старый план~~.",
        "",
        "- первый",
        "  - вложенный",
        "- второй",
        "",
        "3. три",
        "4. четыре",
        "",
        "- [ ] сделать",
        "- [x] сделано",
        "",
        "> цитата",
        "",
        "---",
        "",
        "| Кто | Что |",
        "|:----|----:|",
        "| Анна | отчёт |",
        "",
        "```",
        "<b>не html</b>",
        "```",
      ].join("\n"),
    );
    expect(out).toContain("<h3");
    expect(out).toContain("Итоги</h3>");
    expect(out).toContain('<strong class="font-semibold">бюджет</strong>');
    expect(out).toContain("<em>сроки</em>");
    expect(out).toContain(">api_v2</code>");
    expect(out).toContain("<del>старый план</del>");
    expect(out).toMatch(
      /<ul[^>]*><li[^>]*>первый<ul[^>]*><li[^>]*>вложенный<\/li><\/ul><\/li><li[^>]*>второй<\/li><\/ul>/,
    );
    expect(out).toMatch(/<ol start="3"/);
    expect(out).toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*\/>сделать/);
    expect(out).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/>сделано/);
    expect(out).toContain("<blockquote");
    expect(out).toContain("<hr");
    expect(out).toMatch(/<th style="text-align:left"[^>]*>Кто<\/th>/);
    expect(out).toMatch(/<td style="text-align:right"[^>]*>отчёт<\/td>/);
    expect(out).toContain("&lt;b&gt;не html&lt;/b&gt;");
  });

  it("never injects HTML and links only http(s)", () => {
    const out = html(
      '<img src=x onerror="alert(1)"> [click](javascript:alert(1)) [ok](https://example.com/a?b=1) <https://x.org> see http://y.org/p.',
    );
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("&gt; click <a"); // label kept as plain text, no stray ")"
    expect(out).toContain('href="https://example.com/a?b=1"');
    expect(out).toContain('href="https://x.org/"');
    expect(out).toContain('href="http://y.org/p"');
    expect(out).toContain('rel="noreferrer noopener"');
    expect(safeHref("data:text/html,<b>")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
  });

  it("keeps snake_case words and lone asterisks as text, and handles escapes and hard breaks", () => {
    const out = html("snake_case_name и 2 * 3 * 4, \\*не курсив\\*  \nвторая строка");
    expect(out).toContain("snake_case_name");
    expect(out).toContain("2 * 3 * 4");
    expect(out).toContain("*не курсив*");
    expect(out).toContain("<br/>вторая строка");
    expect(out).not.toContain("<em>");
  });

  it("parses deeply nested quotes without blowing the stack", () => {
    expect(() => parseMarkdown(">".repeat(500) + " x")).not.toThrow();
    expect(() => html("*".repeat(2000))).not.toThrow();
  });

  it("renders a long paragraph full of delimiters in about linear time", () => {
    // One 200 KB paragraph (no blank lines) of "**Name** [time]: …" lines: unclosed "*" candidates used to
    // rescan the rest of the paragraph after every token (cubic: minutes for this input).
    const line = "**Анна** [00:12:31]: обсудили релиз, сроки сдвигаются на неделю\n";
    const started = performance.now();
    const out = html(line.repeat(3200));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(out.match(/<strong /g)?.length).toBe(3200);
    expect(out).not.toContain("<em>");
    expect(html("**x**\n".repeat(34_000)).match(/<strong /g)?.length).toBe(34_000);
    // Emphasis may still continue on the next line of a paragraph, and spans keep working after a token.
    expect(html("**один\nдва** и *три* `код` _четыре_")).toMatch(
      /<strong[^>]*>один два<\/strong> и <em>три<\/em> <code[^>]*>код<\/code> <em>четыре<\/em>/,
    );
  });
});
