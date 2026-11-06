import { describe, expect, it } from "vitest";
import { isAllowedPushEndpoint } from "./index";

describe("isAllowedPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://web.push.apple.com/QGuQyavXutnMH",
  ])("allows %s", (url) => expect(isAllowedPushEndpoint(url)).toBe(true));

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",          // not https
    "https://169.254.169.254/latest/meta-data",        // cloud metadata (SSRF)
    "https://localhost/internal",
    "https://fcm.googleapis.com.evil.example/x",       // look-alike host
    "https://evilfcm.googleapis.com.example/x",
    "https://user:pass@fcm.googleapis.com/x",
    "not a url",
  ])("refuses %s", (url) => expect(isAllowedPushEndpoint(url)).toBe(false));

  it("allows explicitly listed test hosts, including the port", () => {
    expect(isAllowedPushEndpoint("https://127.0.0.1:8443/push/x", ["127.0.0.1:8443"])).toBe(true);
    expect(isAllowedPushEndpoint("https://127.0.0.1:9999/push/x", ["127.0.0.1:8443"])).toBe(false);
  });
});
