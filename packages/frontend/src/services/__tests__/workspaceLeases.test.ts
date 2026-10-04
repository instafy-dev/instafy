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
  it("throws a typed error with the status and the same message as before", async () => {
    const message = "project currently leased by someone until later";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message }), { status: 409 })));
    const error = await acquireWorkspaceLease({ projectId: "p" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControllerApiError);
    expect(error).toBeInstanceOf(Error);
    expect((error as ControllerApiError).status).toBe(409);
    expect((error as Error).message).toBe(message);
  });
});
