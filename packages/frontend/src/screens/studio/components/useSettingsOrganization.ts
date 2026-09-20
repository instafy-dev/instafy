import { useCallback, useEffect, useState } from "react";
import { listControllerOrganizations, type ControllerOrgSummary } from "../../../services/runtimeController/projects";

/** Organization selection is independent of project membership, including empty teams. */
export function useSettingsOrganization({
  enabled, userId, projectOrganizationId, organizationId, selectOrganization,
}: {
  enabled: boolean;
  userId: string | null;
  projectOrganizationId: string | null;
  organizationId?: string | null;
  selectOrganization: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{ userId: string | null; organizations: ControllerOrgSummary[] }>({ userId: null, organizations: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestedId = (selectOrganization ? organizationId?.trim() : null) || projectOrganizationId;
  const [selection, setSelection] = useState<{ requestedId: string | null; userId: string | null; id: string } | null>(null);
  // A later URL target supersedes the local selector. In particular, Back must
  // not revive a previous selection that happened to start from that URL.
  if (selection && (selection.requestedId !== requestedId || selection.userId !== userId)) {
    setSelection(null);
  }
  const refresh = useCallback(() => setRefreshVersion((value) => value + 1), []);

  useEffect(() => {
    window.addEventListener("instafy:orgs-updated", refresh);
    return () => window.removeEventListener("instafy:orgs-updated", refresh);
  }, [refresh]);

  useEffect(() => {
    const abort = new AbortController();
    if (!enabled || !userId) {
      setSnapshot({ userId, organizations: [] });
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    void listControllerOrganizations({ signal: abort.signal, throwOnError: true })
      .then((organizations) => {
        if (!abort.signal.aborted) setSnapshot({ userId, organizations });
      })
      .catch(() => {
        if (!abort.signal.aborted) setError("Couldn't load teams. Try again.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [enabled, refreshVersion, userId]);

  const organizations = enabled && snapshot.userId === userId ? snapshot.organizations : [];
  const selectedId = selectOrganization && selection?.requestedId === requestedId && selection.userId === userId
    ? selection.id
    : requestedId || (selectOrganization ? organizations[0]?.id ?? null : null);
  const organization = organizations.find((item) => item.id === selectedId) ?? null;
  const checked = enabled && Boolean(userId) && snapshot.userId === userId && !loading && !error;
  return {
    organizations,
    organization,
    selectedId,
    role: checked ? organization?.role?.trim() || null : null,
    checked,
    loading,
    error,
    refresh,
    select: (id: string) => {
      if (organizations.some((item) => item.id === id)) setSelection({ requestedId, userId, id });
    },
  };
}
