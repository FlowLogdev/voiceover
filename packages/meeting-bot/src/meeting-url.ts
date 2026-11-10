export type MeetingPlatform = "zoom" | "google_meet" | "teams";

export interface ParsedMeetingUrl {
  platform: MeetingPlatform;
  /** Canonical https URL to hand to the bot provider (fragment stripped). */
  normalizedUrl: string;
  /** Platform-native meeting identifier, for display/dedupe only. */
  meetingId: string;
}

export class InvalidMeetingUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMeetingUrlError";
  }
}

const GOOGLE_MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const ZOOM_MEETING_NUMBER = /^\d{9,11}$/;

function isZoomHost(host: string): boolean {
  return host === "zoom.us" || host.endsWith(".zoom.us");
}

/**
 * Validates and classifies a user-supplied meeting link. A bot provider will
 * dispatch a real headless browser to whatever URL it's given, so this is an
 * allowlist (https + known meeting hosts + recognisable meeting path), not a
 * best-effort guess — anything unrecognised is rejected rather than forwarded.
 */
export function parseMeetingUrl(input: string): ParsedMeetingUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new InvalidMeetingUrlError("Not a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new InvalidMeetingUrlError("Meeting URL must use https");
  }
  if (url.username || url.password) {
    throw new InvalidMeetingUrlError("Meeting URL must not contain credentials");
  }
  if (url.port) {
    throw new InvalidMeetingUrlError("Meeting URL must not specify a port");
  }

  url.hash = "";
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "meet.google.com") {
    const code = segments[0]?.toLowerCase();
    if (segments.length !== 1 || !code || !GOOGLE_MEET_CODE.test(code)) {
      throw new InvalidMeetingUrlError("Unrecognised Google Meet link (expected meet.google.com/abc-defg-hij)");
    }
    return { platform: "google_meet", normalizedUrl: `https://meet.google.com/${code}`, meetingId: code };
  }

  if (isZoomHost(host)) {
    const [kind, meetingNumber] = segments;
    if ((kind !== "j" && kind !== "w") || !meetingNumber || !ZOOM_MEETING_NUMBER.test(meetingNumber)) {
      throw new InvalidMeetingUrlError("Unrecognised Zoom link (expected zoom.us/j/<meeting number>)");
    }
    return { platform: "zoom", normalizedUrl: url.toString(), meetingId: meetingNumber };
  }

  if (host === "teams.microsoft.com") {
    // Classic join links: /l/meetup-join/<thread id>/<context>?context=...
    if (segments[0] !== "l" || segments[1] !== "meetup-join" || !segments[2]) {
      throw new InvalidMeetingUrlError("Unrecognised Microsoft Teams link (expected /l/meetup-join/...)");
    }
    return { platform: "teams", normalizedUrl: url.toString(), meetingId: decodeURIComponent(segments[2]) };
  }

  if (host === "teams.live.com") {
    // Teams (free/consumer) links: /meet/<numeric id>?p=<passcode>
    if (segments[0] !== "meet" || !segments[1] || !/^\d+$/.test(segments[1])) {
      throw new InvalidMeetingUrlError("Unrecognised Microsoft Teams link (expected teams.live.com/meet/<id>)");
    }
    return { platform: "teams", normalizedUrl: url.toString(), meetingId: segments[1] };
  }

  throw new InvalidMeetingUrlError("Unsupported meeting host — only Zoom, Google Meet and Microsoft Teams links are accepted");
}
