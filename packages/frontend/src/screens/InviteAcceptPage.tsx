import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "../components/Button";
import { Heading } from "../components/Heading";
import { Text } from "../components/Text";
import { getOrgDisplayName } from "../org/orgNaming";
import { useAuth } from "../providers/AuthProvider";
import { controllerClient } from "../sdk/instafy";
import { useStatus } from "../status/useStatus";
import { theme } from "../styles/theme";

type InviteAcceptState = "ready" | "loading" | "success" | "error";

export function InviteAcceptPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { showStatus } = useStatus();
  const { signOut } = useAuth();
  const [state, setState] = useState<InviteAcceptState>("ready");
  // Consent gate: membership is only written after an explicit Join. The page
  // used to auto-accept on mount, so an invitee never saw a decision point --
  // for a link that arrives from a personal email address, the trust-critical
  // moment rendered as a blank spinner. A preview endpoint (org/inviter/role
  // before accepting) needs controller support and is the follow-up.
  const [consented, setConsented] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [accountSwitchPending, setAccountSwitchPending] = useState(false);
  const activeAttemptKeyRef = useRef<string | null>(null);

  const { token, panel } = useMemo(() => {
    try {
      const params = new URLSearchParams(location.search);
      return {
        token: params.get("token")?.trim() ?? "",
        panel: params.get("panel")?.trim() ?? ""
      };
    } catch {
      return { token: "", panel: "" };
    }
  }, [location.search]);

  const inviteTarget = `${location.pathname}${location.search}`;

  useEffect(() => {
    if (!consented) {
      return;
    }
    const attemptKey = `${token}:${retryNonce}`;
    if (activeAttemptKeyRef.current === attemptKey) {
      return;
    }
    activeAttemptKeyRef.current = attemptKey;
    setState("loading");
    setError(null);
    setOrgName(null);

    const acceptInvite = async () => {
      if (!token) {
        if (activeAttemptKeyRef.current !== attemptKey) {
          return;
        }
        setState("error");
        setError("Invite link is missing a token.");
        return;
      }
      try {
        const accepted = await controllerClient.organizations.acceptInvitation({
          token,
        });
        if (activeAttemptKeyRef.current !== attemptKey) {
          return;
        }
        if (!accepted?.orgName) {
          setState("error");
          setError("Unable to accept invite. It may have expired or been canceled.");
          return;
        }
        const displayOrgName = getOrgDisplayName(accepted.orgName);
        setOrgName(displayOrgName);
        setState("success");
        showStatus(`Joined ${displayOrgName}.`, "success", 3000);
        const redirectParams = new URLSearchParams();
        if (accepted.projectId) {
          redirectParams.set("projectId", accepted.projectId);
        }
        if (accepted.conversationId) {
          redirectParams.set("conversationControllerId", accepted.conversationId);
        }
        if (panel) {
          redirectParams.set("panel", panel);
        }
        const query = redirectParams.toString();
        navigate(query ? `/studio?${query}` : "/studio", { replace: true });
      } catch (err) {
        if (activeAttemptKeyRef.current !== attemptKey) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unable to accept invite.";
        setState("error");
        setError(message);
      }
    };

    void acceptInvite();
  }, [consented, navigate, panel, retryNonce, showStatus, token]);

  const retryInvite = useCallback(() => {
    setRetryNonce((current) => current + 1);
  }, []);

  const switchAccount = useCallback(async () => {
    if (accountSwitchPending) {
      return;
    }
    setAccountSwitchPending(true);
    try {
      const params = new URLSearchParams();
      params.set("redirect", inviteTarget);
      await signOut();
      navigate(`/login?${params.toString()}`, { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to switch accounts.";
      setError(message);
      showStatus(message, "error", 3500);
      setAccountSwitchPending(false);
    }
  }, [accountSwitchPending, inviteTarget, navigate, showStatus, signOut]);

  const headline =
    state === "ready"
      ? "You're invited"
      : state === "success"
        ? "Invitation accepted"
        : state === "error"
          ? "Invitation error"
          : "Accepting invitation…";
  const description =
    state === "ready"
      ? "Join this workspace on Instafy? Invites are personal links delivered by their sender."
      : state === "loading"
        ? "Just a moment while we connect your account."
        : state === "success"
          ? `You now have access to ${orgName ?? "this team"}.`
          : error ?? "This invite link is invalid or has expired.";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900" data-testid="invite-accept-page">
      <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center px-6 py-16">
        <div className={`w-full max-w-xl p-10 ${theme.surface.card}`}>
          <header className="flex flex-col items-center text-center">
            <Heading level={1} variant="section" className="mt-6">
              {headline}
            </Heading>
            <Text variant="body" tone="secondary" className="mt-2">
              {description}
            </Text>
          </header>

          {state === "ready" ? (
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <Button
                variant="primary"
                radius="full"
                onPress={() => setConsented(true)}
                data-testid="invite-accept-join"
              >
                Join workspace
              </Button>
              <Button
                variant="outline"
                radius="full"
                onPress={() => navigate("/studio", { replace: true })}
                data-testid="invite-accept-decline"
              >
                Not now
              </Button>
            </div>
          ) : null}

          {state === "error" ? (
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <Button
                onPress={retryInvite}
                variant="primary"
                size="lg"
                radius="full"
                className="px-6 py-3 text-sm font-semibold"
                data-testid="invite-accept-retry"
              >
                Try again
              </Button>
              {token ? (
                <Button
                  onPress={() => void switchAccount()}
                  isDisabled={accountSwitchPending}
                  variant="outline"
                  size="lg"
                  radius="full"
                  className="px-6 py-3 text-sm font-semibold"
                  data-testid="invite-accept-switch-account"
                >
                  {accountSwitchPending ? "Signing out…" : "Use another account"}
                </Button>
              ) : null}
              <Button
                onPress={() => navigate("/studio", { replace: true })}
                variant="ghost"
                size="lg"
                radius="full"
                className="px-6 py-3 text-sm font-semibold"
                data-testid="invite-accept-continue"
              >
                Go to studio
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
