// Parse the meeting links people paste (Zoom invite links, web-client links,
// zoommtg:// deep links, bare meeting numbers) into what the bot needs.
// Pure: used by the server, the host and tests.
import type { Platform } from "./runtime-files.js";

export interface ParsedMeetingUrl {
  readonly platform: Platform;
  /** The link as given (trimmed). */
  readonly url: string;
  /** Where the bot's browser goes first. */
  readonly joinUrl: string;
  readonly meetingNumber: string | null;
  readonly passcode: string | null;
  /** "meeting" | "webinar" | "personal" | "mock" */
  readonly kind: "meeting" | "webinar" | "personal" | "mock";
}

export class MeetingUrlError extends Error {
  override readonly name = "MeetingUrlError";
}

/** Zoom web client entry point that works for any meeting id. */
export const ZOOM_WEB_CLIENT_ORIGIN = "https://app.zoom.us";

const ZOOM_HOST = /(^|\.)zoom\.(us|com)$|(^|\.)zoomgov\.com$/i;
const MEETING_NUMBER = /^\d{9,11}$/;

function isZoomHost(hostname: string): boolean {
  return ZOOM_HOST.test(hostname);
}

function digits(value: string): string {
  return value.replace(/[\s-]/g, "");
}

/**
 * The web-client join URL for a meeting number. Without fromPWA=1 the client
 * renders in the top frame (no iframe#webclient); opening app.zoom.us/wc
 * directly also avoids zoom.us/j's native "Open xdg-open?" dialog, which
 * swallows every trusted input event (docs/dev/research-zoom-probe.md).
 */
export function zoomWebClientUrl(
  meetingNumber: string,
  options: { passcode?: string | null; origin?: string } = {},
): string {
  const origin = options.origin ?? ZOOM_WEB_CLIENT_ORIGIN;
  const url = new URL(`${origin}/wc/${meetingNumber}/join`);
  if (options.passcode) url.searchParams.set("pwd", options.passcode);
  return url.toString();
}

/** Zoom's encoded passcode token is [A-Za-z0-9]+ optionally followed by ".<digits>"; numeric passcodes also fit. */
function cleanPasscode(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const match = /^[A-Za-z0-9]+(\.\d+)?/.exec(trimmed);
  return match === null ? null : match[0];
}

/** Web-client origin for a Zoom link: gov cloud keeps its own domain, everything else uses app.zoom.us. */
function webClientOrigin(hostname: string): string {
  return /(^|\.)zoomgov\.com$/i.test(hostname) ? "https://app.zoomgov.com" : ZOOM_WEB_CLIENT_ORIGIN;
}

function isMockUrl(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
    url.pathname.includes("/mock-meeting")
  );
}

export function parseMeetingUrl(input: string): ParsedMeetingUrl {
  const raw = input.trim();
  if (raw === "") throw new MeetingUrlError("Пустая ссылка на встречу");

  // A bare meeting number such as "812 3456 7890".
  if (/^[\d\s-]+$/.test(raw)) {
    const number = digits(raw);
    if (!MEETING_NUMBER.test(number)) {
      throw new MeetingUrlError(`«${raw}» не похоже на номер Zoom-встречи (9–11 цифр)`);
    }
    return {
      platform: "zoom",
      url: raw,
      joinUrl: zoomWebClientUrl(number),
      meetingNumber: number,
      passcode: null,
      kind: "meeting",
    };
  }

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new MeetingUrlError(`Не удалось разобрать ссылку: ${raw}`);
  }

  if (isMockUrl(url)) {
    return { platform: "mock", url: raw, joinUrl: url.toString(), meetingNumber: null, passcode: null, kind: "mock" };
  }

  // zoommtg://zoom.us/join?action=join&confno=123&pwd=abc (desktop deep link)
  if (url.protocol === "zoommtg:" || url.protocol === "zoomus:") {
    const number = digits(url.searchParams.get("confno") ?? "");
    if (!MEETING_NUMBER.test(number)) throw new MeetingUrlError("В ссылке zoommtg:// нет номера встречи");
    const passcode = cleanPasscode(url.searchParams.get("pwd"));
    return {
      platform: "zoom",
      url: raw,
      joinUrl: zoomWebClientUrl(number, { passcode }),
      meetingNumber: number,
      passcode,
      kind: "meeting",
    };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new MeetingUrlError(`Неподдерживаемая схема ссылки: ${url.protocol}`);
  }
  // zoom.com links are the same meetings on zoom.us.
  if (/(^|\.)zoom\.com$/i.test(url.hostname)) url.hostname = url.hostname.replace(/zoom\.com$/i, "zoom.us");
  if (url.protocol === "http:") url.protocol = "https:";
  if (!isZoomHost(url.hostname)) {
    throw new MeetingUrlError(
      `Поддерживаются только ссылки Zoom (zoom.us, zoom.com, zoomgov.com); получено: ${url.hostname}`,
    );
  }
  // Zoom Events join links redirect to the web client by themselves.
  if (/^events\.zoom\./i.test(url.hostname)) {
    return { platform: "zoom", url: raw, joinUrl: url.toString(), meetingNumber: null, passcode: null, kind: "webinar" };
  }

  const origin = webClientOrigin(url.hostname);
  const passcode = cleanPasscode(url.searchParams.get("pwd") ?? url.searchParams.get("password"));
  const token = url.searchParams.get("tk");
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "webinar" && segments[1] === "register") {
    throw new MeetingUrlError("Это страница регистрации на вебинар: зарегистрируйтесь и дайте боту персональную ссылку участника");
  }

  // /j/<n>, /w/<n> (webinar), /s/<n> (host start link), /join/<n>
  const [first, second, third] = segments;
  if ((first === "j" || first === "w" || first === "s" || first === "join") && second !== undefined) {
    const number = digits(second);
    if (!MEETING_NUMBER.test(number)) throw new MeetingUrlError(`Неверный номер встречи в ссылке: ${second}`);
    // A registrant token (tk) is a credential that only survives on the original
    // link: open it as-is and let the bot click "Join from browser".
    if (token !== null) {
      url.searchParams.delete("ref_from");
      return {
        platform: "zoom",
        url: raw,
        joinUrl: url.toString(),
        meetingNumber: number,
        passcode,
        kind: first === "w" ? "webinar" : "meeting",
      };
    }
    return {
      platform: "zoom",
      url: raw,
      joinUrl: zoomWebClientUrl(number, { passcode, origin }),
      meetingNumber: number,
      passcode,
      kind: first === "w" ? "webinar" : "meeting",
    };
  }

  // Web-client links: /wc/<n>/join, /wc/join/<n>, /wc/<n>/start
  if (first === "wc" && second !== undefined) {
    const candidate = second === "join" && third !== undefined ? third : second;
    const number = digits(candidate);
    if (MEETING_NUMBER.test(number)) {
      return {
        platform: "zoom",
        url: raw,
        joinUrl: zoomWebClientUrl(number, { passcode, origin }),
        meetingNumber: number,
        passcode,
        kind: "meeting",
      };
    }
  }

  // Personal meeting links: /my/<vanity>. The number is only known after Zoom
  // redirects, so the bot opens the link itself and follows "join from browser".
  if (first === "my" && second !== undefined) {
    return {
      platform: "zoom",
      url: raw,
      joinUrl: url.toString(),
      meetingNumber: null,
      passcode,
      kind: "personal",
    };
  }

  throw new MeetingUrlError(
    "Не похоже на ссылку на Zoom-встречу. Нужна ссылка вида https://zoom.us/j/<номер>?pwd=…",
  );
}

/** Find meeting links in free text (calendar descriptions, chat messages). */
export function extractMeetingUrls(text: string): string[] {
  const found = new Set<string>();
  const pattern = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:zoom\.us|zoom\.com|zoomgov\.com)\/(?:j|w|s|my|wc)\/[^\s<>"')\]]+|zoommtg:\/\/[^\s<>"')\]]+/gi;
  for (const match of text.matchAll(pattern)) {
    const candidate = match[0].replace(/[.,;:!?]+$/, "");
    try {
      parseMeetingUrl(candidate);
      found.add(candidate);
    } catch {
      // not a joinable link
    }
  }
  return [...found];
}

/** The link with its passcode hidden, for logs and agent-visible output. */
export function maskMeetingUrl(input: string): string {
  return input.replace(/([?&](?:pwd|password|tk)=)[^&#\s]+/gi, "$1***");
}
