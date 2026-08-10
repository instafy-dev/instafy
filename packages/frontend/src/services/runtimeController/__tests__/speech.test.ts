import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerRequestContextMock = vi.hoisted(() => vi.fn());

vi.mock("../core", () => ({
  controllerBaseUrl: "http://controller.test",
  normalizeUuidParam: (value: string | null | undefined) =>
    typeof value === "string" && value.trim() ? value.trim() : null,
  resolveControllerRequestContext: resolveControllerRequestContextMock,
  runtimeControllerEnabled: true,
}));

import {
  buildControllerSpeechProxyBaseUrl,
  CONTROLLER_SPEECH_PROXY_UPSTREAM_AUTH_HEADER,
  resolveControllerSpeechProxyRequest,
  shouldUseControllerSpeechProxy,
} from "../speech";

describe("controller speech proxy helpers", () => {
  beforeEach(() => {
    resolveControllerRequestContextMock.mockReset();
    resolveControllerRequestContextMock.mockResolvedValue({
      baseUrl: "http://controller.test",
      accessToken: "controller-token",
      credentialSource: "ambient",
      generation: 1,
    });
  });

  it("only proxies local tunnel hostnames", () => {
    expect(shouldUseControllerSpeechProxy("http://abc.rt.test:8443")).toBe(true);
    expect(shouldUseControllerSpeechProxy("https://speech.example.com")).toBe(false);
    expect(shouldUseControllerSpeechProxy("http://127.0.0.1:8796")).toBe(false);
  });

  it("builds a project-scoped controller speech proxy url", () => {
    expect(
      buildControllerSpeechProxyBaseUrl({
        projectId: "project-123",
        baseUrl: "http://abc.rt.test:8443/",
      }),
    ).toBe(
      "http://controller.test/projects/project-123/speech/proxy/http%3A%2F%2Fabc.rt.test%3A8443",
    );
  });

  it("preserves transcribe as a proxy path instead of encoding it into the base", () => {
    expect(
      buildControllerSpeechProxyBaseUrl({
        projectId: "project-123",
        baseUrl: "http://abc.rt.test:8443/transcribe",
      }),
    ).toBe(
      "http://controller.test/projects/project-123/speech/proxy/http%3A%2F%2Fabc.rt.test%3A8443/transcribe",
    );
  });

  it("preserves nested base paths before the proxied endpoint", () => {
    expect(
      buildControllerSpeechProxyBaseUrl({
        projectId: "project-123",
        baseUrl: "http://abc.rt.test:8443/provider/synthesize",
      }),
    ).toBe(
      "http://controller.test/projects/project-123/speech/proxy/http%3A%2F%2Fabc.rt.test%3A8443%2Fprovider/synthesize",
    );
  });

  it("includes controller auth and forwards upstream auth when present", async () => {
    await expect(
      resolveControllerSpeechProxyRequest({
        projectId: "project-123",
        baseUrl: "http://abc.rt.test:8443/transcribe",
        upstreamAuthToken: "speech-token",
      }),
    ).resolves.toEqual({
      baseUrl:
        "http://controller.test/projects/project-123/speech/proxy/http%3A%2F%2Fabc.rt.test%3A8443/transcribe",
      headers: {
        authorization: "Bearer controller-token",
        [CONTROLLER_SPEECH_PROXY_UPSTREAM_AUTH_HEADER]:
          "Bearer speech-token",
      },
    });
  });

  it("builds the authenticated proxy URL from the same request context as the token", async () => {
    resolveControllerRequestContextMock.mockResolvedValue({
      baseUrl: "https://bound-controller.test/api",
      accessToken: "bound-token",
      credentialSource: "fixed",
      generation: 2,
    });

    await expect(
      resolveControllerSpeechProxyRequest({
        projectId: "project-123",
        baseUrl: "http://abc.rt.test:8443/transcribe",
      }),
    ).resolves.toEqual({
      baseUrl:
        "https://bound-controller.test/api/projects/project-123/speech/proxy/http%3A%2F%2Fabc.rt.test%3A8443/transcribe",
      headers: {
        authorization: "Bearer bound-token",
      },
    });
  });
});
