// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileProvider, useProfile, type ProfileUpdateInput } from "../ProfileProvider";

const mocks = vi.hoisted(() => ({ hasSupabaseConfig: false, upsert: vi.fn(), limit: vi.fn() }));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "profile-user" } }) }));
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
