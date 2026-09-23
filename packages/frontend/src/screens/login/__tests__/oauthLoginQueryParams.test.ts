import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/supabaseClient", () => ({ hasSupabaseConfig: false, supabase: null, supabaseAnonKey: null }));

import { oauthLoginQueryParams } from "../useNativeGithubAuth";

// Choosing a remembered GitHub account opened GitHub's authorize screen for
// whichever account the browser was signed into, with no way to switch.
// GitHub and Google show their account picker only when asked.
describe("oauthLoginQueryParams", () => {
  it("always asks the provider for its account picker", () => {
    expect(oauthLoginQueryParams(null)).toEqual({ prompt: "select_account" });
  });

  it("keeps the anon key the auth server needs", () => {
    expect(oauthLoginQueryParams("anon-key")).toEqual({ apikey: "anon-key", prompt: "select_account" });
  });
});
