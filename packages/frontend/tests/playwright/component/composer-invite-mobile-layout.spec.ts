import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__composer-invite-mobile-layout-fixture__";

// The invite uses the shared coarse-pointer sizing policy. Emulate an actual
// phone input model so this test does not make narrow desktop windows look mobile.
test.use({ hasTouch: true });

type ViteDepUrls = {
  react: string;
  reactDomClient: string;
  reactQuery: string;
};

async function resolveViteDepUrls(page: Page): Promise<ViteDepUrls> {
  const [reactDependencies, queryResponse] = await Promise.all([
    resolveViteReactDependencies(page),
    page.request.get("/src/org/useOrgInviteLinks.tsx"),
  ]);
  expect(queryResponse.ok(), "dev server should transform the invite query hook").toBeTruthy();

  const queryBody = await queryResponse.text();
  const reactQuery = queryBody.match(
    /['"](\/node_modules\/\.vite\/deps\/@tanstack_react-query\.js\?v=[^'"]+)['"]/,
  )?.[1];
  if (!reactQuery) {
    throw new Error("Could not resolve the invite modal's Vite dependencies");
  }
  const reactQueryResponse = await page.request.get(reactQuery);
  expect(
    reactQueryResponse.ok(),
    `Vite React Query dependency should load: ${reactQuery}`,
  ).toBeTruthy();
  return {
    ...reactDependencies,
    reactQuery,
  };
}

async function mountInviteModal(page: Page): Promise<void> {
  const deps = await resolveViteDepUrls(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { QueryClient, QueryClientProvider } from "${deps.reactQuery}";
    import { ComposerInviteModal } from "/src/screens/studio/components/ComposerInviteModal.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const teammates = Array.from({ length: 8 }, (_, index) => ({
      createdAt: "2026-07-14T12:00:00.000Z",
      email: "teammate-" + index + "@example.com",
      fullName: "Team Mate " + index,
      role: "builder",
      userId: "user-" + index,
    }));
    function InviteFixture() {
      const [preparedEmailInvite, setPreparedEmailInvite] = React.useState(null);
      React.useEffect(() => {
        window.__prepareEmailInvite = () => setPreparedEmailInvite({
          acceptUrl: "https://instafy.dev/invite?token=prepared-mobile",
          email: "mobile@example.com",
          role: "builder",
        });
        return () => { delete window.__prepareEmailInvite; };
      }, []);
      return h(ComposerInviteModal, {
        isOpen: true,
        onOpenChange: (open) => { window.__inviteOpenChanges.push(open); },
        mentionableUsers: teammates,
        inviteParticipantIdSet: new Set(),
        inviteParticipantBusyUserId: null,
        inviteParticipantsLoading: false,
        onInviteTeammate: async () => {},
        activeConversationVisibility: "private",
        activeConversationControllerId: "conversation-1",
        activeOrgId: "org-1",
        activeProjectId: "project-1",
        canShareProject: true,
        canWriteProject: true,
        preparedEmailInvite,
        onPreparedEmailInviteConsumed: () => {},
        sharingPermissionsLoading: false,
        onOpenProjectSettings: () => {},
      });
    }
    createRoot(document.getElementById("root")).render(
      h(QueryClientProvider, { client: queryClient },
        h(InviteFixture),
      ),
    );
    window.__mounted = true;`;

  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <script>
      document.documentElement.style.setProperty("--safe-area-inset-top", "31px");
      document.documentElement.style.setProperty("--safe-area-inset-right", "20px");
      document.documentElement.style.setProperty("--safe-area-inset-bottom", "27px");
      document.documentElement.style.setProperty("--safe-area-inset-left", "12px");
      window.__inviteOpenChanges = [];
      window.__shareCalls = [];
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async (payload) => { window.__shareCalls.push(payload); },
      });
    </script>
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="/@vite/client"></script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body><div id="root"></div></body></html>`;

  await page.route(`**${FIXTURE_PATH}`, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) =>
    route.fulfill({ contentType: "application/javascript", body: main }),
  );

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await page.waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true, {
    timeout: 20_000,
  });
  expect(errors, errors.join("; ")).toEqual([]);
}

test("keeps a tall invite and its device handoff actions reachable inside phone safe areas", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 520 });
  await mountInviteModal(page);

  const overlay = page.getByTestId("chat-invite-modal");
  const dialog = overlay.getByRole("dialog", { name: "Invite" });
  const copyButton = page.getByTestId("composer-device-handoff-copy");
  const qrButton = page.getByTestId("composer-device-handoff-show-qr");
  const shareButton = page.getByTestId("composer-device-handoff-share");

  await expect(dialog).toBeVisible();
  await expect(copyButton).toBeInViewport();
  await expect(qrButton).toBeInViewport();
  await expect(shareButton).toBeInViewport();

  const geometry = await page.evaluate(() => {
    const overlayElement = document.querySelector<HTMLElement>(
      '[data-testid="chat-invite-modal"]',
    );
    const dialogElement = overlayElement?.querySelector<HTMLElement>('[role="dialog"]');
    const panelElement = dialogElement?.parentElement;
    const scrollBody = dialogElement?.querySelector<HTMLElement>(".overflow-y-auto");
    const selectors = [
      '[data-testid="composer-device-handoff-copy"]',
      '[data-testid="composer-device-handoff-show-qr"]',
      '[data-testid="composer-device-handoff-share"]',
    ];
    if (!overlayElement || !dialogElement || !panelElement || !scrollBody) {
      return null;
    }
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        height: bounds.height,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        width: bounds.width,
      };
    };
    return {
      overlayPadding: {
        top: Number.parseFloat(getComputedStyle(overlayElement).paddingTop),
        right: Number.parseFloat(getComputedStyle(overlayElement).paddingRight),
        bottom: Number.parseFloat(getComputedStyle(overlayElement).paddingBottom),
        left: Number.parseFloat(getComputedStyle(overlayElement).paddingLeft),
      },
      panel: rect(panelElement),
      dialog: rect(dialogElement),
      scrollBody: {
        clientHeight: scrollBody.clientHeight,
        scrollHeight: scrollBody.scrollHeight,
      },
      actions: selectors.map((selector) => rect(document.querySelector(selector)!)),
      documentWidth: document.documentElement.scrollWidth,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry!.overlayPadding).toEqual({ top: 31, right: 20, bottom: 27, left: 16 });
  for (const bounds of [geometry!.panel, geometry!.dialog]) {
    expect(bounds.top).toBeGreaterThanOrEqual(31);
    expect(bounds.bottom).toBeLessThanOrEqual(520 - 27);
    expect(bounds.left).toBeGreaterThanOrEqual(16);
    expect(bounds.right).toBeLessThanOrEqual(360 - 20);
  }
  expect(geometry!.scrollBody.scrollHeight).toBeGreaterThan(
    geometry!.scrollBody.clientHeight,
  );
  expect(geometry!.documentWidth).toBeLessThanOrEqual(360);
  for (const action of geometry!.actions) {
    expect(action.height).toBeGreaterThanOrEqual(44);
    expect(action.left).toBeGreaterThanOrEqual(16);
    expect(action.right).toBeLessThanOrEqual(360 - 20);
    expect(action.top).toBeGreaterThanOrEqual(31);
    expect(action.bottom).toBeLessThanOrEqual(520 - 27);
  }
  expect(geometry!.actions[1].width).toBeGreaterThanOrEqual(44);
  expect(geometry!.actions[2].width).toBeGreaterThanOrEqual(44);

  await qrButton.click();
  const qrOverlay = page.getByTestId("composer-invite-nearby-qr-modal");
  await expect(qrOverlay).toBeVisible();
  await expect(qrOverlay.getByTestId("composer-invite-nearby-url")).toContainText(
    "instafy://studio",
  );
});

test("keeps access controls and prepared email actions reachable when a phone keyboard resizes the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 520 });
  await mountInviteModal(page);

  const readRole = page.getByTestId("composer-invite-access-role-viewer");
  const editRole = page.getByTestId("composer-invite-access-role-builder");
  const emailInput = page.getByTestId("composer-invite-email-input");

  await expect(readRole).toHaveText("Read");
  await expect(editRole).toHaveText("Edit");
  await emailInput.scrollIntoViewIfNeeded();
  await emailInput.focus();
  await expect(emailInput).toBeFocused();

  // A reduced viewport approximates the visualViewport resize emitted by a
  // mobile keyboard without coupling this component test to an OS keyboard.
  await page.setViewportSize({ width: 360, height: 360 });
  await page.evaluate(() => {
    const prepare = (window as Window & { __prepareEmailInvite?: () => void })
      .__prepareEmailInvite;
    if (!prepare) {
      throw new Error("invite fixture was not ready");
    }
    prepare();
  });

  const prepared = page.getByTestId("composer-email-invite-prepared");
  const share = page.getByTestId("composer-email-invite-share");
  const copy = page.getByTestId("composer-email-invite-copy");
  await expect(prepared).toBeVisible();
  await expect(emailInput).not.toBeFocused();
  await expect(share).toBeInViewport();
  await expect(copy).toBeInViewport();

  const geometry = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      };
    };
    return {
      documentWidth: document.documentElement.scrollWidth,
      share: bounds('[data-testid="composer-email-invite-share"]'),
      copy: bounds('[data-testid="composer-email-invite-copy"]'),
    };
  });

  expect(geometry.documentWidth).toBeLessThanOrEqual(360);
  for (const action of [geometry.share, geometry.copy]) {
    expect(action.height).toBeGreaterThanOrEqual(44);
    expect(action.left).toBeGreaterThanOrEqual(16);
    expect(action.right).toBeLessThanOrEqual(360 - 20);
    expect(action.top).toBeGreaterThanOrEqual(31);
    expect(action.bottom).toBeLessThanOrEqual(360 - 27);
  }
});
