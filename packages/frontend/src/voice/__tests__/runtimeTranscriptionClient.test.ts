import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractRuntimeTranscriptionText,
  getRuntimeTranscriptionBackendConfig,
  getRuntimeTranscriptionBackendLabel,
  transcribeRuntimeAudio,
} from "../runtimeTranscriptionClient";

const nativeSpeechBridgeMock = vi.hoisted(() => ({
  nativeSpeechBridgeAvailable: vi.fn(() => false),
  nativeSpeechBridgeTranscribe: vi.fn(),
  shouldUseNativeSpeechBridgeForUrl: vi.fn(() => false),
}));

vi.mock("../../native/nativeSpeechBridge", () => nativeSpeechBridgeMock);

beforeEach(() => {
  vi.clearAllMocks();
  nativeSpeechBridgeMock.nativeSpeechBridgeAvailable.mockReturnValue(false);
  nativeSpeechBridgeMock.shouldUseNativeSpeechBridgeForUrl.mockReturnValue(false);
});

describe("getRuntimeTranscriptionBackendConfig", () => {
  it("returns null when no url is configured", () => {
    expect(getRuntimeTranscriptionBackendConfig({})).toBeNull();
  });

  it("normalizes configured env values", () => {
    expect(
      getRuntimeTranscriptionBackendConfig({
        VITE_INSTAFY_TRANSCRIPTION_URL: " https://speech.example.com/transcribe ",
        VITE_INSTAFY_TRANSCRIPTION_TOKEN: " secret-token ",
        VITE_INSTAFY_TRANSCRIPTION_MODEL: " whisper-large-v3 ",
        VITE_INSTAFY_TRANSCRIPTION_LANGUAGE: " en ",
      }),
    ).toEqual({
      url: "https://speech.example.com/transcribe",
      authToken: "secret-token",
      model: "whisper-large-v3",
      language: "en",
    });
  });

  it("derives the transcription endpoint from a shared speech base url", () => {
    expect(
      getRuntimeTranscriptionBackendConfig({
        VITE_INSTAFY_SPEECH_BASE_URL: " https://speech.example.com/provider/ ",
        VITE_INSTAFY_SPEECH_TOKEN: " shared-token ",
        VITE_INSTAFY_TRANSCRIPTION_MODEL: " whisper-large-v3 ",
      }),
    ).toEqual({
      url: "https://speech.example.com/provider/transcribe",
      authToken: "shared-token",
      model: "whisper-large-v3",
      language: null,
    });
  });

  it("prefers a project-scoped speech route over env defaults", () => {
    expect(
      getRuntimeTranscriptionBackendConfig(
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
      url: "https://speech.example.com/provider/transcribe",
      authToken: "shared-token",
      model: null,
      language: null,
    });
  });
});

describe("getRuntimeTranscriptionBackendLabel", () => {
  it("prefers the hostname for labels", () => {
    expect(
      getRuntimeTranscriptionBackendLabel({
        url: "https://speech.example.com/transcribe",
        authToken: null,
        model: null,
        language: null,
      }),
    ).toBe("speech.example.com");
  });
});

describe("extractRuntimeTranscriptionText", () => {
  it("accepts plain text responses", () => {
    expect(extractRuntimeTranscriptionText(" hello Marcus ")).toBe("hello Marcus");
  });

  it("accepts json text responses", () => {
    expect(extractRuntimeTranscriptionText({ text: "wake up" })).toBe("wake up");
  });

  it("accepts segmented json responses", () => {
    expect(
      extractRuntimeTranscriptionText({
        segments: [{ text: "look" }, { text: "at me" }],
      }),
    ).toBe("look at me");
  });
});

describe("transcribeRuntimeAudio", () => {
  it("uses the native speech bridge for loopback routes on native platforms", async () => {
    nativeSpeechBridgeMock.nativeSpeechBridgeAvailable.mockReturnValue(true);
    nativeSpeechBridgeMock.nativeSpeechBridgeTranscribe.mockResolvedValue({
      payload: { text: "hello marcus" },
      contentType: "application/json",
      statusCode: 200,
    });

    const artifact = {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
      fileName: "voice.wav",
      mimeType: "audio/wav",
      size: 3,
      dataUrl: null,
      objectUrl: null,
    };

    await expect(
      transcribeRuntimeAudio({
        artifact,
        env: {
          VITE_INSTAFY_TRANSCRIPTION_URL: "http://127.0.0.1:8796/transcribe",
          VITE_INSTAFY_TRANSCRIPTION_TOKEN: " local-token ",
        },
      }),
    ).resolves.toBe("hello marcus");

    expect(nativeSpeechBridgeMock.nativeSpeechBridgeTranscribe).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8796/transcribe",
      authToken: "local-token",
      body: expect.objectContaining({
        fileName: "voice.wav",
        model: null,
        language: null,
        audioDataUrl: expect.stringMatching(/^data:audio\/wav;base64,/),
      }),
    });
  });

  it("uses the native speech bridge for direct LAN routes", async () => {
    nativeSpeechBridgeMock.nativeSpeechBridgeAvailable.mockReturnValue(true);
    nativeSpeechBridgeMock.shouldUseNativeSpeechBridgeForUrl.mockReturnValue(true);
    nativeSpeechBridgeMock.nativeSpeechBridgeTranscribe.mockResolvedValue({
      payload: { text: "hello marcus" },
      contentType: "application/json",
      statusCode: 200,
    });

    const artifact = {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
      fileName: "voice.wav",
      mimeType: "audio/wav",
      size: 3,
      dataUrl: null,
      objectUrl: null,
    };

    await expect(
      transcribeRuntimeAudio({
        artifact,
        env: {
          VITE_INSTAFY_TRANSCRIPTION_URL: "http://192.168.1.25:8796/transcribe",
          VITE_INSTAFY_TRANSCRIPTION_TOKEN: " local-token ",
        },
      }),
    ).resolves.toBe("hello marcus");

    expect(nativeSpeechBridgeMock.nativeSpeechBridgeTranscribe).toHaveBeenCalledWith({
      url: "http://192.168.1.25:8796/transcribe",
      authToken: "local-token",
      body: expect.objectContaining({
        fileName: "voice.wav",
        model: null,
        language: null,
        audioDataUrl: expect.stringMatching(/^data:audio\/wav;base64,/),
      }),
    });
  });

  it("falls back to fetch when the native speech bridge fails", async () => {
    nativeSpeechBridgeMock.nativeSpeechBridgeAvailable.mockReturnValue(true);
    nativeSpeechBridgeMock.nativeSpeechBridgeTranscribe.mockRejectedValue(
      new Error("The Internet connection appears to be offline."),
    );

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "hello from fetch fallback" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const artifact = {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
      fileName: "voice.wav",
      mimeType: "audio/wav",
      size: 3,
      dataUrl: null,
      objectUrl: null,
    };

    await expect(
      transcribeRuntimeAudio({
        artifact,
        env: {
          VITE_INSTAFY_TRANSCRIPTION_URL: "http://127.0.0.1:8796/transcribe",
          VITE_INSTAFY_TRANSCRIPTION_TOKEN: " local-token ",
        },
      }),
    ).resolves.toBe("hello from fetch fallback");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
