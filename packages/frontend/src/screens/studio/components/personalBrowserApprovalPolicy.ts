/**
 * Pure approval-policy helpers for the personal browser. This module has no
 * runtime imports so lightweight surfaces (and component fixtures) can use
 * them without loading the bridge's controller and runtime graph.
 */

export type PersonalBrowserApprovalMode = "ask" | "routine";

/**
 * The Desktop's "routine" is the owner's tier (policy version 2): reading and
 * plain links are free, while forms, purchases, messages and credentials still
 * ask. Older hosts mean the earlier routine, which submits ordinary forms.
 */
export const PERSONAL_BROWSER_OWNER_TIER_POLICY_VERSION = 2;

export type PersonalBrowserApprovalStatus = Pick<InstafyDesktopPersonalBrowserStatus, "approvalModes" | "approvalPolicyVersion">;

export function personalBrowserRoutineAvailable(status: PersonalBrowserApprovalStatus | null | undefined): boolean {
  return status?.approvalModes?.includes("routine") === true;
}

export function personalBrowserOwnerTier(status: PersonalBrowserApprovalStatus | null | undefined): boolean {
  return personalBrowserRoutineAvailable(status) &&
    typeof status?.approvalPolicyVersion === "number" &&
    status.approvalPolicyVersion >= PERSONAL_BROWSER_OWNER_TIER_POLICY_VERSION;
}

/**
 * The approval mode a start asks the Desktop for.
 * - Nothing chosen yet: routine on an owner-tier Desktop, ask on an older one.
 * - Studio starting the browser by itself asks for routine only from an
 *   owner-tier Desktop and only when the person has not chosen Ask, so it
 *   never requests an older host's routine.
 * - Otherwise (a press, Resume, Retry, Let Octo continue) the person's choice.
 */
export function resolvePersonalBrowserApprovalMode(input: {
  status: PersonalBrowserApprovalStatus | null | undefined;
  choice: PersonalBrowserApprovalMode | null;
  automatic?: boolean;
}): PersonalBrowserApprovalMode {
  if (!personalBrowserRoutineAvailable(input.status)) return "ask";
  const ownerTier = personalBrowserOwnerTier(input.status);
  const preferred = input.choice ?? (ownerTier ? "routine" : "ask");
  if (input.automatic) return ownerTier && preferred === "routine" ? "routine" : "ask";
  return preferred;
}

/**
 * Hosts an owner-tier Desktop may treat as this run's sites, so it does not ask
 * per site for them: valid lowercase host names, at most three, sent only with
 * routine. An older host never receives them.
 */
export function personalBrowserKnownHosts(
  status: PersonalBrowserApprovalStatus | null | undefined,
  approvalMode: PersonalBrowserApprovalMode | undefined,
  hosts: readonly string[] | null | undefined,
): string[] {
  if (approvalMode !== "routine" || !personalBrowserOwnerTier(status) || !hosts) return [];
  const known: string[] = [];
  for (const host of hosts) {
    if (typeof host !== "string") continue;
    const normalized = host.trim().toLowerCase().replace(/\.$/, "");
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized) ||
        normalized.length > 253 || known.includes(normalized)) continue;
    known.push(normalized);
    if (known.length === 3) break;
  }
  return known;
}
