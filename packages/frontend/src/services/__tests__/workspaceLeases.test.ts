import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtimeController/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtimeController/core")>()),
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: async () => ({
    baseUrl: "https://controller.test",
    accessToken: "session",
    credentialSource: "fixed",
    generation: 0,
  }),
}));

import { ControllerApiError } from "../runtimeController/core";
import { acquireWorkspaceLease } from "../runtimeController/workspaceLeases";

afterEach(() => vi.unstubAllGlobals());

describe("acquireWorkspaceLease", () => {
  it("throws a typed lease_conflict without the holder's id", async () => {
    const holder = "0f8b2c1e-1111-4222-8333-444455556666";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: `project currently leased by ${holder} until 2026-10-04T10:00:00Z` }), {
          status: 409,
        }),
      ),
    );
    const error = await acquireWorkspaceLease({ projectId: "p" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControllerApiError);
    expect(error).toBeInstanceOf(Error);
    expect((error as ControllerApiError).status).toBe(409);
    expect((error as ControllerApiError).code).toBe("lease_conflict");
    expect((error as Error).message).toBe("project currently leased by another session until 2026-10-04T10:00:00Z");
    expect(JSON.stringify(error)).not.toContain(holder);
    expect(String((error as Error).message)).not.toContain(holder);
  });

  it("redacts the controller's unknown-actor wording too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "project currently leased by unknown actor until later" }), { status: 409 })),
    );
    const error = (await acquireWorkspaceLease({ projectId: "p" }).catch((caught: unknown) => caught)) as Error;
    expect(error.message).toBe("project currently leased by another session until later");
  });

  it("keeps other failures as they were", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "db down" }), { status: 500 })));
    const error = (await acquireWorkspaceLease({ projectId: "p" }).catch((caught: unknown) => caught)) as ControllerApiError;
    expect(error.status).toBe(500);
    expect(error.message).toBe("db down");
    expect(error.code).toBeNull();
  });
});
