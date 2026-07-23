import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapSpeechDependencies,
  describeSpeechServiceConnection,
  describeSpeechTranscriptionBackendRoute,
  readSpeechDependencyStatus,
  readSpeechVoiceOptions,
  resolveSpeechTranscriptionBackend,
  speakTextWithSpeechService,
  transcribeAudioWithSpeechService,
} from "../speechService";

const {
  getLocalProviderForCapabilityMock,
  getLocalProviderSummaryMock,
  callLocalProviderToolMock,
  readLocalProviderResourceMock,
  getRuntimeTranscriptionBackendConfigMock,
  getRuntimeTranscriptionBackendLabelMock,
  transcribeRuntimeAudioMock,
  getRuntimeSpeechSynthesisBackendConfigMock,
  getRuntimeSpeechSynthesisBackendLabelMock,
  synthesizeRuntimeSpeechMock,
  readProjectSpeechRoutesMock,
  readDiscoveredDesktopLanSpeechRoutesMock,
  resolveControllerSpeechProxyRequestMock,
  nativeSpeechBridgeAvailableMock,
  nativeSpeechBridgeHealthMock,
  shouldUseNativeSpeechBridgeForUrlMock,
} = vi.hoisted(() => ({
  getLocalProviderForCapabilityMock: vi.fn(),
  getLocalProviderSummaryMock: vi.fn(),
  callLocalProviderToolMock: vi.fn(),
  readLocalProviderResourceMock: vi.fn(),
  getRuntimeTranscriptionBackendConfigMock: vi.fn(),
  getRuntimeTranscriptionBackendLabelMock: vi.fn(),
  transcribeRuntimeAudioMock: vi.fn(),
  getRuntimeSpeechSynthesisBackendConfigMock: vi.fn(),
  getRuntimeSpeechSynthesisBackendLabelMock: vi.fn(),
  synthesizeRuntimeSpeechMock: vi.fn(),
  readProjectSpeechRoutesMock: vi.fn(),
  readDiscoveredDesktopLanSpeechRoutesMock: vi.fn(),
  resolveControllerSpeechProxyRequestMock: vi.fn(),
  nativeSpeechBridgeAvailableMock: vi.fn(() => false),
  nativeSpeechBridgeHealthMock: vi.fn(),
  shouldUseNativeSpeechBridgeForUrlMock: vi.fn(() => false),
}));

vi.mock("../../capabilities/localProviderHostClient", () => ({
  getLocalProviderForCapability: getLocalProviderForCapabilityMock,
  getLocalProviderSummary: getLocalProviderSummaryMock,
  callLocalProviderTool: callLocalProviderToolMock,
  readLocalProviderResource: readLocalProviderResourceMock,
}));

vi.mock("../runtimeTranscriptionClient", async () => {
  const actual = await vi.importActual<typeof import("../runtimeTranscriptionClient")>(
    "../runtimeTranscriptionClient",
  );
  return {
    ...actual,
    getRuntimeTranscriptionBackendConfig: getRuntimeTranscriptionBackendConfigMock,
    getRuntimeTranscriptionBackendLabel: getRuntimeTranscriptionBackendLabelMock,
    transcribeRuntimeAudio: transcribeRuntimeAudioMock,
  };
});

vi.mock("../runtimeSpeechSynthesisClient", async () => {
  const actual = await vi.importActual<typeof import("../runtimeSpeechSynthesisClient")>(
    "../runtimeSpeechSynthesisClient",
  );
  return {
    ...actual,
    getRuntimeSpeechSynthesisBackendConfig: getRuntimeSpeechSynthesisBackendConfigMock,
    getRuntimeSpeechSynthesisBackendLabel: getRuntimeSpeechSynthesisBackendLabelMock,
    synthesizeRuntimeSpeech: synthesizeRuntimeSpeechMock,
  };
});

vi.mock("../projectSpeechRoute", () => ({
  readProjectSpeechRoutes: readProjectSpeechRoutesMock,
}));

vi.mock("../desktopLanDiscovery", () => ({
  readDiscoveredDesktopLanSpeechRoutes: readDiscoveredDesktopLanSpeechRoutesMock,
}));

vi.mock("../../native/nativeSpeechBridge", () => ({
  nativeSpeechBridgeAvailable: nativeSpeechBridgeAvailableMock,
  nativeSpeechBridgeHealth: nativeSpeechBridgeHealthMock,
  shouldUseNativeSpeechBridgeForUrl: shouldUseNativeSpeechBridgeForUrlMock,
}));

vi.mock("../../services/runtimeController/speech", () => ({
  resolveControllerSpeechProxyRequest: resolveControllerSpeechProxyRequestMock,
}));

describe("speechService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    getLocalProviderForCapabilityMock.mockReset();
    getLocalProviderSummaryMock.mockReset();
    callLocalProviderToolMock.mockReset();
    readLocalProviderResourceMock.mockReset();
    getRuntimeTranscriptionBackendConfigMock.mockReset();
    getRuntimeTranscriptionBackendLabelMock.mockReset();
    transcribeRuntimeAudioMock.mockReset();
    getRuntimeSpeechSynthesisBackendConfigMock.mockReset();
    getRuntimeSpeechSynthesisBackendLabelMock.mockReset();
    synthesizeRuntimeSpeechMock.mockReset();
    readProjectSpeechRoutesMock.mockReset();
    readDiscoveredDesktopLanSpeechRoutesMock.mockReset();
    resolveControllerSpeechProxyRequestMock.mockReset();
    nativeSpeechBridgeAvailableMock.mockReset();
    nativeSpeechBridgeHealthMock.mockReset();
    shouldUseNativeSpeechBridgeForUrlMock.mockReset();
    readProjectSpeechRoutesMock.mockResolvedValue([]);
    readDiscoveredDesktopLanSpeechRoutesMock.mockResolvedValue([]);
    nativeSpeechBridgeAvailableMock.mockReturnValue(false);
    shouldUseNativeSpeechBridgeForUrlMock.mockReturnValue(false);
  });

  it("prefers a discoverable speech provider for transcription", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue({
      id: "speech",
      title: "Speech Tunnel",
      toolAliases: {
        transcribeAudio: "instafy.speech.transcribe_audio",
      },
    });

    await expect(resolveSpeechTranscriptionBackend()).resolves.toEqual({
      kind: "provider",
      label: "Speech Tunnel",
      providerId: "speech",
    });
  });

  it("falls back to the canonical speech provider summary when capability discovery misses", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    getLocalProviderSummaryMock.mockResolvedValue({
      id: "speech",
      title: "Speech Tunnel",
      toolAliases: {
        transcribeAudio: "instafy.speech.transcribe_audio",
      },
    });

    await expect(resolveSpeechTranscriptionBackend()).resolves.toEqual({
      kind: "provider",
      label: "Speech Tunnel",
      providerId: "speech",
    });
  });

  it("falls back to direct http transcription config when no provider exists", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    readProjectSpeechRoutesMock.mockResolvedValue([]);
    readDiscoveredDesktopLanSpeechRoutesMock.mockResolvedValue([]);
    getRuntimeTranscriptionBackendConfigMock.mockReturnValue({
      url: "https://speech.example.com/transcribe",
      authToken: null,
      model: null,
      language: null,
    });
    getRuntimeTranscriptionBackendLabelMock.mockReturnValue("speech.example.com");

    await expect(resolveSpeechTranscriptionBackend()).resolves.toEqual({
      kind: "http",
      label: "speech.example.com",
      providerId: null,
    });
  });

  it("prefers a project-scoped speech route before env-backed http defaults", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    const projectRoutes = [
      {
        baseUrl: "https://project-route.example.com/provider",
        authToken: "route-token",
        connectionType: "tunnel",
        hostMode: "desktop",
        updatedAt: "2026-04-13T12:00:00.000Z",
        source: "project",
      },
    ];
    readProjectSpeechRoutesMock.mockResolvedValue(projectRoutes);
    readDiscoveredDesktopLanSpeechRoutesMock.mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("ok", {
          status: 200,
        }),
      ),
    );
    getRuntimeTranscriptionBackendConfigMock.mockImplementation((_env, routeOverride) => ({
      url: `${routeOverride?.baseUrl}/transcribe`,
      authToken: routeOverride?.authToken ?? null,
      model: null,
      language: null,
    }));
    getRuntimeTranscriptionBackendLabelMock.mockReturnValue("project-route.example.com");

    await expect(
      resolveSpeechTranscriptionBackend({
        projectId: "project-123",
        accessToken: "access-token",
      }),
    ).resolves.toEqual({
      kind: "http",
      label: "project-route.example.com",
      providerId: null,
    });

    expect(readProjectSpeechRoutesMock).toHaveBeenCalledWith("project-123", "access-token");
    expect(readDiscoveredDesktopLanSpeechRoutesMock).toHaveBeenCalledWith(projectRoutes);
  });

  it("keeps a published desktop tunnel route authoritative while it is still warming", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    const projectRoutes = [
      {
        baseUrl: "https://project-route.example.com/provider",
        authToken: "route-token",
        connectionType: "tunnel",
        hostMode: "desktop",
        updatedAt: "2026-04-13T12:00:00.000Z",
        source: "project",
      },
    ];
    readProjectSpeechRoutesMock.mockResolvedValue(projectRoutes);
    readDiscoveredDesktopLanSpeechRoutesMock.mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("desktop tunnel still warming")),
    );
    getRuntimeTranscriptionBackendConfigMock.mockImplementation((_env, routeOverride) =>
      routeOverride?.baseUrl
        ? {
            url: `${routeOverride.baseUrl}/transcribe`,
            authToken: routeOverride.authToken ?? null,
            model: null,
            language: null,
          }
        : {
            url: "http://127.0.0.1:8796/transcribe",
            authToken: null,
            model: null,
            language: null,
          },
    );
    getRuntimeTranscriptionBackendLabelMock.mockImplementation((config) => {
      try {
        return config ? new URL(config.url).hostname : null;
      } catch {
        return config?.url ?? null;
      }
    });

    await expect(
      resolveSpeechTranscriptionBackend({
        projectId: "project-123",
        accessToken: "access-token",
      }),
    ).resolves.toEqual({
      kind: "http",
      label: "project-route.example.com",
      providerId: null,
    });

    expect(getRuntimeTranscriptionBackendConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        baseUrl: "https://project-route.example.com/provider",
        authToken: "route-token",
      }),
    );
  });

  it("probes local tunnel routes through the controller speech proxy", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    const projectRoutes = [
      {
        baseUrl: "http://abc.rt.test:8443",
        authToken: null,
        connectionType: "tunnel",
        hostMode: "desktop",
        updatedAt: "2026-04-15T12:00:00.000Z",
        source: "project",
      },
    ];
    readProjectSpeechRoutesMock.mockResolvedValue(projectRoutes);
    readDiscoveredDesktopLanSpeechRoutesMock.mockResolvedValue([]);
    resolveControllerSpeechProxyRequestMock.mockResolvedValue({
      baseUrl:
        "http://controller.test/projects/project-123/speech/proxy/http%3A%2F%2Fabc.rt.test%3A8443/health",
      headers: {
        authorization: "Bearer access-token",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          transcription: { ready: true },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    getRuntimeTranscriptionBackendConfigMock.mockImplementation((_env, routeOverride) => ({
      url: `${routeOverride?.baseUrl}/transcribe`,
      authToken: routeOverride?.authToken ?? null,
      model: null,
      language: null,
    }));
    getRuntimeTranscriptionBackendLabelMock.mockReturnValue("abc.rt.test");

    await expect(
      resolveSpeechTranscriptionBackend({
        projectId: "project-123",
        accessToken: "access-token",
      }),
    ).resolves.toEqual({
      kind: "http",
      label: "abc.rt.test",
      providerId: null,
    });

    expect(resolveControllerSpeechProxyRequestMock).toHaveBeenCalledWith({
      projectId: "project-123",
      baseUrl: "http://abc.rt.test:8443/health",
      accessToken: "access-token",
      upstreamAuthToken: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://controller.test/projects/project-123/speech/proxy/http%3A%2F%2Fabc.rt.test%3A8443/health",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("prefers a discovered desktop LAN route over the stored project LAN route", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    const projectRoutes = [
      {
        baseUrl: "http://10.0.0.10:8796",
        authToken: "desktop-lan-token",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-14T08:00:00.000Z",
        source: "project",
      },
    ];
    readProjectSpeechRoutesMock.mockResolvedValue(projectRoutes);
    readDiscoveredDesktopLanSpeechRoutesMock.mockResolvedValue([
      {
        baseUrl: "http://instafy-macbook-pro.local:8796",
        authToken: "desktop-lan-token",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-14T08:05:00.000Z",
        source: "desktop_lan_discovery",
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("ok", {
          status: 200,
        }),
      ),
    );
    getRuntimeTranscriptionBackendConfigMock.mockImplementation((_env, routeOverride) => ({
      url: `${routeOverride?.baseUrl}/transcribe`,
      authToken: routeOverride?.authToken ?? null,
      model: null,
      language: null,
    }));
    getRuntimeTranscriptionBackendLabelMock.mockReturnValue("instafy-macbook-pro.local");

    await resolveSpeechTranscriptionBackend({
      projectId: "project-123",
      accessToken: "access-token",
    });

    expect(readDiscoveredDesktopLanSpeechRoutesMock).toHaveBeenCalledWith(projectRoutes);
    expect(getRuntimeTranscriptionBackendConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        baseUrl: "http://instafy-macbook-pro.local:8796",
        authToken: "desktop-lan-token",
      }),
    );
  });

  it("uses the native speech bridge to probe discovered LAN routes on native clients", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    const projectRoutes = [
      {
        baseUrl: "http://192.0.2.10:50031",
        authToken: "desktop-lan-token",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-14T08:00:00.000Z",
        source: "project",
      },
    ];
    readProjectSpeechRoutesMock.mockResolvedValue(projectRoutes);
    readDiscoveredDesktopLanSpeechRoutesMock.mockResolvedValue([
      {
        baseUrl: "http://192.168.1.25:50031",
        authToken: "desktop-lan-token",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-14T08:05:00.000Z",
        source: "desktop_lan_discovery",
      },
    ]);
    nativeSpeechBridgeAvailableMock.mockReturnValue(true);
    shouldUseNativeSpeechBridgeForUrlMock.mockReturnValue(true);
    nativeSpeechBridgeHealthMock.mockResolvedValue({
      payload: null,
      text: "ok",
      contentType: "text/plain",
      statusCode: 200,
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("webview fetch should not decide LAN health")));
    getRuntimeTranscriptionBackendConfigMock.mockImplementation((_env, routeOverride) => ({
      url: `${routeOverride?.baseUrl}/transcribe`,
      authToken: routeOverride?.authToken ?? null,
      model: null,
      language: null,
    }));
    getRuntimeTranscriptionBackendLabelMock.mockReturnValue("192.168.1.25");

    await expect(
      resolveSpeechTranscriptionBackend({
        projectId: "project-123",
        accessToken: "controller-access-token",
      }),
    ).resolves.toEqual({
      kind: "http",
      label: "192.168.1.25",
      providerId: null,
    });

    expect(nativeSpeechBridgeHealthMock).toHaveBeenCalledWith({
      url: "http://192.168.1.25:50031/health",
      authToken: "desktop-lan-token",
    });
  });

  it("does not use the native speech bridge for tunnel routes that are probed through the controller proxy", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    const projectRoutes = [
      {
        baseUrl: "http://abc.rt.test:8443",
        authToken: "route-token",
        connectionType: "tunnel",
        hostMode: "desktop",
        updatedAt: "2026-04-15T12:00:00.000Z",
        source: "project",
      },
    ];
    readProjectSpeechRoutesMock.mockResolvedValue(projectRoutes);
    readDiscoveredDesktopLanSpeechRoutesMock.mockResolvedValue([]);
    nativeSpeechBridgeAvailableMock.mockReturnValue(true);
    shouldUseNativeSpeechBridgeForUrlMock.mockReturnValue(true);
    resolveControllerSpeechProxyRequestMock.mockResolvedValue({
      baseUrl:
        "http://controller.test/projects/project-123/speech/proxy/http%3A%2F%2Fabc.rt.test%3A8443/health",
      headers: {
        authorization: "Bearer access-token",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          transcription: { ready: true },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    getRuntimeTranscriptionBackendConfigMock.mockImplementation((_env, routeOverride) => ({
      url: `${routeOverride?.baseUrl}/transcribe`,
      authToken: routeOverride?.authToken ?? null,
      model: null,
      language: null,
    }));
    getRuntimeTranscriptionBackendLabelMock.mockReturnValue("abc.rt.test");

    await expect(
      resolveSpeechTranscriptionBackend({
        projectId: "project-123",
        accessToken: "access-token",
      }),
    ).resolves.toEqual({
      kind: "http",
      label: "abc.rt.test",
      providerId: null,
    });

    expect(nativeSpeechBridgeHealthMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://controller.test/projects/project-123/speech/proxy/http%3A%2F%2Fabc.rt.test%3A8443/health",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("does not accept an unreachable stored desktop LAN route before native discovery resolves it", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    const projectRoutes = [
      {
        baseUrl: "http://192.0.2.10:8796",
        authToken: "desktop-lan-token",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-14T08:00:00.000Z",
        source: "project",
      },
    ];
    readProjectSpeechRoutesMock.mockResolvedValue(projectRoutes);
    readDiscoveredDesktopLanSpeechRoutesMock.mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unreachable")),
    );
    getRuntimeTranscriptionBackendConfigMock.mockImplementation((_env, routeOverride) =>
      routeOverride?.baseUrl
        ? {
            url: `${routeOverride.baseUrl}/transcribe`,
            authToken: routeOverride.authToken ?? null,
            model: null,
            language: null,
          }
        : null,
    );

    await expect(
      resolveSpeechTranscriptionBackend({
        projectId: "project-123",
        accessToken: "access-token",
      }),
    ).resolves.toEqual({
      kind: "none",
      label: null,
      providerId: null,
    });

    expect(getRuntimeTranscriptionBackendConfigMock).not.toHaveBeenCalled();
  });

  it("does not fall back to env loopback when a stale project LAN route exists", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    const projectRoutes = [
      {
        baseUrl: "http://192.0.2.10:8796",
        authToken: "desktop-lan-token",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-14T08:00:00.000Z",
        source: "project",
      },
    ];
    readProjectSpeechRoutesMock.mockResolvedValue(projectRoutes);
    readDiscoveredDesktopLanSpeechRoutesMock.mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unreachable")),
    );
    getRuntimeTranscriptionBackendConfigMock.mockImplementation((_env, routeOverride) =>
      routeOverride?.baseUrl
        ? {
            url: `${routeOverride.baseUrl}/transcribe`,
            authToken: routeOverride.authToken ?? null,
            model: null,
            language: null,
          }
        : {
            url: "http://127.0.0.1:8796/transcribe",
            authToken: null,
            model: null,
            language: null,
          },
    );

    await expect(
      resolveSpeechTranscriptionBackend({
        projectId: "project-123",
        accessToken: "access-token",
      }),
    ).resolves.toEqual({
      kind: "none",
      label: null,
      providerId: null,
    });

    expect(getRuntimeTranscriptionBackendConfigMock).not.toHaveBeenCalled();
  });

  it("routes audio transcription through the provider tool when available", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue({
      id: "speech",
      title: "Speech Tunnel",
      toolAliases: {
        transcribeAudio: "instafy.speech.transcribe_audio",
      },
    });
    callLocalProviderToolMock.mockResolvedValue({
      value: {
        text: "wake up",
      },
    });

    const transcript = await transcribeAudioWithSpeechService({
      audioBlob: new Blob(["hello"], { type: "audio/webm" }),
      fileName: "sample.webm",
    });

    expect(transcript).toEqual({
      transcript: "wake up",
      backend: {
        kind: "provider",
        label: "Speech Tunnel",
        providerId: "speech",
      },
    });
    expect(callLocalProviderToolMock).toHaveBeenCalledWith(
      "speech",
      "instafy.speech.transcribe_audio",
      expect.objectContaining({
        fileName: "sample.webm",
        mimeType: "audio/webm",
        audioDataUrl: expect.stringMatching(/^data:audio\/webm;base64,/),
      }),
    );
  });

  it("routes audio transcription through the canonical speech provider when capability discovery misses", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    getLocalProviderSummaryMock.mockResolvedValue({
      id: "speech",
      title: "Speech Tunnel",
      toolAliases: {
        transcribeAudio: "instafy.speech.transcribe_audio",
      },
    });
    callLocalProviderToolMock.mockResolvedValue({
      value: {
        text: "wake up",
      },
    });

    const transcript = await transcribeAudioWithSpeechService({
      audioBlob: new Blob(["hello"], { type: "audio/webm" }),
      fileName: "sample.webm",
    });

    expect(transcript).toEqual({
      transcript: "wake up",
      backend: {
        kind: "provider",
        label: "Speech Tunnel",
        providerId: "speech",
      },
    });
    expect(callLocalProviderToolMock).toHaveBeenCalledWith(
      "speech",
      "instafy.speech.transcribe_audio",
      expect.objectContaining({
        fileName: "sample.webm",
        mimeType: "audio/webm",
        audioDataUrl: expect.stringMatching(/^data:audio\/webm;base64,/),
      }),
    );
  });

  it("passes a normalized audio artifact to the direct transcription backend when no provider exists", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    readProjectSpeechRoutesMock.mockResolvedValue([]);
    readDiscoveredDesktopLanSpeechRoutesMock.mockResolvedValue([]);
    getRuntimeTranscriptionBackendConfigMock.mockReturnValue({
      url: "https://speech.example.com/transcribe",
      authToken: null,
      model: null,
      language: null,
    });
    transcribeRuntimeAudioMock.mockResolvedValue("wake up");

    const transcript = await transcribeAudioWithSpeechService({
      audioBlob: new Blob(["hello"], { type: "audio/webm" }),
    });

    expect(transcript).toEqual({
      transcript: "wake up",
      backend: {
        kind: "http",
        label: undefined,
        providerId: null,
      },
    });
    expect(transcribeRuntimeAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: expect.objectContaining({
          fileName: "voice-capture.webm",
          mimeType: "audio/webm",
          blob: expect.any(Blob),
        }),
      }),
    );
  });

  it("falls back to browser speech synthesis when no provider is configured", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    readProjectSpeechRoutesMock.mockResolvedValue([]);
    readDiscoveredDesktopLanSpeechRoutesMock.mockResolvedValue([]);
    getRuntimeSpeechSynthesisBackendConfigMock.mockReturnValue(null);
    const cancel = vi.fn();
    const speak = vi.fn();
    vi.stubGlobal("SpeechSynthesisUtterance", class {
      text: string;
      rate?: number;
      pitch?: number;
      volume?: number;
      lang?: string;
      voice?: SpeechSynthesisVoice;
      constructor(text: string) {
        this.text = text;
      }
    });
    vi.stubGlobal("window", {
      speechSynthesis: {
        cancel,
        speak,
        getVoices: () => [],
      },
    });

    await expect(
      speakTextWithSpeechService({
        text: "Hello Marcus",
      }),
    ).resolves.toEqual({
      spoken: true,
      backend: "browser",
      label: "This device",
    });

    expect(cancel).toHaveBeenCalled();
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("respects explicit browser speech preference before provider speech", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue({
      id: "speech",
      title: "Speech Tunnel",
      toolAliases: {
        synthesizeSpeech: "instafy.speech.synthesize_speech",
      },
    });
    const cancel = vi.fn();
    const speak = vi.fn();
    vi.stubGlobal("SpeechSynthesisUtterance", class {
      text: string;
      constructor(text: string) {
        this.text = text;
      }
    });
    vi.stubGlobal("window", {
      speechSynthesis: {
        cancel,
        speak,
        getVoices: () => [],
      },
    });

    await expect(
      speakTextWithSpeechService({
        text: "Hello Marcus",
        backendPreference: "browser",
      }),
    ).resolves.toEqual({
      spoken: true,
      backend: "browser",
      label: "This device",
    });

    expect(callLocalProviderToolMock).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("falls back to the configured http synthesis backend when no provider exists", async () => {
    getLocalProviderForCapabilityMock.mockResolvedValue(null);
    readProjectSpeechRoutesMock.mockResolvedValue([]);
    getRuntimeSpeechSynthesisBackendConfigMock.mockReturnValue({
      url: "https://speech.example.com/synthesize",
      authToken: null,
    });
    getRuntimeSpeechSynthesisBackendLabelMock.mockReturnValue("speech.example.com");
    synthesizeRuntimeSpeechMock.mockResolvedValue({
      audioDataUrl: "data:audio/wav;base64,AQID",
      mimeType: "audio/wav",
    });
    const play = vi.fn().mockResolvedValue(undefined);
    class AudioMock {
      src: string;
      preload = "";
      ended = false;
      private readonly listeners = new Map<string, Set<() => void>>();
      constructor(src: string) {
        this.src = src;
      }
      addEventListener(type: string, listener: () => void) {
        const listeners = this.listeners.get(type) ?? new Set<() => void>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: () => void) {
        this.listeners.get(type)?.delete(listener);
      }
      dispatch(type: string) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener();
        }
      }
      play = vi.fn().mockImplementation(async () => {
        queueMicrotask(() => {
          this.ended = true;
          this.dispatch("ended");
        });
        return play();
      });
    }
    vi.stubGlobal("Audio", AudioMock as unknown as typeof Audio);

    await expect(
      speakTextWithSpeechService({
        text: "Hello Marcus",
        backendPreference: "provider",
      }),
    ).resolves.toEqual({
      spoken: true,
      backend: "http",
      label: "speech.example.com",
    });

    expect(synthesizeRuntimeSpeechMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello Marcus",
        format: "wav",
      }),
    );
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("reads speech dependency status through the speech provider resource alias", async () => {
    getLocalProviderSummaryMock.mockResolvedValue({
      id: "speech",
      title: "Speech",
      resourceAliases: {
        hostDependencyStatus: "instafy://speech/dependencies",
      },
    });
    readLocalProviderResourceMock.mockResolvedValue({
      value: {
        transcription: { ready: false },
        actions: [{ id: "install_transcription", label: "Install", command: "Instafy-managed speech runtime install" }],
      },
    });

    await expect(readSpeechDependencyStatus()).resolves.toEqual({
      provider: expect.objectContaining({ id: "speech" }),
      value: expect.objectContaining({
        transcription: { ready: false },
      }),
    });
    expect(readLocalProviderResourceMock).toHaveBeenCalledWith("speech", "instafy://speech/dependencies");
  });

  it("describes a reachable local speech provider connection", () => {
    expect(
      describeSpeechServiceConnection({
        localService: {
          health: {
            configured: true,
            reachable: true,
            url: "http://127.0.0.1:8796/health",
          },
        },
        transcription: { ready: true },
        synthesis: { ready: true },
      }),
    ).toEqual({
      route: "local",
      configured: true,
      reachable: true,
      hostLabel: "127.0.0.1",
      badgeLabel: "Provider reachable",
      badgeTone: "success",
      detail: "Speech provider is reachable on this machine and ready for transcription and reply playback.",
    });
  });

  it("describes a reachable but warming speech provider connection", () => {
    expect(
      describeSpeechServiceConnection({
        localService: {
          health: {
            configured: true,
            reachable: true,
            url: "http://127.0.0.1:8796/health",
            detail: "Speech transcription is warming up.",
          },
        },
        transcription: { ready: false },
        synthesis: { ready: true },
      }),
    ).toEqual({
      route: "local",
      configured: true,
      reachable: true,
      hostLabel: "127.0.0.1",
      badgeLabel: "Provider warming",
      badgeTone: "warning",
      detail: "Speech transcription is warming up.",
    });
  });

  it("describes an offline tunneled speech provider connection", () => {
    expect(
      describeSpeechServiceConnection({
        localService: {
          health: {
            configured: true,
            reachable: false,
            url: "https://speech.example.com/health",
            detail: "",
          },
        },
      }),
    ).toEqual({
      route: "tunnel",
      configured: true,
      reachable: false,
      hostLabel: "speech.example.com",
      badgeLabel: "Tunnel offline",
      badgeTone: "warning",
      detail: "Speech provider tunnel at speech.example.com is configured but not reachable yet.",
    });
  });

  it("describes a direct HTTP speech backend route", () => {
    expect(
      describeSpeechTranscriptionBackendRoute({
        backend: {
          kind: "http",
          label: "speech.example.com",
          providerId: null,
        },
      }),
    ).toEqual({
      route: "http",
      configured: true,
      reachable: true,
      hostLabel: "speech.example.com",
      badgeLabel: "HTTP backend",
      badgeTone: "success",
      detail: "Hosted speech is using speech.example.com.",
    });
  });

  it("describes device fallback when a configured provider route is down", () => {
    expect(
      describeSpeechTranscriptionBackendRoute({
        backend: {
          kind: "none",
          label: null,
          providerId: null,
        },
        dependencyStatus: {
          localService: {
            health: {
              configured: true,
              reachable: false,
              url: "https://speech.example.com/health",
            },
          },
        },
      }),
    ).toEqual({
      route: "device",
      configured: false,
      reachable: true,
      hostLabel: null,
      badgeLabel: "Fallback to device",
      badgeTone: "warning",
      detail: "Speech provider tunnel at speech.example.com is not ready, so voice is falling back to this device.",
    });
  });

  it("describes plain device speech when no provider path exists", () => {
    expect(
      describeSpeechTranscriptionBackendRoute({
        backend: {
          kind: "none",
          label: null,
          providerId: null,
        },
      }),
    ).toEqual({
      route: "device",
      configured: false,
      reachable: true,
      hostLabel: null,
      badgeLabel: "This device",
      badgeTone: "neutral",
      detail: "Voice capture and playback are staying on this device.",
    });
  });

  it("reads provider and browser voice options through the speech host layer", async () => {
    getLocalProviderSummaryMock.mockResolvedValue({
      id: "speech",
      title: "Speech",
      resourceAliases: {
        speechVoices: "instafy://speech/voices",
      },
    });
    readLocalProviderResourceMock.mockResolvedValue({
      value: {
        defaultVoice: "Samantha",
        voices: [{ id: "Samantha", label: "Samantha (en_US)", language: "en_US" }],
      },
    });
    vi.stubGlobal("SpeechSynthesisUtterance", class {
      text: string;
      constructor(text: string) {
        this.text = text;
      }
    });
    vi.stubGlobal("window", {
      speechSynthesis: {
        cancel: vi.fn(),
        speak: vi.fn(),
        getVoices: () => [
          {
            voiceURI: "com.apple.voice.compact.en-US.Samantha",
            name: "Samantha",
            lang: "en-US",
            default: true,
          },
        ],
      },
    });

    await expect(readSpeechVoiceOptions()).resolves.toEqual({
      provider: expect.objectContaining({ id: "speech" }),
      providerDefaultVoiceId: "Samantha",
      providerVoices: [
        {
          id: "Samantha",
          label: "Samantha (en_US)",
          language: "en_US",
          source: "provider",
          isDefault: true,
        },
      ],
      browserVoices: [
        {
          id: "com.apple.voice.compact.en-US.Samantha",
          label: "Samantha (en-US)",
          language: "en-US",
          source: "browser",
          isDefault: true,
        },
      ],
    });
    expect(readLocalProviderResourceMock).toHaveBeenCalledWith("speech", "instafy://speech/voices");
  });

  it("routes dependency bootstrap through the provider tool alias", async () => {
    getLocalProviderSummaryMock.mockResolvedValue({
      id: "speech",
      title: "Speech",
      toolAliases: {
        bootstrapHostDependencies: "instafy.speech.bootstrap_host_dependencies",
      },
    });
    callLocalProviderToolMock.mockResolvedValue({
      value: {
        ok: true,
        action: "install_transcription",
        commandsRun: [
          "download https://astral.sh/uv/0.11.6/install.sh -> /home/test/.instafy/speech-host/bin/uv",
          "/home/test/.instafy/speech-host/bin/uv python install 3.12",
          "/home/test/.instafy/speech-host/bin/uv venv /home/test/.instafy/speech-host/venv --python 3.12",
          "/home/test/.instafy/speech-host/bin/uv pip install --python /home/test/.instafy/speech-host/venv/bin/python3 --upgrade insanely-fast-whisper imageio-ffmpeg",
        ],
      },
    });

    await expect(
      bootstrapSpeechDependencies({
        action: "install_transcription",
      }),
    ).resolves.toEqual({
      provider: expect.objectContaining({ id: "speech" }),
      result: {
        ok: true,
        action: "install_transcription",
        commandsRun: [
          "download https://astral.sh/uv/0.11.6/install.sh -> /home/test/.instafy/speech-host/bin/uv",
          "/home/test/.instafy/speech-host/bin/uv python install 3.12",
          "/home/test/.instafy/speech-host/bin/uv venv /home/test/.instafy/speech-host/venv --python 3.12",
          "/home/test/.instafy/speech-host/bin/uv pip install --python /home/test/.instafy/speech-host/venv/bin/python3 --upgrade insanely-fast-whisper imageio-ffmpeg",
        ],
      },
    });
    expect(callLocalProviderToolMock).toHaveBeenCalledWith(
      "speech",
      "instafy.speech.bootstrap_host_dependencies",
      {
        action: "install_transcription",
        dryRun: false,
      },
    );
  });

  it("supports removing the managed speech runtime through the provider bootstrap tool", async () => {
    getLocalProviderSummaryMock.mockResolvedValue({
      id: "speech",
      title: "Speech",
      toolAliases: {
        bootstrapHostDependencies: "instafy.speech.bootstrap_host_dependencies",
      },
    });
    callLocalProviderToolMock.mockResolvedValue({
      value: {
        ok: true,
        action: "remove_transcription",
        commandsRun: ["rm -rf /home/test/.instafy/speech-host"],
      },
    });

    await expect(
      bootstrapSpeechDependencies({
        action: "remove_transcription",
      }),
    ).resolves.toEqual({
      provider: expect.objectContaining({ id: "speech" }),
      result: {
        ok: true,
        action: "remove_transcription",
        commandsRun: ["rm -rf /home/test/.instafy/speech-host"],
      },
    });
    expect(callLocalProviderToolMock).toHaveBeenCalledWith(
      "speech",
      "instafy.speech.bootstrap_host_dependencies",
      {
        action: "remove_transcription",
        dryRun: false,
      },
    );
  });
});
