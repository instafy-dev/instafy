import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: getSessionMock
    }
  }
}));

import { resolveControllerAccessToken } from "../runtimeControllerService";

describe("resolveControllerAccessToken", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("returns the provided token when present", async () => {
    const result = await resolveControllerAccessToken("explicit-token");
    expect(result).toBe("explicit-token");
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("returns the Supabase session token when available", async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: { access_token: "session-token" }
      }
    });

    const result = await resolveControllerAccessToken(null);
    expect(result).toBe("session-token");
    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when session is missing", async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: null
      }
    });

    const result = await resolveControllerAccessToken(null);
    expect(result).toBeNull();
    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when no token sources are available", async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: null
      }
    });
    const result = await resolveControllerAccessToken(null);
    expect(result).toBeNull();
    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });
});
