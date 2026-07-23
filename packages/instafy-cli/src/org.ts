import kleur from "kleur";
import { resolveControllerUrl, resolveUserAccessTokenWithSource } from "./config.js";
import { formatAuthRejectedError, formatAuthRequiredError } from "./errors.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";

export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  role?: string | null;
}

function getTeamDisplayName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (
    !trimmed ||
    trimmed === "Personal organization" ||
    trimmed === "Personal team" ||
    trimmed === "Personal workspace"
  ) {
    return "Personal";
  }
  return trimmed;
}

export async function listOrganizations(params: {
  controllerUrl?: string;
  accessToken?: string;
  json?: boolean;
}): Promise<OrgSummary[]> {
  const controllerUrl = resolveControllerUrl({ controllerUrl: params.controllerUrl ?? null });
  const resolved = resolveUserAccessTokenWithSource({ accessToken: params.accessToken ?? null });

  if (!resolved.token) {
    throw formatAuthRequiredError({ retryCommand: "instafy team list" });
  }

  const { response } = await fetchWithControllerAuth({
    url: `${controllerUrl}/orgs`,
    accessToken: resolved.token,
    tokenSource: resolved.source,
    profile: resolved.profile,
    cwd: process.cwd(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: text,
        retryCommand: "instafy team list",
      });
    }
    throw new Error(`Team list failed (${response.status} ${response.statusText}): ${text}`);
  }

  const body = (await response.json()) as { orgs?: OrgSummary[] };
  const orgs = Array.isArray(body.orgs) ? body.orgs : [];

  if (params.json) {
    console.log(JSON.stringify(orgs, null, 2));
  } else {
    if (orgs.length === 0) {
      console.log(kleur.yellow("No teams found for this account."));
    } else {
      for (const org of orgs) {
        const role = org.role ? ` [${org.role}]` : "";
        console.log(`${kleur.green(getTeamDisplayName(org.name))} (${org.id}${role})`);
      }
    }
  }

  return orgs;
}
