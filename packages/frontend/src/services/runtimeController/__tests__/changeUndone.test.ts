import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => vi.fn());
vi.mock("../core", () => ({
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: context,
}));
import { recordChangeUndone } from "../changeUndone";

const UNDO = { projectId: "p1", messageId: "m1", paths: ["sites/page/app.js"] };
const NO_WAIT = { retryDelaysMs: [0, 0] };

describe("recordChangeUndone", () => {
  beforeEach(() => context.mockResolvedValue({ baseUrl: "https://controller.invalid", accessToken: "fixture-token" }));
  afterEach(() => vi.unstubAllGlobals());

  it("names the files the Undo put back", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(recordChangeUndone(UNDO, NO_WAIT)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://controller.invalid/projects/p1/messages/m1/undone",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ paths: ["sites/page/app.js"] }),
        headers: expect.objectContaining({ authorization: "Bearer fixture-token", "content-type": "application/json" }),
      }),
    );
  });

  // The Undo already happened: a line lost to the network or to a failure on
  // the controller is sent again, or the next turn would never hear of it.
  it("tries again after a lost or failed try, and never after a refusal", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(recordChangeUndone(UNDO, NO_WAIT)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const refused = vi.fn().mockResolvedValue(new Response("", { status: 403 }));
    vi.stubGlobal("fetch", refused);
    await expect(recordChangeUndone(UNDO, NO_WAIT)).resolves.toBe(false);
    expect(refused).toHaveBeenCalledTimes(1);

    const down = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", down);
    await expect(recordChangeUndone(UNDO, NO_WAIT)).resolves.toBe(false);
    expect(down).toHaveBeenCalledTimes(3);
  });

  it("sends nothing for an Undo that put no file back", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(recordChangeUndone({ ...UNDO, paths: [] }, NO_WAIT)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
