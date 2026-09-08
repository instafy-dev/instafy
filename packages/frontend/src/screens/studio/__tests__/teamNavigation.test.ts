import { describe, expect, it } from "vitest";
import { buildStudioDestinationSearch } from "../../../navigation/studioNavigation";
import { canRememberTeamWorkspace, resolveTeamNavigationScope } from "../teamNavigation";

const teamA = "11111111-1111-4111-8111-111111111111";
const teamB = "22222222-2222-4222-8222-222222222222";

describe("team navigation scope", () => {
  it("keeps an empty team's overview independent of the active space and browser Back", () => {
    const search = buildStudioDestinationSearch("?projectId=space-a&panel=chat&workspaceTab=files", { kind: "panel", panel: "team", teamId: teamB });
    expect(resolveTeamNavigationScope(search, teamA)).toEqual({ page: "team", orgKey: teamB });
    expect(new URLSearchParams(search).has("workspaceTab")).toBe(false);
    expect(resolveTeamNavigationScope("?projectId=space-a&panel=chat", teamA)).toEqual({ page: "workspace", orgKey: teamA });
  });
  it("retains the last team on Home without making Home team-scoped", () => {
    const search = buildStudioDestinationSearch("?projectId=space-a", { kind: "panel", panel: "home", teamId: teamB });
    expect(resolveTeamNavigationScope(search, teamA)).toEqual({ page: "home", orgKey: teamB });
    expect(canRememberTeamWorkspace(search, "space-a", teamA)).toBe(false);
  });
  it("uses explicit team settings and account context without changing workspace ownership", () => {
    expect(resolveTeamNavigationScope(`?panel=settings&settingsTab=org&settingsOrgId=${teamB}`, teamA)).toEqual({ page: "team", orgKey: teamB });
    expect(resolveTeamNavigationScope(`?panel=settings&settingsTab=profile&teamId=${teamB}`, teamA)).toEqual({ page: "account", orgKey: teamB });
    expect(resolveTeamNavigationScope(`?panel=automations&teamId=${teamB}`, teamA)).toEqual({ page: "workspace", orgKey: teamA });
  });
  it("does not save a transient project switch or foreign team as the prior team's work", () => {
    expect(canRememberTeamWorkspace("?projectId=space-b&panel=chat", "space-a", teamA)).toBe(false);
    expect(canRememberTeamWorkspace(`?projectId=space-a&panel=team&teamId=${teamB}`, "space-a", teamA)).toBe(false);
    expect(canRememberTeamWorkspace("?projectId=space-a&conversationId=thread-a", "space-a", teamA)).toBe(true);
    expect(canRememberTeamWorkspace("?panel=chat", null, teamA)).toBe(false);
  });
  it("supports personal scope and ignores malformed scope hints", () => {
    expect(resolveTeamNavigationScope("?panel=team&teamId=personal", teamA).orgKey).toBe("personal");
    expect(resolveTeamNavigationScope("?panel=team&teamId=garbage", teamA).orgKey).toBe(teamA);
  });
});
