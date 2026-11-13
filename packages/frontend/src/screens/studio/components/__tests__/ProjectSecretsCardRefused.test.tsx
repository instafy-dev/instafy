// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDraftsProvider } from "../../../../workspace/StudioDrafts";
import type { ControllerAgentProfile, ControllerProjectSecret } from "../../../../sdk/instafy";
import { ProjectSecretsCard } from "../ProjectSecretsCard";

const mocks = vi.hoisted(() => ({
  query: {
    data: { secrets: [] as ControllerProjectSecret[], agents: [] as ControllerAgentProfile[] },
    error: null as Error | null,
    isFetching: false,
    refetch: vi.fn(),
  },
}));

vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({ openPanelTab: vi.fn(), requestUrlPush: vi.fn() }),
}));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => mocks.query,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    secrets: { listForProject: vi.fn(), createForProject: vi.fn(), updateForProject: vi.fn() },
    agents: { list: vi.fn() },
  },
}));

function secret(id: string, name: string, extra: Record<string, unknown> = {}): ControllerProjectSecret {
  return {
    id, name, description: null, agentIds: [], agentHandles: ["octo"], lastUsedAt: null, revokedAt: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra,
  } as ControllerProjectSecret;
}

// docs/Local-Engine-Turns.md section 6: list_project_secrets marks a secret
// the credential guard refuses (a reserved name, or a Claude sign-in as its
// value) `refused: true`. It stays listed with a notice, instead of quietly
// never reaching an agent.
describe("a secret the credential guard refuses", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.query.data = {
      secrets: [
        secret("refused-1", "CLAUDE_CODE_OAUTH_TOKEN", { refused: true }),
        secret("kept-1", "ANTHROPIC_API_KEY"),
      ],
      agents: [],
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<StudioDraftsProvider><ProjectSecretsCard projectId="project-1" /></StudioDraftsProvider>);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("stays listed with the notice to remove it, and its Revoke", () => {
    const row = container.querySelector('[data-testid="project-secret-row-refused-1"]');
    expect(row?.textContent).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(row?.querySelector('[data-testid="project-secret-refused-refused-1"]')?.textContent).toBe(
      "Instafy no longer stores Claude sign-ins; remove it",
    );
    expect(row?.querySelector('[data-testid="project-secret-revoke-refused-1"]')).not.toBeNull();
  });

  it("leaves every other secret as it was, an Anthropic API key included", () => {
    const row = container.querySelector('[data-testid="project-secret-row-kept-1"]');
    expect(row?.textContent).toContain("ANTHROPIC_API_KEY");
    expect(row?.textContent).not.toContain("Claude sign-ins");
  });
});
