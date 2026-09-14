// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileProvider, useProfile, type ProfileUpdateInput } from "../ProfileProvider";

const mocks = vi.hoisted(() => ({
  hasSupabaseConfig: false, upsert: vi.fn(), limit: vi.fn(),
  user: { id: "profile-user", user_metadata: {} } as { id: string; user_metadata: Record<string, unknown> } | null
}));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../lib/supabaseClient", () => ({
  get hasSupabaseConfig() { return mocks.hasSupabaseConfig; },
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ limit: mocks.limit }) }),
      upsert: mocks.upsert
    })
  }
}));

describe.each([false, true])("ProfileProvider (server configured: %s)", (server) => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useProfile>;

  function Observer() {
    current = useProfile();
    return <output>{JSON.stringify(current.profile)}</output>;
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.hasSupabaseConfig = server;
    mocks.user = { id: "profile-user", user_metadata: {} };
    mocks.upsert.mockReset().mockResolvedValue({ error: null });
    mocks.limit.mockReset().mockResolvedValue({
      data: [{ full_name: "Alex Teammate", avatar_url: "https://example.test/photo.png" }], error: null
    });
    localStorage.setItem("instafy.profile.profile-user", JSON.stringify({
      fullName: "Alex Teammate", avatarUrl: "https://example.test/photo.png"
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<ProfileProvider><Observer /></ProfileProvider>));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.removeItem("instafy.profile.profile-user");
  });

  async function update(updates: ProfileUpdateInput) {
    await act(async () => {
      expect(await current.updateProfile(updates)).toEqual({ success: true });
    });
  }

  function expectStored(fullName: string | null, avatarUrl: string | null) {
    expect(current.profile).toEqual({ fullName, avatarUrl });
    if (server) {
      expect(mocks.upsert).toHaveBeenLastCalledWith({
        user_id: "profile-user", full_name: fullName, avatar_url: avatarUrl
      }, { onConflict: "user_id" });
    } else {
      expect(JSON.parse(localStorage.getItem("instafy.profile.profile-user")!)).toEqual({ fullName, avatarUrl });
    }
  }

  it("persists explicit photo removal without overwriting an omitted name", async () => {
    await update({ avatarUrl: null });
    expectStored("Alex Teammate", null);
  });

  it("persists an explicitly cleared name without overwriting an omitted photo", async () => {
    await update({ fullName: null });
    expectStored(null, "https://example.test/photo.png");
  });

  it("preserves undefined fields while saving their changed counterpart", async () => {
    await update({ fullName: "New name", avatarUrl: undefined });
    expectStored("New name", "https://example.test/photo.png");
  });
});

describe("ProfileProvider first-use defaults", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useProfile>;
  function Observer() {
    current = useProfile();
    return <output>{JSON.stringify(current.profile)}</output>;
  }
  const saved = (name: string | null, avatar: string | null = null) => ({
    data: [{ full_name: name, avatar_url: avatar }], error: null
  });
  const empty = () => ({ data: [], error: null });
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }
  async function render() {
    await act(async () => root.render(<ProfileProvider><Observer /></ProfileProvider>));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.hasSupabaseConfig = true;
    mocks.user = { id: "new-user", user_metadata: { user_name: "alex-dev", avatar_url: "https://example.test/alex.png" } };
    mocks.upsert.mockReset().mockResolvedValue({ error: null });
    mocks.limit.mockReset();
    localStorage.removeItem("instafy.profile.new-user");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.removeItem("instafy.profile.new-user");
  });

  it("persists provider defaults only for a missing row and reads the stored result", async () => {
    mocks.limit.mockResolvedValueOnce(empty()).mockResolvedValue(saved("alex-dev", "https://example.test/alex.png"));
    await render();
    expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith({
      user_id: "new-user", full_name: "alex-dev", avatar_url: "https://example.test/alex.png"
    }, { onConflict: "user_id", ignoreDuplicates: true });
    expect(current.profile).toEqual({ fullName: "alex-dev", avatarUrl: "https://example.test/alex.png" });
    await act(async () => current.refresh());
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("preserves an existing profile's intentionally cleared name and photo", async () => {
    mocks.limit.mockResolvedValue(saved(null));
    await render();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(current.profile).toEqual({ fullName: null, avatarUrl: null });
  });

  it("uses a concurrent profile winner rather than replacing it with provider data", async () => {
    mocks.limit.mockResolvedValueOnce(empty()).mockResolvedValueOnce(saved("Chosen name"));
    await render();
    expect(current.profile).toEqual({ fullName: "Chosen name", avatarUrl: null });
    expect(mocks.upsert.mock.calls[0][1].ignoreDuplicates).toBe(true);
  });

  it("does not initialize after a failed read and allows retry after a failed insert", async () => {
    mocks.limit.mockResolvedValueOnce({ data: null, error: { message: "Read failed" } });
    await render();
    expect(current.error).toBe("Read failed");
    expect(mocks.upsert).not.toHaveBeenCalled();
    mocks.limit.mockResolvedValue(empty());
    mocks.upsert.mockResolvedValueOnce({ error: { message: "Insert failed" } });
    await act(async () => current.refresh());
    expect(current.error).toBe("Insert failed");
    expect(current.profile).toBeNull();
    mocks.limit.mockResolvedValueOnce(empty()).mockResolvedValueOnce(saved("alex-dev"));
    await act(async () => current.refresh());
    expect(current.profile?.fullName).toBe("alex-dev");
    expect(current.error).toBeNull();
  });

  it("does not write an old account's defaults when its read finishes after account switching", async () => {
    const firstRead = deferred<ReturnType<typeof empty>>();
    mocks.limit.mockReturnValueOnce(firstRead.promise).mockResolvedValueOnce(saved("Other account"));
    await render();
    mocks.user = { id: "other-user", user_metadata: {} };
    await render();
    expect(current.profile?.fullName).toBe("Other account");
    await act(async () => firstRead.resolve(empty()));
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(current.profile?.fullName).toBe("Other account");
  });

  it("does not replace an explicit save with an older initialization reread", async () => {
    const reread = deferred<ReturnType<typeof saved>>();
    mocks.limit.mockResolvedValueOnce(empty()).mockReturnValueOnce(reread.promise);
    await render();
    await act(async () => current.updateProfile({ fullName: "My chosen name", avatarUrl: null }));
    await act(async () => reread.resolve(saved("alex-dev", "https://example.test/alex.png")));
    expect(current.profile).toEqual({ fullName: "My chosen name", avatarUrl: null });
  });

  it("hides the previous account's identity while the next account is loading", async () => {
    mocks.limit.mockResolvedValueOnce(saved("First account"));
    await render();
    const nextRead = deferred<ReturnType<typeof saved>>();
    mocks.limit.mockReturnValueOnce(nextRead.promise);
    mocks.user = { id: "other-user", user_metadata: {} };
    await render();
    expect(current.profile).toBeNull();
    await act(async () => nextRead.resolve(saved("Other account")));
    expect(current.profile?.fullName).toBe("Other account");
  });

  it("does not let refresh or provider metadata changes supersede a pending save", async () => {
    mocks.limit.mockResolvedValue(saved("Original name"));
    await render();
    const save = deferred<{ error: null }>();
    mocks.upsert.mockReturnValueOnce(save.promise);
    let saving!: Promise<{ success: boolean; error?: string }>;
    await act(async () => { saving = current.updateProfile({ fullName: "Chosen name" }); });
    await act(async () => current.refresh({ force: true }));
    mocks.user!.user_metadata = { name: "Provider changed" };
    await render();
    expect(mocks.limit).toHaveBeenCalledTimes(1);
    await act(async () => {
      save.resolve({ error: null });
      expect(await saving).toEqual({ success: true });
    });
    expect(current.profile?.fullName).toBe("Chosen name");
  });

  it("ignores a signed-out refresh callback after another account signs in", async () => {
    mocks.user = null;
    await render();
    const oldRefresh = current.refresh;
    mocks.user = { id: "new-user", user_metadata: {} };
    mocks.limit.mockResolvedValue(saved("Signed in name"));
    await render();
    await act(async () => oldRefresh({ force: true }));
    expect(current.profile?.fullName).toBe("Signed in name");
  });

  it("initializes local-only profiles once and preserves later edits and removals", async () => {
    mocks.hasSupabaseConfig = false;
    await render();
    expect(current.profile?.fullName).toBe("alex-dev");
    await act(async () => current.updateProfile({ fullName: "Chosen name", avatarUrl: null }));
    mocks.user!.user_metadata = { full_name: "Provider changed", avatar_url: "https://example.test/new.png" };
    await render();
    expect(current.profile).toEqual({ fullName: "Chosen name", avatarUrl: null });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
