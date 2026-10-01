import { controllerClient } from "../sdk/instafy";

export interface NewSpaceOrg {
  orgId?: string | null;
  orgSlug?: string | null;
  orgName?: string | null;
}

/**
 * Creates a space on the controller from the New space form. A blank name is
 * sent as no name, never as placeholder words: those are display copy, and a
 * stored placeholder would read as a name someone chose.
 */
export async function createControllerSpace(projectName: string | null | undefined, org?: NewSpaceOrg) {
  const name = projectName?.trim() || undefined;
  const projectInfo = await controllerClient.projects.create({
    projectType: "customer",
    projectName: name,
    orgId: org?.orgId ?? null,
    orgSlug: org?.orgSlug ?? null,
    orgName: org?.orgName ?? null,
  }).catch(() => null);
  return { projectInfo, projectName: name };
}
