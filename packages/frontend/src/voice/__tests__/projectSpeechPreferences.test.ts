import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readProjectSpeechPreferences,
  readStoredProjectSpeechPreferences,
  writeProjectSpeechPreferences,
} from "../projectSpeechPreferences";

const { listForProjectMock, upsertMock } = vi.hoisted(() => ({
  listForProjectMock: vi.fn(),
  upsertMock: vi.fn(),
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    integrations: {
      listForProject: listForProjectMock,
      upsert: upsertMock,
    },
  },
}));

function createStorage(entries: Record<string, string> = {}) {
  const state = new Map(Object.entries(entries));
  return {
    getItem: vi.fn((key: string) => state.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      state.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      state.delete(key);
    }),
  };
}

describe("projectSpeechPreferences", () => {
  beforeEach(() => {
    listForProjectMock.mockReset();
    upsertMock.mockReset();
  });

  it("falls back to stored speech preferences when project metadata is unavailable", async () => {
    const storage = createStorage({
      "instafy:project-speech:mode:project-123": "provider",
      "instafy:project-speech:provider-voice:project-123": "alloy",
    });
    listForProjectMock.mockResolvedValue({
      success: false,
      integrations: [],
      error: "offline",
    });

    await expect(readProjectSpeechPreferences("project-123", storage)).resolves.toEqual({
      mode: "provider",
      providerVoiceId: "alloy",
      deviceVoiceId: null,
      updatedAt: null,
      source: "local",
    });
  });

  it("prefers project integration metadata over local storage", async () => {
    const storage = createStorage({
      "instafy:project-speech:mode:project-123": "device",
    });
    listForProjectMock.mockResolvedValue({
      success: true,
      integrations: [
        {
          id: "speech-1",
          projectId: "project-123",
          provider: "speech",
          status: "available",
          connectionType: "local",
          credentialId: null,
          metadata: {
            speechPreferences: {
              mode: "provider",
              providerVoiceId: "nova",
              updatedAt: "2026-04-09T12:00:00.000Z",
            },
          },
          requiredScopes: [],
          capabilities: [],
          createdBy: null,
          createdAt: "2026-04-09T12:00:00.000Z",
          updatedAt: "2026-04-09T12:00:00.000Z",
        },
      ],
    });

    await expect(readProjectSpeechPreferences("project-123", storage)).resolves.toEqual({
      mode: "provider",
      providerVoiceId: "nova",
      deviceVoiceId: null,
      updatedAt: "2026-04-09T12:00:00.000Z",
      source: "project",
    });
  });

  it("writes project-scoped speech preferences to the speech integration", async () => {
    const storage = createStorage();
    listForProjectMock.mockResolvedValue({
      success: true,
      integrations: [],
    });
    upsertMock.mockResolvedValue({
      success: true,
      integration: {
        id: "speech-1",
      },
    });

    await expect(
      writeProjectSpeechPreferences(
        "project-123",
        {
          mode: "provider",
          providerVoiceId: "alloy",
          deviceVoiceId: null,
        },
        storage,
      ),
    ).resolves.toEqual({
      success: true,
      scope: "project",
      source: "project",
    });

    expect(upsertMock).toHaveBeenCalledWith(
      "project-123",
      "speech",
      expect.objectContaining({
        status: "available",
        connectionType: "local",
        capabilities: ["speech_transcription", "speech_synthesis"],
        metadata: expect.objectContaining({
          speechPreferences: expect.objectContaining({
            mode: "provider",
            providerVoiceId: "alloy",
            deviceVoiceId: null,
          }),
        }),
      }),
    );
    expect(storage.setItem).toHaveBeenCalledWith(
      "instafy:project-speech:mode:project-123",
      "provider",
    );
  });

  it("does not create a speech integration when preferences are fully default", async () => {
    const storage = createStorage({
      "instafy:project-speech:mode:project-123": "device",
      "instafy:project-speech:device-voice:project-123": "Samantha",
    });
    listForProjectMock.mockResolvedValue({
      success: true,
      integrations: [],
    });

    await expect(
      writeProjectSpeechPreferences(
        "project-123",
        {
          mode: "auto",
          providerVoiceId: null,
          deviceVoiceId: null,
        },
        storage,
      ),
    ).resolves.toEqual({
      success: true,
      scope: "project",
      source: "default",
    });

    expect(upsertMock).not.toHaveBeenCalled();
    expect(storage.removeItem).toHaveBeenCalledWith("instafy:project-speech:mode:project-123");
    expect(storage.removeItem).toHaveBeenCalledWith("instafy:project-speech:device-voice:project-123");
  });

  it("reads plain stored defaults when no project or storage metadata exists", () => {
    expect(readStoredProjectSpeechPreferences(createStorage(), "project-123")).toEqual({
      mode: "auto",
      providerVoiceId: null,
      deviceVoiceId: null,
      updatedAt: null,
      source: "default",
    });
  });
});
