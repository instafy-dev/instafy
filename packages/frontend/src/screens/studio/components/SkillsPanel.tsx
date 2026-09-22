import { useStudioNavigationProtection } from "../../../workspace/StudioDrafts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Refresh } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import {
  buildSkillStartMessage,
  humanizeSkillName,
  normalizeSkillName,
} from "../../../conversations/skillCommands";
import { useConversation } from "../../../conversations/useConversation";
import { useProject } from "../../../projects/useProject";
import { useRuntime } from "../../../runtime/useRuntime";
import {
  controllerClient,
  type ControllerSkillDiscoverLane,
  type ControllerSkillDiscoveryItem,
} from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { InstalledSkillsSection } from "./InstalledSkillsSection";
import { SkillsDiscoverySection } from "./SkillsDiscoverySection";
import { SkillsImportModal } from "./SkillsImportModal";
import { SettingsShell, type SettingsCategory } from "./SettingsShell";
import { useSkillsDiscoveryRequest } from "./skillsDiscoveryRequest";
import { useSkillsDiscoveryState } from "./useSkillsDiscoveryState";
import { useSkillsImportFlow } from "./useSkillsImportFlow";

const SKILLS_ROOT_PATH = ".agents/skills";
const SKILL_FILE_NAME = "SKILL.md";
const DISABLED_SKILL_FILE_NAME = "SKILL.disabled.md";
const INSTAFY_COMPAT_MARKER = "<!-- instafy-compat -->";

type SkillStatus = "enabled" | "disabled";

type SkillDocumentDetails = {
  frontmatterName: string | null;
  frontmatterDescription: string | null;
  headingTitle: string | null;
  summaryParagraph: string | null;
  firstImageSource: string | null;
};

type SkillItem = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  iconUrl: string | null;
  status: SkillStatus;
  directoryPath: string;
  filePath: string;
  enabledPath: string;
  disabledPath: string;
};

type SkillsDiscoverLaneFilter = "all" | ControllerSkillDiscoverLane;
type SkillsPrimaryTab = "installed" | "discover";
type SkillsDiscoverySort = "relevance" | "stars_desc" | "name_asc";

const DEFAULT_DISCOVERY_QUERY = "";
const DISCOVERY_RESULT_LIMIT = 16;

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeWorkspacePath(value: string): string {
  const segments = value.replace(/\\+/g, "/").split("/");
  const normalizedSegments: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (normalizedSegments.length > 0) {
        normalizedSegments.pop();
      }
      continue;
    }
    normalizedSegments.push(segment);
  }
  return normalizedSegments.join("/");
}

function getWorkspaceParentPath(value: string): string {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) {
    return "";
  }
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return "";
  }
  return normalized.slice(0, separatorIndex);
}

function parseMarkdownImageTarget(rawTarget: string): string | null {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("<")) {
    const closingIndex = trimmed.indexOf(">");
    if (closingIndex > 1) {
      const enclosed = trimmed.slice(1, closingIndex).trim();
      return enclosed || null;
    }
  }

  const withoutTitle = trimmed
    .replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/, "")
    .trim();
  return withoutTitle || null;
}

function extractFirstMarkdownImageSource(markdown: string): string | null {
  const normalized = markdown.replace(/\r\n/g, "\n");
  let inCodeFence = false;

  for (const rawLine of normalized.split("\n")) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }

    let cursor = 0;
    while (cursor < rawLine.length) {
      const imageStart = rawLine.indexOf("![", cursor);
      if (imageStart < 0) {
        break;
      }
      const altEnd = rawLine.indexOf("]", imageStart + 2);
      if (altEnd < 0 || rawLine.charAt(altEnd + 1) !== "(") {
        cursor = imageStart + 2;
        continue;
      }

      let depth = 0;
      let index = altEnd + 2;
      let found = false;

      while (index < rawLine.length) {
        const char = rawLine.charAt(index);
        if (char === "\\") {
          index += 2;
          continue;
        }
        if (char === "(") {
          depth += 1;
          index += 1;
          continue;
        }
        if (char === ")") {
          if (depth === 0) {
            const candidate = parseMarkdownImageTarget(
              rawLine.slice(altEnd + 2, index),
            );
            if (candidate) {
              return candidate;
            }
            found = true;
            break;
          }
          depth -= 1;
        }
        index += 1;
      }

      cursor = found ? index + 1 : imageStart + 2;
    }
  }

  return null;
}

function isExternalImageSource(value: string): boolean {
  return /^(?:https?:|data:|blob:)/i.test(value.trim());
}

function resolveSkillImagePath(skillFilePath: string, imageSource: string): string | null {
  const source = imageSource.trim();
  if (!source || source.startsWith("#")) {
    return null;
  }
  if (isExternalImageSource(source)) {
    return source;
  }

  const sourcePathOnly = source.split(/[?#]/, 1)[0]?.trim() ?? "";
  if (!sourcePathOnly) {
    return null;
  }

  const normalizedSource = sourcePathOnly.replace(/^\/+/, "");
  const parentPath = getWorkspaceParentPath(skillFilePath);
  const combined = source.startsWith("/")
    ? normalizedSource
    : parentPath
      ? `${parentPath}/${normalizedSource}`
      : normalizedSource;

  const normalizedPath = normalizeWorkspacePath(combined);
  return normalizedPath || null;
}

function stripInstafyCompatibilitySection(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let skippingCompatibilitySection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 && !skippingCompatibilitySection) {
      output.push(rawLine);
      continue;
    }

    if (line.toLowerCase() === INSTAFY_COMPAT_MARKER) {
      continue;
    }

    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const headingText = headingMatch[1]?.trim().toLowerCase() ?? "";
      if (headingText === "instafy compatibility") {
        skippingCompatibilitySection = true;
        continue;
      }
      if (skippingCompatibilitySection) {
        skippingCompatibilitySection = false;
      }
    }

    if (skippingCompatibilitySection) {
      continue;
    }

    output.push(rawLine);
  }

  return output.join("\n");
}

function parseSkillDocumentDetails(markdown: string): SkillDocumentDetails {
  const normalized = markdown.replace(/\r\n/g, "\n");
  let body = normalized;
  let frontmatterName: string | null = null;
  let frontmatterDescription: string | null = null;

  if (normalized.startsWith("---\n")) {
    const frontmatterEnd = normalized.indexOf("\n---\n", 4);
    if (frontmatterEnd >= 0) {
      const frontmatter = normalized.slice(4, frontmatterEnd);
      body = normalized.slice(frontmatterEnd + 5);
      for (const rawLine of frontmatter.split("\n")) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
        if (!match) {
          continue;
        }
        const key = match[1].trim().toLowerCase();
        const value = stripWrappingQuotes(match[2] ?? "");
        if (!value) {
          continue;
        }
        if (key === "name" && !frontmatterName) {
          frontmatterName = value;
        } else if (key === "description" && !frontmatterDescription) {
          frontmatterDescription = value;
        }
      }
    }
  }

  body = stripInstafyCompatibilitySection(body);

  const normalizeInlineText = (value: string): string => {
    return value
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  };

  const truncateSummary = (value: string, maxLength = 150): string => {
    if (value.length <= maxLength) {
      return value;
    }
    const boundary = value.lastIndexOf(" ", maxLength - 1);
    const clipped = boundary >= 48 ? value.slice(0, boundary) : value.slice(0, maxLength - 1);
    return `${clipped.trimEnd()}…`;
  };

  const isMetadataOnlyLine = (value: string): boolean => {
    const match = value.match(/^([A-Za-z][A-Za-z0-9 _-]{0,40}):\s*(.+)$/);
    if (!match) {
      return false;
    }
    const rhs = (match[2] ?? "").trim();
    if (!rhs) {
      return true;
    }
    if (/^(yes|no|true|false|on|off|none|null|n\/a)$/i.test(rhs)) {
      return true;
    }
    if (rhs.split(/\s+/).length <= 2 && rhs.length <= 24) {
      return true;
    }
    if (/^[A-Za-z0-9._/-]{1,24}$/.test(rhs)) {
      return true;
    }
    return false;
  };

  const isInlineSkillMetadataLine = (value: string): boolean => {
    return /^(name|description|version|author|source|homepage|repository|license)\s*:/i.test(
      value,
    );
  };

  let headingTitle: string | null = null;
  let summaryParagraph: string | null = null;
  let inCodeFence = false;
  let parsingParagraph = false;
  const paragraphLines: string[] = [];
  let seenPrimaryHeading = false;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }

    if (!headingTitle && /^#{1,6}\s+/.test(line)) {
      const heading = normalizeInlineText(line.replace(/^#{1,6}\s+/, ""));
      headingTitle = heading.length > 0 ? heading : null;
      seenPrimaryHeading = headingTitle !== null;
      continue;
    }

    if (!summaryParagraph) {
      if (line.length === 0) {
        if (parsingParagraph && paragraphLines.length > 0) {
          const summaryCandidate = normalizeInlineText(paragraphLines.join(" "));
          if (summaryCandidate.length > 0) {
            summaryParagraph = truncateSummary(summaryCandidate);
            break;
          }
          paragraphLines.length = 0;
          parsingParagraph = false;
        } else {
          parsingParagraph = false;
        }
        continue;
      }

      if (/^#{1,6}\s+/.test(line) || line === "---") {
        if (!headingTitle) {
          const heading = normalizeInlineText(line.replace(/^#{1,6}\s+/, ""));
          headingTitle = heading.length > 0 ? heading : null;
          seenPrimaryHeading = headingTitle !== null;
        }
        if (parsingParagraph && paragraphLines.length > 0) {
          const summaryCandidate = normalizeInlineText(paragraphLines.join(" "));
          if (summaryCandidate.length > 0) {
            summaryParagraph = truncateSummary(summaryCandidate);
            break;
          }
        }
        paragraphLines.length = 0;
        parsingParagraph = false;
        continue;
      }

      if (
        seenPrimaryHeading &&
        /^(?:[-*+]\s+|\d+[.)]\s+|>\s+|\|)/.test(line)
      ) {
        continue;
      }
      if (/^<!--.*-->$/.test(line)) {
        continue;
      }
      if (isInlineSkillMetadataLine(line)) {
        continue;
      }
      if (seenPrimaryHeading && isMetadataOnlyLine(line)) {
        continue;
      }

      parsingParagraph = true;
      paragraphLines.push(line);
    }
  }

  if (!summaryParagraph && paragraphLines.length > 0) {
    const summaryCandidate = normalizeInlineText(paragraphLines.join(" "));
    if (summaryCandidate.length > 0) {
      summaryParagraph = truncateSummary(summaryCandidate);
    }
  }

  return {
    frontmatterName,
    frontmatterDescription,
    headingTitle,
    summaryParagraph,
    firstImageSource: extractFirstMarkdownImageSource(body),
  };
}

function resolveDiscoveredSkillSlug(discovered: ControllerSkillDiscoveryItem): string | null {
  const suggested = normalizeSkillName(discovered.suggestedName ?? "");
  if (suggested) {
    return suggested;
  }

  const installSource = (discovered.installSource ?? "").trim();
  if (!installSource) {
    return null;
  }

  try {
    const parsed = new URL(installSource);
    const segments = parsed.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      return null;
    }

    const last = segments[segments.length - 1]?.toLowerCase() ?? "";
    const candidate = last === "skill.md" && segments.length >= 2 ? segments[segments.length - 2] : last;
    const normalized = normalizeSkillName(candidate ?? "");
    return normalized || null;
  } catch {
    return null;
  }
}

function decodeDiscoveryHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function sanitizeDiscoveryCategoryLabel(value: string): string {
  const decoded = decodeDiscoveryHtmlEntities(value);
  const withoutTags = decoded.replace(/<[^>]*>/g, " ");
  return withoutTags.replace(/\s+/g, " ").trim();
}

function normalizeDiscoveryCategory(value: string): string {
  const sanitized = sanitizeDiscoveryCategoryLabel(value).toLowerCase();
  return sanitized || "other";
}

function parseHttpUrl(value: string | null | undefined): URL | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveDiscoverySourceMeta(discovered: ControllerSkillDiscoveryItem): {
  label: string;
  faviconUrl: string | null;
} {
  const sourceLabel = (discovered.sourceLabel ?? "").trim();
  const homepage = parseHttpUrl(discovered.homepage ?? null);
  if (homepage) {
    return {
      label: sourceLabel || homepage.hostname.replace(/^www\./i, ""),
      faviconUrl: `${homepage.origin}/favicon.ico`,
    };
  }

  const installSource = parseHttpUrl(discovered.installSource ?? null);
  if (installSource) {
    return {
      label: sourceLabel || installSource.hostname.replace(/^www\./i, ""),
      faviconUrl: `${installSource.origin}/favicon.ico`,
    };
  }

  if ((discovered.source ?? "").toLowerCase() === "github") {
    return {
      label: sourceLabel || "GitHub",
      faviconUrl: "https://github.com/favicon.ico",
    };
  }
  if ((discovered.source ?? "").toLowerCase() === "playbooks") {
    return {
      label: sourceLabel || "Playbooks",
      faviconUrl: "https://playbooks.com/favicon.ico",
    };
  }

  return {
    label: sourceLabel || "Source",
    faviconUrl: null,
  };
}

export function SkillsPanel() {
  const { activeProjectId } = useProject();
  const { effectiveRuntimeId } = useRuntime();
  const { showStatus } = useStatus();
  const { activeConversationId, assistantEnabled, onInputChange, onSubmit, isAssistantTyping } =
    useConversation();
  const { openPanelTab, requestUrlPush } = useWorkspaceTabs();

  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootstrapPending, setBootstrapPending] = useState(false);
  const [togglePendingSkillId, setTogglePendingSkillId] = useState<string | null>(null);
  const [uninstallPendingSkillId, setUninstallPendingSkillId] = useState<string | null>(null);
  const [activePrimaryTab, setActivePrimaryTab] = useState<SkillsPrimaryTab>("installed");
  const [brokenSkillIcons, setBrokenSkillIcons] = useState<Record<string, true>>({});

  const loadVersionRef = useRef(0);

  const loadSkillFromDirectory = useCallback(
    async (projectId: string, directoryPath: string, directoryName: string): Promise<SkillItem | null> => {
      const directoryEntries = await controllerClient.workspace.files.list({
        projectId,
        path: directoryPath,
        runtimeId: effectiveRuntimeId ?? null,
      });

      if (!directoryEntries) {
        return null;
      }

      const enabledEntry = directoryEntries.find(
        (entry) => entry.kind === "file" && entry.name.toLowerCase() === SKILL_FILE_NAME.toLowerCase(),
      );
      const disabledEntry = directoryEntries.find(
        (entry) =>
          entry.kind === "file" && entry.name.toLowerCase() === DISABLED_SKILL_FILE_NAME.toLowerCase(),
      );

      const status: SkillStatus | null = enabledEntry ? "enabled" : disabledEntry ? "disabled" : null;
      if (!status) {
        return null;
      }

      const enabledPath = `${directoryPath}/${SKILL_FILE_NAME}`;
      const disabledPath = `${directoryPath}/${DISABLED_SKILL_FILE_NAME}`;
      const filePath = status === "enabled" ? enabledPath : disabledPath;

      const skillFile = await controllerClient.workspace.files.read({
        projectId,
        path: filePath,
        runtimeId: effectiveRuntimeId ?? null,
      });

      const content = skillFile?.contentText ?? "";
      const parsed = parseSkillDocumentDetails(content);
      const title = parsed.headingTitle ?? parsed.frontmatterName ?? humanizeSkillName(directoryName);
      const description = parsed.summaryParagraph ?? parsed.frontmatterDescription ?? null;
      const imageSource = parsed.firstImageSource;
      const resolvedImagePath =
        imageSource != null ? resolveSkillImagePath(filePath, imageSource) : null;

      let iconUrl: string | null = null;
      if (resolvedImagePath) {
        if (isExternalImageSource(resolvedImagePath)) {
          iconUrl = resolvedImagePath;
        } else {
          iconUrl = await controllerClient.workspace.files.getRawUrl({
            projectId,
            path: resolvedImagePath,
            runtimeId: effectiveRuntimeId ?? null,
          });
        }
      }

      return {
        id: directoryPath,
        slug: directoryName,
        title,
        description,
        iconUrl,
        status,
        directoryPath,
        filePath,
        enabledPath,
        disabledPath,
      };
    },
    [effectiveRuntimeId],
  );

  const loadSkills = useCallback(async () => {
    const projectId = activeProjectId?.trim() ?? "";
    if (!projectId) {
      setSkills([]);
      setError(null);
      setLoading(false);
      return;
    }

    const currentVersion = loadVersionRef.current + 1;
    loadVersionRef.current = currentVersion;
    setLoading(true);
    setError(null);

    try {
      const rootEntries = await controllerClient.workspace.files.list({
        projectId,
        path: SKILLS_ROOT_PATH,
        runtimeId: effectiveRuntimeId ?? null,
      });

      if (rootEntries === null) {
        throw new Error("Unable to list skills from workspace.");
      }

      const skillDirectories = rootEntries
        .filter((entry) => entry.kind === "directory")
        .sort((a, b) => a.name.localeCompare(b.name));

      const loadedSkills = await Promise.all(
        skillDirectories.map((directory) =>
          loadSkillFromDirectory(projectId, directory.path, directory.name),
        ),
      );

      if (loadVersionRef.current !== currentVersion) {
        return;
      }

      const nextSkills = loadedSkills
        .filter((item): item is SkillItem => Boolean(item))
        .sort((a, b) => {
          if (a.status === b.status) {
            return a.title.localeCompare(b.title);
          }
          return a.status === "enabled" ? -1 : 1;
        });

      setSkills(nextSkills);
      setError(null);
    } catch (loadError) {
      if (loadVersionRef.current !== currentVersion) {
        return;
      }
      const message =
        loadError instanceof Error ? loadError.message : "Failed to load skills.";
      setSkills([]);
      setError(message);
    } finally {
      if (loadVersionRef.current === currentVersion) {
        setLoading(false);
      }
    }
  }, [activeProjectId, effectiveRuntimeId, loadSkillFromDirectory]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleWorkspaceCommit = (event: Event) => {
      const detail =
        event instanceof CustomEvent && event.detail && typeof event.detail === "object"
          ? (event.detail as { projectId?: string })
          : {};
      const committedProjectId = detail.projectId?.trim();
      const activeId = activeProjectId?.trim() ?? "";
      if (committedProjectId && activeId && committedProjectId !== activeId) {
        return;
      }
      void loadSkills();
    };
    window.addEventListener(
      "instafy:workspace-commit",
      handleWorkspaceCommit as EventListener,
    );
    return () => {
      window.removeEventListener(
        "instafy:workspace-commit",
        handleWorkspaceCommit as EventListener,
      );
    };
  }, [activeProjectId, loadSkills]);

  useEffect(() => {
    setBrokenSkillIcons({});
  }, [skills]);

  const {
    importSource,
    setImportSource,
    importName,
    setImportName,
    importOverwrite,
    setImportOverwrite,
    importPending,
    addSkillModalOpen,
    setAddSkillModalOpen,
    queueSkillImportTask,
    handleSubmitImport,
    handleOpenAddSkillModal,
  } = useSkillsImportFlow({
    activeConversationId,
    assistantEnabled,
    onSubmit,
    showStatus,
    loadSkills,
    // Only the toast's "Open chat" action leaves Settings; the flow never navigates.
    onOpenChat: () => openPanelTab("chat"),
  });
  useStudioNavigationProtection(addSkillModalOpen, "skill import", importPending ? undefined : () => setAddSkillModalOpen(false));

  const {
    discoveryQuery,
    setDiscoveryQuery,
    discoveryLaneFilter,
    discoveryCategoryFilter,
    discoverySort,
    discoveryLoading,
    discoveryError,
    discoveryWarnings,
    discoveryLaneCounts,
    totalDiscoveryCount,
    discoveryCategoryOptions,
    preparedDiscoveryResults,
    setDiscoverySort,
    handleDiscoverySearchSubmit,
    handleDiscoveryLaneChange,
    handleDiscoveryCategoryFilterChange,
    markDiscoverySourceIconBroken,
    runDiscoverySearch,
  } = useSkillsDiscoveryState({
    activeProjectId,
    skills,
    discoveryResultLimit: DISCOVERY_RESULT_LIMIT,
    defaultDiscoveryQuery: DEFAULT_DISCOVERY_QUERY,
    activateDiscoverTab: () => {
      setActivePrimaryTab("discover");
    },
    normalizeCategory: normalizeDiscoveryCategory,
    sanitizeCategoryLabel: sanitizeDiscoveryCategoryLabel,
    resolveDiscoveredSkillSlug,
    normalizeSkillName,
    resolveDiscoverySourceMeta,
  });

  // "Search all skills" in the Connect sheet: open Discover with its query,
  // whether this panel was mounted for it or was already open.
  const handleSkillsDiscoveryRequest = useCallback(
    (query: string) => {
      setActivePrimaryTab("discover");
      setDiscoveryQuery(query);
      void runDiscoverySearch({ query });
    },
    [runDiscoverySearch, setDiscoveryQuery],
  );
  useSkillsDiscoveryRequest(handleSkillsDiscoveryRequest);

  const handleBootstrapSkills = useCallback(async () => {
    const projectId = activeProjectId?.trim() ?? "";
    if (!projectId) {
      return;
    }

    setBootstrapPending(true);
    try {
      const result = await controllerClient.projects.bootstrapMemory({
        projectId,
      });
      if (!result) {
        throw new Error("Unable to reach project bootstrap service.");
      }

      if (result.seeded) {
        showStatus(
          `Installed ${result.fileCount} default ${result.fileCount === 1 ? "skill" : "skills"}.`,
          "success",
          3000,
        );
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("instafy:workspace-commit", { detail: { projectId } }),
          );
        }
      } else if (result.reason === "already-present") {
        showStatus("Default skills are already installed.", "info", 3000);
      } else if (result.reason === "workspace-busy") {
        showStatus("Workspace is busy. Retry in a moment.", "warning", 3500);
      } else {
        throw new Error(result.reason ?? "Unable to install default skills.");
      }

      await loadSkills();
    } catch (bootstrapError) {
      const message =
        bootstrapError instanceof Error
          ? bootstrapError.message
          : "Unable to bootstrap default skills.";
      showStatus(message, "error", 4500);
    } finally {
      setBootstrapPending(false);
    }
  }, [activeProjectId, loadSkills, showStatus]);

  // The one navigation in the skills flow: a prefill the user must finish in
  // the composer, so the chat is shown. Nothing is sent.
  const handleDraftSkillPrompt = useCallback(
    (skillSlug: string) => {
      requestUrlPush();
      openPanelTab("chat");
      onInputChange(activeConversationId, `${buildSkillStartMessage(skillSlug)} `);
      showStatus("Drafted /skills start in the composer.", "info", 2500);
    },
    [activeConversationId, onInputChange, openPanelTab, requestUrlPush, showStatus],
  );

  const handleOpenSkillFile = useCallback(
    (skill: SkillItem) => {
      if (typeof window !== "undefined") {
        const detail: {
          path: string;
          projectId?: string | null;
          source?: string;
          markdownView?: "edit" | "preview";
          preferPreview?: boolean;
        } = {
          path: skill.filePath,
          source: "skills-panel",
          projectId: activeProjectId ?? null,
          markdownView: "preview",
          preferPreview: true,
        };
        const runtimeWindow = window as typeof window & {
          __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: typeof detail | null;
        };
        runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = detail;
        openPanelTab("code");
        window.dispatchEvent(new CustomEvent("instafy:open-workspace-file", { detail }));
        return;
      }
    },
    [activeProjectId, openPanelTab],
  );

  const handleToggleSkill = useCallback(
    async (skill: SkillItem, enabled: boolean) => {
      if (!activeProjectId || skill.status === (enabled ? "enabled" : "disabled")) {
        return;
      }
      const projectId = activeProjectId.trim();
      if (!projectId) {
        return;
      }

      const sourcePath = enabled ? skill.disabledPath : skill.enabledPath;
      const targetPath = enabled ? skill.enabledPath : skill.disabledPath;

      setTogglePendingSkillId(skill.id);
      try {
        const sourceFile = await controllerClient.workspace.files.read({
          projectId,
          path: sourcePath,
          runtimeId: effectiveRuntimeId ?? null,
        });
        if (!sourceFile || sourceFile.contentText == null) {
          throw new Error(`Unable to read ${sourcePath}.`);
        }

        const writeResult = await controllerClient.workspace.files.write({
          projectId,
          path: targetPath,
          content: sourceFile.contentText,
          runtimeId: effectiveRuntimeId ?? null,
        });
        if (!writeResult?.ok) {
          throw new Error(`Unable to write ${targetPath}.`);
        }

        const deleteResult = await controllerClient.workspace.files.delete({
          projectId,
          path: sourcePath,
          runtimeId: effectiveRuntimeId ?? null,
        });
        if (!deleteResult?.ok) {
          throw new Error(`Unable to delete ${sourcePath}.`);
        }

        showStatus(
          `${skill.title} is now ${enabled ? "active" : "inactive"}.`,
          "success",
          3000,
        );
        await loadSkills();
      } catch (toggleError) {
        const message =
          toggleError instanceof Error
            ? toggleError.message
            : "Unable to update skill state.";
        showStatus(message, "error", 4500);
      } finally {
        setTogglePendingSkillId(null);
      }
    },
    [activeProjectId, effectiveRuntimeId, loadSkills, showStatus],
  );

  const handleUninstallSkill = useCallback(
    async (skill: SkillItem) => {
      const projectId = activeProjectId?.trim() ?? "";
      if (!projectId) {
        showStatus("Select a space before uninstalling skills.", "warning", 3000);
        return;
      }

      setUninstallPendingSkillId(skill.id);
      try {
        const deleteParams = {
          projectId,
          path: skill.directoryPath,
          runtimeId: effectiveRuntimeId ?? null,
        };

        let result = await controllerClient.workspace.files.delete(deleteParams);
        if (!result?.ok || !result.deleted) {
          await new Promise((resolve) => {
            if (typeof window === "undefined") {
              setTimeout(resolve, 250);
              return;
            }
            window.setTimeout(resolve, 250);
          });
          result = await controllerClient.workspace.files.delete(deleteParams);
        }

        if (!result?.ok || !result.deleted) {
          throw new Error("Unable to uninstall skill.");
        }

        setBrokenSkillIcons((current) => {
          if (!current[skill.id]) {
            return current;
          }
          const next = { ...current };
          delete next[skill.id];
          return next;
        });
        showStatus(`Uninstalled ${skill.title}.`, "success", 3000);
        await loadSkills();
      } catch (uninstallError) {
        const message =
          uninstallError instanceof Error
            ? uninstallError.message
            : "Unable to uninstall skill.";
        showStatus(message, "error", 4500);
      } finally {
        setUninstallPendingSkillId(null);
      }
    },
    [activeProjectId, effectiveRuntimeId, loadSkills, showStatus],
  );

  const handleDiscoveredSkillAction = useCallback(
    async (discovered: ControllerSkillDiscoveryItem, existingSkill: SkillItem | null) => {
      if (existingSkill) {
        if (existingSkill.status === "disabled") {
          await handleToggleSkill(existingSkill, true);
          return;
        }
        handleOpenSkillFile(existingSkill);
        showStatus(`${existingSkill.title} is already installed.`, "info", 2500);
        return;
      }

      const installSource = discovered.installSource?.trim() ?? "";
      if (!installSource) {
        showStatus(
          "This skill result does not expose an installable SKILL.md path yet.",
          "warning",
          3500,
        );
        return;
      }

      await queueSkillImportTask({
        source: installSource,
        skillName: discovered.suggestedName ?? null,
        overwrite: false,
      });
    },
    [
      handleOpenSkillFile,
      handleToggleSkill,
      queueSkillImportTask,
      showStatus,
    ],
  );

  const hasProject = Boolean(activeProjectId && activeProjectId.trim().length > 0);
  const primaryCategories: SettingsCategory[] = [
    {
      id: "installed",
      label: `Installed (${skills.length})`,
      testId: "skills-tab-installed",
    },
    {
      id: "discover",
      label: `Discover (${totalDiscoveryCount})`,
      testId: "skills-tab-discover",
    },
  ];
  const handlePrimaryCategoryChange = (categoryId: string) => {
    if (categoryId === "installed" || categoryId === "discover") {
      setActivePrimaryTab(categoryId);
    }
  };

  const handleRefresh = useCallback(() => {
    void loadSkills();
    if (activePrimaryTab === "discover") {
      setActivePrimaryTab("discover");
      void runDiscoverySearch({ query: discoveryQuery });
    }
  }, [activePrimaryTab, discoveryQuery, loadSkills, runDiscoverySearch]);

  return (
    <SettingsShell
      testId="skills-panel"
      title="Skills"
      subtitle="Manage space skills and imports."
      navLabel="Sections"
      categories={primaryCategories}
      activeCategoryId={activePrimaryTab}
      onCategoryChange={handlePrimaryCategoryChange}
      actions={
        <div className="flex items-center gap-2">
          <IconButton
            variant="outline"
            size="sm"
            radius="full"
            onPress={handleRefresh}
            isDisabled={!hasProject || loading}
            data-testid="skills-refresh"
            aria-label="Refresh skills"
            title="Refresh skills"
          >
            {loading ? <Spinner tone="primary" size="sm" aria-hidden="true" /> : <Refresh className="h-4 w-4" aria-hidden="true" />}
          </IconButton>
          <Button
            variant="primary"
            size="sm"
            radius="xl"
            onPress={() => handleOpenAddSkillModal()}
            isDisabled={!hasProject}
            data-testid="skills-new"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Import
          </Button>
        </div>
      }
    >
      {activePrimaryTab === "installed" ? (
        <InstalledSkillsSection
          hasProject={hasProject}
          loading={loading}
          skills={skills}
          error={error}
          bootstrapPending={bootstrapPending}
          brokenSkillIcons={brokenSkillIcons}
          togglePendingSkillId={togglePendingSkillId}
          uninstallPendingSkillId={uninstallPendingSkillId}
          onReload={() => {
            void loadSkills();
          }}
          onBootstrapSkills={() => {
            void handleBootstrapSkills();
          }}
          onOpenAddSkillModal={() => handleOpenAddSkillModal()}
          onMarkSkillIconBroken={(skillId) => {
            setBrokenSkillIcons((current) => {
              if (current[skillId]) {
                return current;
              }
              return { ...current, [skillId]: true };
            });
          }}
          onToggleSkill={(skill, enabled) => {
            void handleToggleSkill(skill, enabled);
          }}
          onUninstallSkill={(skill) => {
            void handleUninstallSkill(skill);
          }}
          onOpenSkillFile={handleOpenSkillFile}
        />
      ) : null}

      {activePrimaryTab === "discover" ? (
        <SkillsDiscoverySection
          hasProject={hasProject}
          discoveryQuery={discoveryQuery}
          onDiscoveryQueryChange={setDiscoveryQuery}
          onDiscoverySearchSubmit={handleDiscoverySearchSubmit}
          discoveryLaneFilter={discoveryLaneFilter}
          onDiscoveryLaneFilterChange={(value) => {
            handleDiscoveryLaneChange(value as SkillsDiscoverLaneFilter);
          }}
          discoveryCategoryFilter={discoveryCategoryFilter}
          onDiscoveryCategoryFilterChange={handleDiscoveryCategoryFilterChange}
          discoverySort={discoverySort}
          onDiscoverySortChange={(value) => {
            setDiscoverySort(value as SkillsDiscoverySort);
          }}
          discoveryLoading={discoveryLoading}
          discoveryError={discoveryError}
          discoveryWarnings={discoveryWarnings}
          totalDiscoveryCount={totalDiscoveryCount}
          discoveryLaneCounts={discoveryLaneCounts}
          discoveryCategoryOptions={discoveryCategoryOptions}
          preparedDiscoveryResults={preparedDiscoveryResults}
          importPending={importPending}
          togglePendingSkillId={togglePendingSkillId}
          onMarkDiscoverySourceIconBroken={markDiscoverySourceIconBroken}
          onToggleExistingSkill={(skill, enabled) => {
            void handleToggleSkill(skill, enabled);
          }}
          onAskExistingSkill={(skill) => {
            handleDraftSkillPrompt(skill.slug);
          }}
          onOpenExistingSkill={handleOpenSkillFile}
          onDiscoveredSkillAction={(discovered, existingSkill) => {
            void handleDiscoveredSkillAction(discovered, existingSkill);
          }}
        />
      ) : null}

      <SkillsImportModal
        isOpen={addSkillModalOpen}
        onOpenChange={setAddSkillModalOpen}
        importPending={importPending}
        importSource={importSource}
        onImportSourceChange={setImportSource}
        importName={importName}
        onImportNameChange={setImportName}
        importOverwrite={importOverwrite}
        onImportOverwriteChange={setImportOverwrite}
        hasProject={hasProject}
        onSubmitImport={() => {
          void handleSubmitImport({ closeModalOnSuccess: true });
        }}
      />

      {isAssistantTyping ? (
        <Text variant="caption" tone="muted">
          Assistant is currently processing a run. Skill list refreshes automatically after commits.
        </Text>
      ) : null}
    </SettingsShell>
  );
}
