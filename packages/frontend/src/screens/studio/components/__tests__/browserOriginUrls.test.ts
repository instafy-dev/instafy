import { describe, expect, it } from "vitest";
import {
  buildBrowserOriginHttpUrl,
  buildBrowserOriginWebSocketUrl,
} from "../browserOriginUrls";

const controllerBaseUrl = "https://controller.example";

describe("Shared Browser origin URLs", () => {
  it("uses the controller endpoint the access-token response returned for a tunnel", () => {
    const endpoint = "https://controller.example/origin/origin-1";
    expect(
      buildBrowserOriginWebSocketUrl({
        endpoint,
        token: "t",
        browserPath: "vnc",
        originId: "origin-1",
        pageId: "page-1",
        controllerBaseUrl,
      }),
    ).toBe("wss://controller.example/origin/origin-1/browser/vnc?token=t&pageId=page-1");
    expect(
      buildBrowserOriginHttpUrl({
        endpoint,
        browserPath: "webrtc/offer",
        originId: "origin-1",
        controllerBaseUrl,
      }),
    ).toBe("https://controller.example/origin/origin-1/browser/webrtc/offer");
  });

  it("keeps no tunnel domain of its own: a public host the controller left as is stays direct", () => {
    for (const endpoint of ["https://k7m2qa.rt.instafy.dev", "https://k7m2qa.instafy.site"]) {
      expect(
        buildBrowserOriginWebSocketUrl({
          endpoint,
          token: "t",
          browserPath: "vnc",
          originId: "origin-1",
          controllerBaseUrl,
        }),
      ).toBe(`${endpoint.replace("https:", "wss:")}/browser/vnc?token=t`);
      expect(
        buildBrowserOriginHttpUrl({
          endpoint,
          browserPath: "webrtc/offer",
          originId: "origin-1",
          controllerBaseUrl,
        }),
      ).toBe(`${endpoint}/browser/webrtc/offer`);
    }
  });

  it("still sends local development hosts through the controller", () => {
    for (const endpoint of [
      "http://abc.rt.test:8443",
      "http://127.0.0.1:54333",
      "http://localhost:4173",
      "http://host.docker.internal:8788",
    ]) {
      expect(
        buildBrowserOriginWebSocketUrl({
          endpoint,
          token: "t",
          browserPath: "collaboration",
          originId: "origin 1",
          controllerBaseUrl,
        }),
      ).toBe("wss://controller.example/origin/origin%201/browser/collaboration?token=t");
      expect(
        buildBrowserOriginHttpUrl({
          endpoint,
          browserPath: "webrtc/offer",
          originId: "origin 1",
          controllerBaseUrl,
        }),
      ).toBe("https://controller.example/origin/origin%201/browser/webrtc/offer");
    }
  });

  it("connects to the endpoint when there is no origin id or controller", () => {
    expect(
      buildBrowserOriginWebSocketUrl({
        endpoint: "http://abc.rt.test:8443/",
        token: "t",
        browserPath: "vnc",
        controllerBaseUrl,
      }),
    ).toBe("ws://abc.rt.test:8443/browser/vnc?token=t");
    expect(
      buildBrowserOriginWebSocketUrl({
        endpoint: "http://abc.rt.test:8443/",
        token: "t",
        browserPath: "vnc",
        originId: "origin-1",
        controllerBaseUrl: null,
      }),
    ).toBe("ws://abc.rt.test:8443/browser/vnc?token=t");
  });
});
