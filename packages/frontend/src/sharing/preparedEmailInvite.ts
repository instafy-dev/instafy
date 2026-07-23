import type { NearbyInviteSharePayload } from "./nearbyInviteShare";

export type PreparedEmailInvite = {
  acceptUrl: string;
  email: string;
  role: string;
};

function describeInviteAccess(role: string): string {
  switch (role.trim().toLowerCase()) {
    case "viewer":
      return "read-only access";
    case "builder":
      return "read and write access";
    case "admin":
      return "admin access";
    case "owner":
      return "owner access";
    default:
      return "access";
  }
}

function buildPreparedInviteIntro(invite: PreparedEmailInvite): string {
  return `I prepared an Instafy invitation for you with ${describeInviteAccess(invite.role)}.`;
}

function buildPreparedInviteMessage(invite: PreparedEmailInvite): string {
  return [
    buildPreparedInviteIntro(invite),
    "",
    `Open the invitation: ${invite.acceptUrl}`,
    "",
    "Instafy did not send this automatically; this message is from me.",
  ].join("\n");
}

export function buildPreparedEmailInviteSharePayload(
  invite: PreparedEmailInvite,
): NearbyInviteSharePayload {
  return {
    title: "Your Instafy invitation",
    text: `${buildPreparedInviteIntro(invite)} Instafy did not send this automatically; this message is from me.`,
    url: invite.acceptUrl,
    dialogTitle: "Share prepared invite",
  };
}

export function buildPreparedEmailInviteMailtoUrl(invite: PreparedEmailInvite): string {
  const recipient = encodeURIComponent(invite.email.trim());
  const subject = encodeURIComponent("Your Instafy invitation");
  const body = encodeURIComponent(buildPreparedInviteMessage(invite));
  return `mailto:${recipient}?subject=${subject}&body=${body}`;
}

export function openPreparedEmailInviteComposer(invite: PreparedEmailInvite): void {
  if (typeof window === "undefined") {
    throw new Error("An email app is not available here.");
  }
  window.open(buildPreparedEmailInviteMailtoUrl(invite), "_blank", "noopener,noreferrer");
}
