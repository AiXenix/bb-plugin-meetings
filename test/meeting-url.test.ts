import { describe, expect, it } from "vitest";
import {
  MeetingUrlError,
  extractMeetingUrls,
  maskMeetingUrl,
  parseMeetingUrl,
  zoomWebClientUrl,
} from "../src/shared/meeting-url.js";

describe("parseMeetingUrl", () => {
  it("turns an invite link into a web-client URL with the passcode", () => {
    const parsed = parseMeetingUrl(" https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123.1 ");
    expect(parsed).toEqual({
      platform: "zoom",
      url: "https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123.1",
      joinUrl: "https://app.zoom.us/wc/81234567890/join?pwd=AbCdEf123.1",
      meetingNumber: "81234567890",
      passcode: "AbCdEf123.1",
      kind: "meeting",
    });
  });

  it("accepts bare meeting numbers with spaces or dashes", () => {
    for (const input of ["812 3456 7890", "812-3456-7890", "81234567890"]) {
      const parsed = parseMeetingUrl(input);
      expect(parsed.meetingNumber).toBe("81234567890");
      expect(parsed.joinUrl).toBe("https://app.zoom.us/wc/81234567890/join");
      expect(parsed.passcode).toBeNull();
    }
  });

  it("handles links without a scheme, zoom.com, http and the password= alias", () => {
    expect(parseMeetingUrl("zoom.us/j/123456789").joinUrl).toBe("https://app.zoom.us/wc/123456789/join");
    expect(parseMeetingUrl("https://company.zoom.com/j/123456789?pwd=x1").joinUrl).toBe(
      "https://app.zoom.us/wc/123456789/join?pwd=x1",
    );
    expect(parseMeetingUrl("http://zoom.us/j/123456789?password=Secret9").passcode).toBe("Secret9");
  });

  it("drops junk after the passcode token", () => {
    expect(parseMeetingUrl("https://zoom.us/j/123456789?pwd=abc123.1%29").passcode).toBe("abc123.1");
  });

  it("parses desktop deep links", () => {
    const parsed = parseMeetingUrl("zoommtg://zoom.us/join?action=join&confno=81234567890&pwd=xyz789");
    expect(parsed.joinUrl).toBe("https://app.zoom.us/wc/81234567890/join?pwd=xyz789");
    expect(parsed.passcode).toBe("xyz789");
  });

  it("recognizes webinars, host start links and web-client links", () => {
    expect(parseMeetingUrl("https://zoom.us/w/81234567890?tk=abc").kind).toBe("webinar");
    expect(parseMeetingUrl("https://zoom.us/s/81234567890").meetingNumber).toBe("81234567890");
    expect(parseMeetingUrl("https://app.zoom.us/wc/81234567890/join?pwd=q1").joinUrl).toBe(
      "https://app.zoom.us/wc/81234567890/join?pwd=q1",
    );
    expect(parseMeetingUrl("https://zoom.us/wc/join/81234567890").meetingNumber).toBe("81234567890");
  });

  it("keeps registrant-token links as they are (minus tracking)", () => {
    const parsed = parseMeetingUrl("https://zoom.us/j/81234567890?tk=TOKEN123&ref_from=email");
    expect(parsed.joinUrl).toBe("https://zoom.us/j/81234567890?tk=TOKEN123");
    expect(parsed.meetingNumber).toBe("81234567890");
  });

  it("opens personal links directly", () => {
    const parsed = parseMeetingUrl("https://zoom.us/my/ivan.petrov?pwd=p1");
    expect(parsed.kind).toBe("personal");
    expect(parsed.meetingNumber).toBeNull();
    expect(parsed.joinUrl).toBe("https://zoom.us/my/ivan.petrov?pwd=p1");
  });

  it("keeps the gov cloud on its own web client", () => {
    expect(parseMeetingUrl("https://agency.zoomgov.com/j/1612345678").joinUrl).toBe(
      "https://app.zoomgov.com/wc/1612345678/join",
    );
  });

  it("selects the mock platform for local mock-meeting pages", () => {
    const parsed = parseMeetingUrl("http://127.0.0.1:8765/mock-meeting/index.html?script=a");
    expect(parsed.platform).toBe("mock");
    expect(parsed.kind).toBe("mock");
    expect(parsed.joinUrl).toBe("http://127.0.0.1:8765/mock-meeting/index.html?script=a");
  });

  it("rejects what it cannot join, with Russian messages", () => {
    const bad = [
      "",
      "   ",
      "12345",
      "https://meet.google.com/abc-defg-hij",
      "https://zoom.us/webinar/register/WN_abc",
      "ftp://zoom.us/j/123456789",
      "https://zoom.us/j/12ab",
      "https://zoom.us/profile",
      "zoommtg://zoom.us/join?action=join",
    ];
    for (const input of bad) {
      expect(() => parseMeetingUrl(input), input).toThrow(MeetingUrlError);
    }
    expect(() => parseMeetingUrl("https://meet.google.com/abc")).toThrow(/Поддерживаются только ссылки Zoom/);
  });

  it("builds web-client URLs", () => {
    expect(zoomWebClientUrl("123456789", { passcode: "a b" })).toBe("https://app.zoom.us/wc/123456789/join?pwd=a+b");
  });
});

describe("extractMeetingUrls", () => {
  it("finds joinable links in calendar text, without trailing punctuation or duplicates", () => {
    const text = [
      "Join Zoom Meeting",
      "https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123.1.",
      "Meeting ID: 812 3456 7890",
      "Same link again: https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123.1",
      "(also https://zoom.us/my/ivan) and <https://example.com/j/1>",
      "Register: https://zoom.us/webinar/register/WN_x",
    ].join("\n");
    expect(extractMeetingUrls(text)).toEqual([
      "https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123.1",
      "https://zoom.us/my/ivan",
    ]);
  });

  it("returns nothing for text without Zoom links", () => {
    expect(extractMeetingUrls("Обсуждение бюджета в переговорной 3")).toEqual([]);
  });
});

describe("maskMeetingUrl", () => {
  it("hides passcodes and tokens", () => {
    expect(maskMeetingUrl("https://zoom.us/j/1234567890?pwd=Secret.1&uname=x")).toBe(
      "https://zoom.us/j/1234567890?pwd=***&uname=x",
    );
    expect(maskMeetingUrl("https://zoom.us/w/1?tk=abc&password=p")).toBe("https://zoom.us/w/1?tk=***&password=***");
    expect(maskMeetingUrl("https://zoom.us/j/1234567890")).toBe("https://zoom.us/j/1234567890");
  });
});
