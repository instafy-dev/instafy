import { beforeEach, describe, expect, it, vi } from "vitest";
import { readProjectSpeechRoute, readProjectSpeechRoutes, writeProjectSpeechRoute, writeProjectSpeechRoutes } from "../projectSpeechRoute";

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

describe("projectSpeechRoute", () => {
  beforeEach(() => {
    listForProjectMock.mockReset();
    upsertMock.mockReset();
  });

  it("returns null when the project has no speech route metadata", async () => {
    listForProjectMock.mockResolvedValue({
      success: true,
      integrations: [],
    });

    await expect(readProjectSpeechRoute("project-123")).resolves.toBeNull();
  });

  it("reads project-scoped speech route metadata from the speech integration", async () => {
    listForProjectMock.mockResolvedValue({
      success: true,
      integrations: [
        {
          id: "speech-1",
          projectId: "project-123",
          provider: "speech",
          status: "available",
          connectionType: "tunnel",
          credentialId: null,
          metadata: {
            speechRoute: {
              baseUrl: " https://speech.example.com/provider/ ",
              authToken: " shared-token ",
              hostMode: "desktop",
              updatedAt: "2026-04-13T12:00:00.000Z",
            },
          },
          requiredScopes: [],
          capabilities: [],
          createdBy: null,
          createdAt: "2026-04-13T12:00:00.000Z",
          updatedAt: "2026-04-13T12:00:00.000Z",
        },
      ],
    });

    await expect(readProjectSpeechRoute("project-123")).resolves.toEqual({
      baseUrl: "https://speech.example.com/provider",
      authToken: "shared-token",
      connectionType: "tunnel",
      hostMode: "desktop",
      updatedAt: "2026-04-13T12:00:00.000Z",
      source: "project",
    });
  });

  it("reads multiple project-scoped speech routes and keeps tunnel as the legacy fallback", async () => {
    listForProjectMock.mockResolvedValue({
      success: true,
      integrations: [
        {
          id: "speech-1",
          projectId: "project-123",
          provider: "speech",
          status: "available",
          connectionType: "tunnel",
          credentialId: null,
          metadata: {
            speechRoute: {
              baseUrl: "https://speech.example.com/provider",
              hostMode: "desktop",
              connectionType: "tunnel",
              updatedAt: "2026-04-13T12:00:00.000Z",
            },
            speechRoutes: [
              {
                baseUrl: "http://192.168.1.20:8796",
                authToken: " lan-token ",
                hostMode: "desktop",
                connectionType: "lan",
                updatedAt: "2026-04-13T12:05:00.000Z",
              },
              {
                baseUrl: "https://speech.example.com/provider",
                hostMode: "desktop",
                connectionType: "tunnel",
                updatedAt: "2026-04-13T12:00:00.000Z",
              },
            ],
          },
          requiredScopes: [],
          capabilities: [],
          createdBy: null,
          createdAt: "2026-04-13T12:00:00.000Z",
          updatedAt: "2026-04-13T12:00:00.000Z",
        },
      ],
    });

    await expect(readProjectSpeechRoutes("project-123")).resolves.toEqual([
      {
        baseUrl: "http://192.168.1.20:8796",
        authToken: "lan-token",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-13T12:05:00.000Z",
        source: "project",
      },
      {
        baseUrl: "https://speech.example.com/provider",
        authToken: null,
        connectionType: "tunnel",
        hostMode: "desktop",
        updatedAt: "2026-04-13T12:00:00.000Z",
        source: "project",
      },
    ]);

    await expect(readProjectSpeechRoute("project-123")).resolves.toEqual({
      baseUrl: "https://speech.example.com/provider",
      authToken: null,
      connectionType: "tunnel",
      hostMode: "desktop",
      updatedAt: "2026-04-13T12:00:00.000Z",
      source: "project",
    });
  });

  it("writes project-scoped speech route metadata to the speech integration", async () => {
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
      writeProjectSpeechRoute(
        "project-123",
        {
          baseUrl: " https://speech.example.com/provider/ ",
          authToken: " shared-token ",
          connectionType: "tunnel",
          hostMode: "desktop",
        },
        "access-token",
      ),
    ).resolves.toEqual({
      success: true,
      scope: "project",
    });

    expect(upsertMock).toHaveBeenCalledWith(
      "project-123",
      "speech",
      expect.objectContaining({
        accessToken: "access-token",
        status: "available",
        connectionType: "tunnel",
        capabilities: ["speech_transcription", "speech_synthesis"],
        metadata: expect.objectContaining({
          speechRoute: expect.objectContaining({
            baseUrl: "https://speech.example.com/provider",
            authToken: "shared-token",
            hostMode: "desktop",
          }),
        }),
      }),
    );
  });

  it("writes multiple project-scoped speech routes while keeping tunnel as the legacy fallback", async () => {
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
      writeProjectSpeechRoutes(
        "project-123",
        [
          {
            baseUrl: "http://192.168.1.20:8796",
            authToken: "lan-token",
            connectionType: "lan",
            hostMode: "desktop",
          },
          {
            baseUrl: "https://speech.example.com/provider",
            connectionType: "tunnel",
            hostMode: "desktop",
          },
        ],
        "access-token",
      ),
    ).resolves.toEqual({
      success: true,
      scope: "project",
    });

    expect(upsertMock).toHaveBeenCalledWith(
      "project-123",
      "speech",
      expect.objectContaining({
        accessToken: "access-token",
        connectionType: "tunnel",
        metadata: expect.objectContaining({
          speechRoute: expect.objectContaining({
            baseUrl: "https://speech.example.com/provider",
            connectionType: "tunnel",
            hostMode: "desktop",
          }),
          speechRoutes: expect.arrayContaining([
            expect.objectContaining({
              baseUrl: "http://192.168.1.20:8796",
              authToken: "lan-token",
              connectionType: "lan",
              hostMode: "desktop",
            }),
            expect.objectContaining({
              baseUrl: "https://speech.example.com/provider",
              connectionType: "tunnel",
              hostMode: "desktop",
            }),
          ]),
        }),
      }),
    );
  });
});
