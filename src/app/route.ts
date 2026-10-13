// Routing inside the Meetings nav panel by `subPath`:
//   ""                          → list
//   "zoom-login"                → Zoom sign-in session
//   "<meetingId>"               → meeting detail
//   "<meetingId>/t/<segmentId>" → meeting detail scrolled to a segment
import { useMemo } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { MEETING_ID_PATTERN, PANEL_PATH } from "./constants";

export type Route =
  | { kind: "list" }
  | { kind: "zoom-login" }
  | { kind: "detail"; id: string; segmentId: number | null }
  | { kind: "unknown"; subPath: string };

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function parseRoute(subPath: string): Route {
  const parts = subPath
    .split("/")
    .filter((part) => part !== "")
    .map(decode);
  const [first, second, third] = parts;
  if (first === undefined) return { kind: "list" };
  if (first === "zoom-login" && parts.length === 1) return { kind: "zoom-login" };
  if (MEETING_ID_PATTERN.test(first)) {
    const segmentId =
      second === "t" && third !== undefined && /^\d{1,9}$/.test(third) ? Number.parseInt(third, 10) : null;
    return { kind: "detail", id: first, segmentId };
  }
  return { kind: "unknown", subPath };
}

export function meetingSubPath(id: string, segmentId: number | null = null): string {
  return segmentId === null ? id : `${id}/t/${segmentId}`;
}

export interface MeetingsNav {
  toList(options?: { replace?: boolean }): void;
  toMeeting(id: string, segmentId?: number | null): void;
  toZoomLogin(): void;
}

export function useMeetingsNav(): MeetingsNav {
  const navigate = useBbNavigate();
  return useMemo(
    () => ({
      toList: (options) => navigate.toPluginPanel(PANEL_PATH, { subPath: "", replace: options?.replace ?? false }),
      toMeeting: (id, segmentId = null) =>
        navigate.toPluginPanel(PANEL_PATH, { subPath: meetingSubPath(id, segmentId) }),
      toZoomLogin: () => navigate.toPluginPanel(PANEL_PATH, { subPath: "zoom-login" }),
    }),
    [navigate],
  );
}
