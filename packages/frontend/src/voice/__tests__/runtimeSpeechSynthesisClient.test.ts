import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeSpeechBridgeMock = vi.hoisted(() => ({
  nativeSpeechBridgeAvailable: vi.fn(() => false),
  nativeSpeechBridgeSynthesize: vi.fn(),
  shouldUseNativeSpeechBridgeForUrl: vi.fn(() => false),
}));

vi.mock("../../native/nativeSpeechBridge", () => nativeSpeechBridgeMock);
import {
  getRuntimeSpeechSynthesisBackendConfig,
  getRuntimeSpeechSynthesisBackendLabel,
  synthesizeRuntimeSpeech,
} from "../runtimeSpeechSynthesisClient";

beforeEach(() => {
  vi.clearAllMocks();
  nativeSpeechBridgeMock.nativeSpeechBridgeAvailable.mockReturnValue(false);
  nativeSpeechBridgeMock.shouldUseNativeSpeechBridgeForUrl.mockReturnValue(false);
});

describe("getRuntimeSpeechSynthesisBackendConfig", () => {
  it("returns null when no url is configured", () => {
    expect(getRuntimeSpeechSynthesisBackendConfig({})).toBeNull();
  });

  it("normalizes configured env values", () => {
    expect(
      getRuntimeSpeechSynthesisBackendConfig({
        VITE_INSTAFY_SYNTHESIS_URL: " https://speech.example.com/synthesize ",
        VITE_INSTAFY_SYNTHESIS_TOKEN: " secret-token ",
      }),
    ).toEqual({
      url: "https://speech.example.com/synthesize",
      authToken: "secret-token",
    });
  });

  it("derives the synthesis endpoint from a shared speech base url", () => {
    expect(
      getRuntimeSpeechSynthesisBackendConfig({
        VITE_INSTAFY_SPEECH_BASE_URL: " https://speech.example.com/provider/ ",
        VITE_INSTAFY_SPEECH_TOKEN: " shared-token ",
      }),
    ).toEqual({
      url: "https://speech.example.com/provider/synthesize",
      authToken: "shared-token",
    });
  });

  it("prefers a project-scoped speech route over env defaults", () => {
    expect(
      getRuntimeSpeechSynthesisBackendConfig(
        {
          VITE_INSTAFY_SPEECH_BASE_URL: "https://ignored.example.com/provider",
          VITE_INSTAFY_SPEECH_TOKEN: " ignored-token ",
        },
        {
          baseUrl: " https://speech.example.com/provider/ ",
          authToken: " shared-token ",
        },
      ),
    ).toEqual({
      url: "https://speech.example.com/provider/synthesize",
      authToken: "shared-token",
    });
  });
});

describe("getRuntimeSpeechSynthesisBackendLabel", () => {
  it("prefers the hostname for labels", () => {
    expect(
      getRuntimeSpeechSynthesisBackendLabel({
        url: "https://speech.example.com/synthesize",
        authToken: null,
      }),
    ).toBe("speech.example.com");
  });
});

describe("synthesizeRuntimeSpeech", () => {
  it("normalizes audio responses into playback-safe urls when the runtime can create them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "audio/wav",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const originalUrl = globalThis.URL;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:instafy-speech-reply"),
    });

    await expect(
      synthesizeRuntimeSpeech({
        text: "Hello Taylor",
        format: "wav",
        env: {
          VITE_INSTAFY_SYNTHESIS_URL: "https://speech.example.com/synthesize",
        },
      }),
    ).resolves.toEqual({
      audioDataUrl: expect.stringMatching(/^data:audio\/wav;base64,/),
      audioUrl: "blob:instafy-speech-reply",
      mimeType: "audio/wav",
    });

    vi.stubGlobal("URL", originalUrl);
  });

  it("uses the native speech bridge first for loopback routes on native platforms", async () => {
    nativeSpeechBridgeMock.nativeSpeechBridgeAvailable.mockReturnValue(true);
    nativeSpeechBridgeMock.nativeSpeechBridgeSynthesize.mockResolvedValue({
      audioDataUrl: "data:audio/wav;base64,AQID",
      mimeType: "audio/wav",
      contentType: "audio/wav",
      statusCode: 200,
    });

    await expect(
      synthesizeRuntimeSpeech({
        text: "Hello Taylor",
        format: "wav",
        env: {
          VITE_INSTAFY_SYNTHESIS_URL: "http://127.0.0.1:8796/synthesize",
          VITE_INSTAFY_SYNTHESIS_TOKEN: " local-token ",
        },
      }),
    ).resolves.toEqual({
      audioDataUrl: "data:audio/wav;base64,AQID",
      mimeType: "audio/wav",
    });

    expect(nativeSpeechBridgeMock.nativeSpeechBridgeSynthesize).toHaveBeenCalledTimes(1);
  });

  it("uses the native speech bridge for direct LAN routes", async () => {
    nativeSpeechBridgeMock.nativeSpeechBridgeAvailable.mockReturnValue(true);
    nativeSpeechBridgeMock.nativeSpeechBridgeSynthesize.mockResolvedValue({
      audioDataUrl: "data:audio/wav;base64,AQID",
      mimeType: "audio/wav",
      contentType: "audio/wav",
      statusCode: 200,
    });

    await expect(
      synthesizeRuntimeSpeech({
        text: "Hello Taylor",
        format: "wav",
        env: {
          VITE_INSTAFY_SYNTHESIS_URL: "http://192.168.1.25:8796/synthesize",
          VITE_INSTAFY_SYNTHESIS_TOKEN: " local-token ",
        },
      }),
    ).resolves.toEqual({
      audioDataUrl: "data:audio/wav;base64,AQID",
      mimeType: "audio/wav",
    });

    expect(nativeSpeechBridgeMock.nativeSpeechBridgeSynthesize).toHaveBeenCalledWith({
      url: "http://192.168.1.25:8796/synthesize",
      authToken: "local-token",
      body: {
        text: "Hello Taylor",
        voice: null,
        language: null,
        rate: null,
        pitch: null,
        volume: null,
        format: "wav",
      },
    });
  });

  it("falls back to fetch when the native speech bridge fails for direct routes", async () => {
    nativeSpeechBridgeMock.nativeSpeechBridgeAvailable.mockReturnValue(true);
    nativeSpeechBridgeMock.nativeSpeechBridgeSynthesize.mockRejectedValue(
      new Error("The Internet connection appears to be offline."),
    );

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "audio/wav",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const originalUrl = globalThis.URL;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:instafy-speech-reply"),
    });

    await expect(
      synthesizeRuntimeSpeech({
        text: "Hello Taylor",
        format: "wav",
        env: {
          VITE_INSTAFY_SYNTHESIS_URL: "http://127.0.0.1:8796/synthesize",
          VITE_INSTAFY_SYNTHESIS_TOKEN: " local-token ",
        },
      }),
    ).resolves.toEqual({
      audioDataUrl: expect.stringMatching(/^data:audio\/wav;base64,/),
      audioUrl: "blob:instafy-speech-reply",
      mimeType: "audio/wav",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(nativeSpeechBridgeMock.nativeSpeechBridgeSynthesize).toHaveBeenCalledTimes(1);
    vi.stubGlobal("URL", originalUrl);
  });
});
