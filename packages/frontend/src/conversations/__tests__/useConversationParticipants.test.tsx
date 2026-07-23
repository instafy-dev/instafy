// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationParticipants } from "../useConversationParticipants";

const mocks = vi.hoisted(() => ({
  listParticipants: vi.fn(),
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    core: { enabled: true },
    conversations: {
      listParticipants: mocks.listParticipants,
    },
  },
}));

function Probe({ conversationId }: { conversationId: string | null }) {
  const { participants, loading, error } = useConversationParticipants(conversationId);
  return (
    <div data-error={error ?? ""} data-loading={String(loading)} data-testid="probe">
      {participants.map((participant) => participant.displayName).join(",")}
    </div>
  );
}

describe("useConversationParticipants", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.listParticipants.mockReset();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("fetches active participants and refreshes after controller reconnect", async () => {
    mocks.listParticipants
      .mockResolvedValueOnce([
        {
          userId: "user-2",
          displayName: "Alice",
          role: "member",
          addedBy: null,
          createdAt: "2026-07-16T12:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          userId: "user-2",
          displayName: "Alice Updated",
          role: "member",
          addedBy: null,
          createdAt: "2026-07-16T12:00:00.000Z",
        },
      ]);

    await act(async () => {
      root.render(
        <Providers>
          <Probe conversationId="conversation-1" />
        </Providers>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Alice");
      });
    });

    expect(mocks.listParticipants).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      accessToken: null,
    });

    await act(async () => {
      window.dispatchEvent(new Event("instafy:controller-stream-reconnected"));
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Alice Updated");
      });
    });
    expect(mocks.listParticipants).toHaveBeenCalledTimes(2);
  });

  it("does not query before a controller conversation exists", async () => {
    await act(async () => {
      root.render(
        <Providers>
          <Probe conversationId={null} />
        </Providers>,
      );
    });

    expect(mocks.listParticipants).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>('[data-testid="probe"]')?.dataset.loading).toBe(
      "false",
    );
  });

  it("withholds successful participant names when a later refresh fails", async () => {
    mocks.listParticipants
      .mockResolvedValueOnce([
        {
          userId: "user-2",
          displayName: "Alice",
          role: "member",
          addedBy: null,
          createdAt: "2026-07-16T12:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce(null);

    await act(async () => {
      root.render(
        <Providers>
          <Probe conversationId="conversation-1" />
        </Providers>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Alice");
      });
    });

    await act(async () => {
      window.dispatchEvent(new Event("instafy:controller-stream-reconnected"));
      await vi.waitFor(() => {
        expect(
          container.querySelector<HTMLElement>('[data-testid="probe"]')?.dataset.error,
        ).toBe("Unable to refresh conversation participants.");
      });
    });

    expect(mocks.listParticipants).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Alice");
  });
});
