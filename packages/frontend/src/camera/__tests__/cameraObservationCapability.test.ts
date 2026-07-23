import { describe, expect, it } from "vitest";
import {
  resolveCameraObservationPrompt,
  resolveVisualQuestionPrompt,
} from "../cameraObservationCapability";

describe("camera observation capability", () => {
  it("parses single-photo prompts", () => {
    expect(resolveCameraObservationPrompt("@octo take a photo")).toMatchObject({
      mode: "single",
      lens: "rear",
      count: 1,
    });
    expect(resolveCameraObservationPrompt("@octo capture a front selfie")).toMatchObject({
      mode: "single",
      lens: "front",
      count: 1,
    });
  });

  it("parses short photo-series prompts", () => {
    expect(resolveCameraObservationPrompt("@octo take 3 rear photos")).toMatchObject({
      mode: "series",
      lens: "rear",
      count: 3,
    });
    expect(resolveCameraObservationPrompt("@octo capture a burst of photos")).toMatchObject({
      mode: "series",
      count: 3,
    });
  });

  it("ignores non-camera prompts", () => {
    expect(resolveCameraObservationPrompt("@octo hello")).toBeNull();
    expect(resolveCameraObservationPrompt("@octo tell me about my camera roll")).toBeNull();
  });

  it("does not treat visual questions as capture prompts", () => {
    expect(resolveCameraObservationPrompt("what fruit is this?")).toBeNull();
    expect(resolveCameraObservationPrompt("hey camera, what do you see?")).toBeNull();
  });
});

describe("visual question prompt matching (answer_visual_question)", () => {
  it("matches the core visual question phrasings", () => {
    expect(resolveVisualQuestionPrompt("what fruit is this?")).not.toBeNull();
    expect(resolveVisualQuestionPrompt("what food is this?")).not.toBeNull();
    expect(resolveVisualQuestionPrompt("what object is this?")).not.toBeNull();
    expect(resolveVisualQuestionPrompt("what do you see?")).not.toBeNull();
    expect(resolveVisualQuestionPrompt("what can you see?")).not.toBeNull();
    expect(resolveVisualQuestionPrompt("what am i holding?")).not.toBeNull();
    expect(resolveVisualQuestionPrompt("what am I showing you?")).not.toBeNull();
    expect(resolveVisualQuestionPrompt("look at this")).not.toBeNull();
    expect(resolveVisualQuestionPrompt("tell me what this is")).not.toBeNull();
  });

  it("does not hijack bare what-is-this prompts about non-visual subjects", () => {
    // Bare "what is this"/"what's this" were removed on purpose: they matched
    // prompts that have nothing to do with the camera.
    expect(resolveVisualQuestionPrompt("what is this error in my logs?")).toBeNull();
    expect(resolveVisualQuestionPrompt("what's this setting for?")).toBeNull();
    expect(resolveVisualQuestionPrompt("what is this song?")).toBeNull();
    expect(resolveVisualQuestionPrompt("what is this?")).toBeNull();
    expect(resolveVisualQuestionPrompt("what's this?")).toBeNull();
  });

  it("tolerates lead-ins before the question", () => {
    expect(resolveVisualQuestionPrompt("hey camera, what fruit is this?")).not.toBeNull();
    expect(resolveVisualQuestionPrompt("@vision ok buddy, look at this!")).not.toBeNull();
    expect(resolveVisualQuestionPrompt("Camera — WHAT DO YOU SEE right now?")).not.toBeNull();
  });

  it("keeps the user question text for the classifier", () => {
    const resolved = resolveVisualQuestionPrompt("@vision hey, what fruit is this?");
    expect(resolved?.question).toBe("hey, what fruit is this?");
    expect(resolved?.normalizedPrompt).toBe("hey, what fruit is this?");
  });

  it("does not match plain photo-capture prompts", () => {
    expect(resolveVisualQuestionPrompt("take a photo")).toBeNull();
    expect(resolveVisualQuestionPrompt("@octo take a photo")).toBeNull();
    expect(resolveVisualQuestionPrompt("@octo capture a front selfie")).toBeNull();
    expect(resolveVisualQuestionPrompt("@octo take 3 rear photos")).toBeNull();
  });

  it("ignores unrelated questions", () => {
    expect(resolveVisualQuestionPrompt("what is the weather today?")).toBeNull();
    expect(resolveVisualQuestionPrompt("@octo hello")).toBeNull();
    expect(resolveVisualQuestionPrompt("")).toBeNull();
  });
});
