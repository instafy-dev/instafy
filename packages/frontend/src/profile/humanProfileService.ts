import {
  getProjectMemberProfile,
  type ControllerHumanProfile,
  type ProjectMemberProfileParams,
} from "@instafy/sdk/human-profiles";
import { readControllerError, resolveControllerRequestContext, runtimeControllerEnabled } from "../services/runtimeController/core";
import { createControllerReadBudget } from "../services/runtimeController/readBudget";

export async function fetchHumanProfile(
  params: ProjectMemberProfileParams & { accessToken: string },
): Promise<ControllerHumanProfile> {
  if (!runtimeControllerEnabled) throw new Error("Profiles are unavailable on this controller.");
  const budget = createControllerReadBudget(params.signal);
  try {
    const context = await budget.wait(() => resolveControllerRequestContext(params.accessToken));
    if (!context.baseUrl || !context.accessToken) throw new Error("Sign in to view this profile.");
    return await getProjectMemberProfile(async (path, init) => {
      const response = await budget.wait(() => fetch(`${context.baseUrl}${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${context.accessToken}`, accept: "application/json" },
        signal: budget.signal,
      }));
      if (!response.ok) {
        throw new Error(await budget.wait(() => readControllerError(response, "Unable to load this profile.", context)));
      }
      const value: unknown = await budget.wait(() => response.json());
      if (!value || typeof value !== "object") throw new Error("Invalid profile response.");
      const profile = value as ControllerHumanProfile;
      if (profile.userId !== params.userId || ![profile.displayName, profile.avatarUrl, profile.bio]
        .every((field) => field === null || typeof field === "string")) {
        throw new Error("Invalid profile response.");
      }
      return { userId: profile.userId, displayName: profile.displayName, avatarUrl: profile.avatarUrl, bio: profile.bio };
    }, params);
  } finally {
    budget.dispose();
  }
}
