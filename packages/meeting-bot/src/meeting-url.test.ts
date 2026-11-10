import { describe, expect, it } from "vitest";
import { InvalidMeetingUrlError, parseMeetingUrl } from "./meeting-url.js";

describe("parseMeetingUrl", () => {
  it("accepts and normalises a Google Meet link", () => {
    expect(parseMeetingUrl("  https://meet.google.com/ABC-defg-HIJ?authuser=0#x ")).toEqual({
      platform: "google_meet",
      normalizedUrl: "https://meet.google.com/abc-defg-hij",
      meetingId: "abc-defg-hij",
    });
  });

  it("accepts Zoom links on vanity subdomains and keeps the passcode", () => {
    const parsed = parseMeetingUrl("https://acme.zoom.us/j/81234567890?pwd=s3cret");
    expect(parsed.platform).toBe("zoom");
    expect(parsed.meetingId).toBe("81234567890");
    expect(parsed.normalizedUrl).toBe("https://acme.zoom.us/j/81234567890?pwd=s3cret");
  });

  it("accepts classic and consumer Microsoft Teams links", () => {
    const classic = parseMeetingUrl(
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d",
    );
    expect(classic.platform).toBe("teams");
    expect(classic.meetingId).toBe("19:meeting_abc@thread.v2");

    expect(parseMeetingUrl("https://teams.live.com/meet/9876543210?p=abc").meetingId).toBe("9876543210");
  });

  it.each([
    ["not a url", "Not a valid URL"],
    ["http://meet.google.com/abc-defg-hij", "https"],
    ["https://user:pw@meet.google.com/abc-defg-hij", "credentials"],
    ["https://meet.google.com:8443/abc-defg-hij", "port"],
    ["https://meet.google.com/not-a-code", "Google Meet"],
    ["https://meet.google.com/abc-defg-hij/extra", "Google Meet"],
    ["https://zoom.us/j/123", "Zoom"],
    ["https://zoom.us/meeting/schedule", "Zoom"],
    ["https://teams.microsoft.com/_#/calendarv2", "Teams"],
    ["https://example.com/j/81234567890", "Unsupported"],
  ])("rejects %s", (input, messageFragment) => {
    expect(() => parseMeetingUrl(input)).toThrow(InvalidMeetingUrlError);
    expect(() => parseMeetingUrl(input)).toThrow(messageFragment);
  });

  it("rejects lookalike hosts that merely contain a meeting domain", () => {
    for (const input of [
      "https://zoom.us.attacker.example/j/81234567890",
      "https://evilzoom.us/j/81234567890",
      "https://meet.google.com.attacker.example/abc-defg-hij",
      "https://teams.microsoft.com.attacker.example/l/meetup-join/x",
    ]) {
      expect(() => parseMeetingUrl(input), input).toThrow("Unsupported");
    }
  });
});
