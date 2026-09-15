/** Count Unicode code points (Array.from(text).length), matching PostgreSQL char_length. */
export const PROFILE_BIO_MAX_LENGTH = 500;

/** Public fields only. Access requires both people to retain access to the selected project. */
export interface ControllerHumanProfile {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
}

export interface ProjectMemberProfileParams {
  projectId: string;
  userId: string;
  signal?: AbortSignal;
}

export function projectMemberProfilePath(params: Pick<ProjectMemberProfileParams, "projectId" | "userId">): string {
  return `/projects/${encodeURIComponent(params.projectId)}/members/${encodeURIComponent(params.userId)}/profile`;
}

/** Hosts supply their authenticated controller transport; this helper never acquires credentials. */
export type HumanProfileRequest = (
  path: string,
  init: { method: "GET"; signal?: AbortSignal },
) => Promise<ControllerHumanProfile>;

export function getProjectMemberProfile(
  request: HumanProfileRequest,
  params: ProjectMemberProfileParams,
): Promise<ControllerHumanProfile> {
  return request(projectMemberProfilePath(params), { method: "GET", signal: params.signal });
}
