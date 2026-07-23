import { describe, expect, it } from "vitest";
import {
  createAudioArtifactFromBlob,
  encodeAudioArtifactDataUrl,
  guessAudioFileExtension,
} from "../audioArtifact";

describe("audioArtifact", () => {
  it("guesses common audio file extensions", () => {
    expect(guessAudioFileExtension("audio/webm;codecs=opus")).toBe(".webm");
    expect(guessAudioFileExtension("audio/wav")).toBe(".wav");
    expect(guessAudioFileExtension("audio/mpeg")).toBe(".mp3");
  });

  it("creates a normalized audio artifact from a blob", () => {
    const artifact = createAudioArtifactFromBlob(new Blob(["hello"], { type: "audio/webm" }), {
      baseName: "voice-capture",
    });

    expect(artifact.mimeType).toBe("audio/webm");
    expect(artifact.fileName).toBe("voice-capture.webm");
  });

  it("encodes an audio artifact as a data url", async () => {
    const artifact = createAudioArtifactFromBlob(new Blob(["hi"], { type: "audio/wav" }), {
      fileName: "fixture.wav",
    });

    await expect(encodeAudioArtifactDataUrl(artifact)).resolves.toMatch(/^data:audio\/wav;base64,/);
  });
});
