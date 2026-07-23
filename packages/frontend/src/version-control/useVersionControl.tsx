import { useCallback, useMemo, useState } from "react";
import { useStatus } from "../status/useStatus";
import { useCollaboration } from "../collaboration/CollaborationProvider";
import { useVersionControlState } from "./VersionControlProvider";
import { useCode } from "../code/useCode";
import { useProject } from "../projects/useProject";
import {
  linkRepository,
  fetchVersionControlStatus,
  commitSnapshot,
  type LinkRepositoryInput
} from "../services/versionControlService";
import type { CollaborationSettings, VersionControlSettings } from "../types";

interface UseVersionControlResult {
  versionControl: VersionControlSettings;
  collaboration: CollaborationSettings;
  isLinking: boolean;
  isSyncing: boolean;
  handleLinkRepository: (input: LinkRepositoryInput) => Promise<void>;
  handleRefreshStatus: () => Promise<void>;
  handleManualCommit: (message: string) => Promise<void>;
  handleChangeMode: (mode: "managed" | "advanced") => Promise<void>;
  handleToggleCollaboration: (enabled: boolean) => void;
  handleToggleGuestAccess: (allow: boolean) => void;
}

export function useVersionControl(): UseVersionControlResult {
  const { versionControl, setVersionControl } = useVersionControlState();
  const { workspace: codeWorkspace } = useCode();
  const { activeProjectId } = useProject();
  const { showStatus } = useStatus();
  const { collaboration, setEnabled: setCollaborationEnabled, setGuestAccess } = useCollaboration();

  const [isLinking, setIsLinking] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const handleLinkRepository = useCallback(
    async (input: LinkRepositoryInput) => {
      if (!activeProjectId) {
        return;
      }
      setIsLinking(true);
      try {
        const status = await linkRepository(activeProjectId, input);
        setVersionControl((current) => ({
          ...current,
          enabled: true,
          organization: input.organization,
          repository: input.repository,
          branch: status.branch ?? input.branch ?? current.branch ?? "main",
          status: status.status,
          lastSyncedAt: status.lastSyncedAt ?? current.lastSyncedAt,
          repoUrl: status.repoUrl ?? current.repoUrl,
          error: status.error ?? null
        }));
        showStatus("Repository linked.", "success", 3000);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to link repository";
        setVersionControl((current) => ({
          ...current,
          status: "error",
          error: message
        }));
        showStatus(message, "error", 4000);
      } finally {
        setIsLinking(false);
      }
    },
    [activeProjectId, showStatus, setVersionControl]
  );

  const handleRefreshStatus = useCallback(async () => {
    if (!activeProjectId) {
      return;
    }
    setIsSyncing(true);
    try {
      const status = await fetchVersionControlStatus(activeProjectId, {
        organization: versionControl.organization ?? undefined,
        repository: versionControl.repository ?? undefined,
        branch: versionControl.branch ?? undefined
      });
      setVersionControl((current) => ({
        ...current,
        status: status.status,
        lastSyncedAt: status.lastSyncedAt ?? current.lastSyncedAt,
        repoUrl: status.repoUrl ?? current.repoUrl,
        error: status.error ?? current.error
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to refresh repository status";
      showStatus(message, "error", 4000);
    } finally {
      setIsSyncing(false);
    }
  }, [
    activeProjectId,
    showStatus,
    setVersionControl,
    versionControl.branch,
    versionControl.organization,
    versionControl.repository
  ]);

  const handleManualCommit = useCallback(
    async (message: string) => {
      if (!activeProjectId) {
        return;
      }
      const { organization, repository } = versionControl;
      if (!organization || !repository) {
        showStatus("Link a repository before committing.", "error", 3500);
        return;
      }
      setIsSyncing(true);
      try {
        await commitSnapshot({
          projectId: activeProjectId,
          message,
          organization,
          repository,
          branch: versionControl.branch ?? "main",
          files: codeWorkspace.files.map((file) => ({
            path: file.path,
            contents: file.modified
          }))
        });
        setVersionControl((current) => ({
          ...current,
          lastSyncedAt: new Date().toISOString(),
          status: "linked",
          error: null
        }));
        showStatus("Commit synced with repository.", "success", 3500);
      } catch (error) {
        const details = error instanceof Error ? error.message : "Unable to push commit";
        setVersionControl((current) => ({
          ...current,
          status: "error",
          error: details
        }));
        showStatus(details, "error", 4000);
      } finally {
        setIsSyncing(false);
      }
    },
    [
      activeProjectId,
      codeWorkspace.files,
      setVersionControl,
      showStatus,
      versionControl
    ]
  );

  const handleChangeMode = useCallback(
    async (mode: "managed" | "advanced") => {
      setVersionControl((current) => ({
        ...current,
        mode
      }));
      if (mode === "managed" && activeProjectId) {
        await handleLinkRepository({
          organization: "instafy-managed",
          repository: `instafy-${activeProjectId}`,
          branch: "main"
        });
      }
    },
    [activeProjectId, handleLinkRepository, setVersionControl]
  );

  const handleToggleCollaboration = useCallback(
    (enabled: boolean) => {
      setCollaborationEnabled(enabled);
    },
    [setCollaborationEnabled]
  );

  const handleToggleGuestAccess = useCallback(
    (allow: boolean) => {
      setGuestAccess(allow);
    },
    [setGuestAccess]
  );

  return useMemo(
    () => ({
      versionControl,
      collaboration,
      isLinking,
      isSyncing,
      handleLinkRepository,
      handleRefreshStatus,
      handleManualCommit,
      handleChangeMode,
      handleToggleCollaboration,
      handleToggleGuestAccess
    }),
    [
      handleChangeMode,
      handleLinkRepository,
      handleManualCommit,
      handleRefreshStatus,
      handleToggleCollaboration,
      handleToggleGuestAccess,
      isLinking,
      isSyncing,
      collaboration,
      versionControl
    ]
  );
}
