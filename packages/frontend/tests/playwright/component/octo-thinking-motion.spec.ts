import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__octo-thinking-motion-fixture__";

async function mountOctoThinkingFixture(page: Page): Promise<string[]> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { OctoMark, OctoScrollMotionScope } from "/src/components/OctoMark.tsx";
    import { ChatMessageAvatar } from "/src/screens/studio/components/ChatMessageAvatar.tsx";
    import { ChatTypingRows } from "/src/screens/studio/components/ChatTypingRows.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;

    const renderAssistantAvatar = (_metadata, identity, options) =>
      h(ChatMessageAvatar, {
        kind: "assistant",
        agent: identity,
        motion: options?.motion,
      });

    const ScrollReactiveOcto = () => {
      const sourceRef = React.useRef(null);
      return h(OctoScrollMotionScope, { sourceRef },
        h("div", {
          ref: sourceRef,
          "data-testid": "octo-scroll-source",
          style: { height: "180px", overflowY: "auto" },
        },
          h("div", { style: { height: "720px", padding: "16px" } },
            h("div", {
              "data-testid": "scroll-reactive-mark",
              style: { height: "64px", position: "sticky", top: "16px", width: "64px" },
            }, h(OctoMark, {
              className: "h-full w-full",
              motion: "idle",
              scrollReactive: true,
            })),
            h("div", {
              "data-testid": "scroll-reactive-thinking-mark",
              style: { height: "64px", left: "80px", position: "sticky", top: "16px", width: "64px" },
            }, h(OctoMark, {
              className: "h-full w-full",
              motion: "thinking",
              scrollReactive: true,
            })),
          ),
        ),
      );
    };

    createRoot(document.getElementById("root")).render(
      h("main", { className: "min-h-screen bg-white p-6 text-brand-ink dark:bg-slate-950 dark:text-brand-paper" },
        h("div", { "data-testid": "idle-mark", className: "mb-8 h-16 w-16" },
          h(OctoMark, { className: "h-full w-full", motion: "idle" })),
        h("div", { "data-testid": "thinking-mark", className: "mb-8 h-16 w-16" },
          h(OctoMark, { className: "h-full w-full", motion: "thinking" })),
        h(ScrollReactiveOcto),
        h("section", { className: "max-w-md", "data-testid": "typing-row-fixture" },
          h(ChatTypingRows, {
            peerTypingLabel: null,
            isAssistantTyping: true,
            isAssistantTypingCoveredByJobThreadPreview: false,
            typingAgents: [],
            hasMultipleTypingAgents: false,
            typingAgentHandle: "octo",
            typingAgentAvatarSeed: "octo",
            typingIndicatorState: { phase: "thinking", label: "Thinking…" },
            typingStatusLabel: "Thinking…",
            typingStatusAriaLabel: "Octo is thinking",
            isThinkingLabelExpanded: false,
            onToggleThinkingLabel: () => {},
            latestDisplayedMessageId: "message-1",
            renderAssistantAvatar,
          })),
      ));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.__mounted = true;
      });
    });`;

  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
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
  return errors;
}

test.describe("Octo thinking motion", () => {
  test("morphs only while thinking, remains responsive, and honors reduced motion", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const errors = await mountOctoThinkingFixture(page);

    const idleMark = page.getByTestId("idle-mark").locator("svg");
    const thinkingMark = page.getByTestId("thinking-mark");
    const thinkingMarkSvg = thinkingMark.locator("svg");
    const thinkingArms = thinkingMark.locator('[data-octo-part="tentacle"]');

    await expect(idleMark).toHaveAttribute("data-octo-animated", "false");
    await expect(idleMark.locator("animate, animateTransform")).toHaveCount(0);
    await expect(thinkingMarkSvg).toHaveAttribute("data-octo-animated", "true");
    await expect(thinkingArms).toHaveCount(4);
    await expect(
      thinkingMark.locator('animate[data-octo-animation="tentacle"]'),
    ).toHaveCount(4);
    await expect(
      thinkingMark.locator('animateTransform[data-octo-animation="node"]'),
    ).toHaveCount(4);
    await expect(
      thinkingMark.locator('animateTransform[data-octo-animation="swimmer"]'),
    ).toHaveCount(1);
    await expect(
      thinkingMark.locator('animateTransform[data-octo-animation="mantle-translate"]'),
    ).toHaveCount(1);
    await expect(
      thinkingMark.locator('animateTransform[data-octo-animation="mantle-scale"]'),
    ).toHaveCount(1);

    const armBeginTimes = await thinkingArms.evaluateAll((arms) =>
      arms.map((arm) => arm.querySelector("animate")?.getAttribute("begin")),
    );
    expect(armBeginTimes).toEqual(["0s", "0s", "0s", "0s"]);
    for (let arm = 1; arm <= 4; arm += 1) {
      const tentacle = thinkingMark.locator(
        `[data-octo-part="tentacle"][data-octo-arm="${arm}"]`,
      );
      const node = thinkingMark.locator(
        `[data-octo-part="node"][data-octo-arm="${arm}"]`,
      );
      const pathAnimation = tentacle.locator(
        'animate[data-octo-animation="tentacle"]',
      );
      const nodeAnimation = node.locator(
        'animateTransform[data-octo-animation="node"]',
      );
      await expect(pathAnimation).toHaveCount(1);
      await expect(nodeAnimation).toHaveCount(1);
      expect(await nodeAnimation.getAttribute("begin")).toBe(
        await pathAnimation.getAttribute("begin"),
      );
      await expect(pathAnimation).toHaveAttribute("dur", "3s");
      const pathFrames = (await pathAnimation.getAttribute("values"))?.split(";") ?? [];
      const nodeFrames = (await nodeAnimation.getAttribute("values"))?.split(";") ?? [];
      expect(pathFrames).toHaveLength(8);
      expect(pathFrames[0]).toBe(await tentacle.getAttribute("d"));
      expect(pathFrames.at(-1)).toBe(await tentacle.getAttribute("d"));
      expect(nodeFrames).toHaveLength(8);
      expect(nodeFrames[0]).toBe("0 0");
      expect(nodeFrames.at(-1)).toBe("0 0");
    }
    const presentedPathChanges = await thinkingMarkSvg.evaluate((svg) => {
      svg.pauseAnimations();
      svg.setCurrentTime(0);
      const tentacle = svg.querySelector<SVGGraphicsElement>(
        '[data-octo-part="tentacle"][data-octo-arm="1"]',
      );
      if (!tentacle) {
        return false;
      }
      const rest = tentacle.getBBox();
      svg.setCurrentTime(1.71);
      const snap = tentacle.getBBox();
      svg.unpauseAnimations();
      return (
        Math.abs(rest.x - snap.x) > 0.1 ||
        Math.abs(rest.y - snap.y) > 0.1 ||
        Math.abs(rest.width - snap.width) > 0.1 ||
        Math.abs(rest.height - snap.height) > 0.1
      );
    });
    expect(presentedPathChanges).toBe(true);
    await expect(page.getByTestId("chat-avatar-assistant")).toBeVisible();
    await expect(page.getByTestId("assistant-thinking-octo-compact")).toBeHidden();

    const avatarBox = await page.getByTestId("chat-avatar-assistant").boundingBox();
    expect(avatarBox?.width).toBe(32);
    expect(avatarBox?.height).toBe(32);

    await page.setViewportSize({ width: 390, height: 720 });
    await expect(page.getByTestId("chat-avatar-assistant")).toBeHidden();
    await expect(page.getByTestId("assistant-thinking-octo-compact")).toBeVisible();
    await expect(
      page
        .getByTestId("assistant-thinking-octo-compact")
        .locator(
          '[data-octo-part="tentacle"][data-octo-arm="1"] animate[data-octo-animation="tentacle"]',
        ),
    ).toHaveCount(1);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(thinkingMarkSvg).toHaveAttribute("data-octo-animated", "false");
    await expect(thinkingMark.locator("animate, animateTransform")).toHaveCount(0);
    const reducedPaths = await thinkingMark.locator("path").evaluateAll((paths) =>
      paths.map((path) => path.getAttribute("d")),
    );
    const idlePaths = await page
      .getByTestId("idle-mark")
      .locator("path")
      .evaluateAll((paths) => paths.map((path) => path.getAttribute("d")));
    expect(reducedPaths).toEqual(idlePaths);
    expect(
      await thinkingMark.locator('[data-octo-part="node"]').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("transform")),
      ),
    ).toEqual([null, null, null, null]);
    expect(
      await thinkingMark.locator("[data-octo-part]").evaluateAll((parts) =>
        parts.map((part) => getComputedStyle(part).animationName),
      ),
    ).toEqual(
      await thinkingMark.locator("[data-octo-part]").evaluateAll((parts) =>
        parts.map(() => "none"),
      ),
    );
    expect(errors, errors.join("; ")).toEqual([]);
  });

  test("trails after its scroll source, settles exactly, and honors reduced motion", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const errors = await mountOctoThinkingFixture(page);
    const source = page.getByTestId("octo-scroll-source");
    const mark = page.getByTestId("scroll-reactive-mark").locator("svg");
    const thinkingMark = page
      .getByTestId("scroll-reactive-thinking-mark")
      .locator("svg");
    const firstArm = mark.locator(
      '[data-octo-part="tentacle"][data-octo-arm="1"]',
    );

    await expect(mark).toHaveAttribute("data-octo-scroll-reactive", "true");
    await expect(mark).toHaveAttribute("data-octo-scroll-phase", "settled");
    await expect(mark).toHaveAttribute("data-octo-animated", "false");
    await expect(mark).toHaveAttribute("data-octo-scroll-tip-y", "0");
    await expect(mark).toHaveAttribute("data-octo-scroll-mantle-scale-y", "1");
    await expect(mark).toHaveAttribute("data-octo-scroll-mantle-translate-y", "0");
    await expect(
      mark.locator('[data-octo-part="mantle-scroll-translate"]'),
    ).toHaveAttribute("transform", "translate(0 0)");
    await expect(
      mark.locator('[data-octo-part="mantle-scroll-scale"]'),
    ).toHaveAttribute("transform", "scale(1 1)");
    await expect(thinkingMark).toHaveAttribute("data-octo-limb-driver", "thinking");
    await expect(
      thinkingMark.locator('animate[data-octo-animation="tentacle"]'),
    ).toHaveCount(4);
    const restPath = await firstArm.getAttribute("d");
    expect(restPath).not.toBeNull();
    await expect
      .poll(() => source.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    expect(await source.evaluate((element) => element.scrollTop)).toBe(0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    const activeSamples = await source.evaluate(async (element, canonicalPath) => {
      const samples: Array<{
        animated: string | null;
        limbDriver: string | null;
        pathChanged: boolean;
        thinkingBodyAnimations: number;
        thinkingLimbAnimations: number;
        thinkingMantleScaleY: number;
        thinkingMantleTranslateY: number;
        mantleScaleX: number;
        mantleScaleY: number;
        mantleTranslateY: number;
        mantleTransform: string | null;
        sweepsUp: boolean;
      }> = [];
      for (let frame = 1; frame <= 24; frame += 1) {
        element.scrollTop = frame * 8;
        element.dispatchEvent(new Event("scroll"));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const markSvg = document.querySelector(
          '[data-testid="scroll-reactive-mark"] svg',
        );
        const thinkingSvg = document.querySelector(
          '[data-testid="scroll-reactive-thinking-mark"] svg',
        );
        const arm = markSvg?.querySelector(
          '[data-octo-part="tentacle"][data-octo-arm="1"]',
        );
        samples.push({
          animated: markSvg?.getAttribute("data-octo-animated") ?? null,
          limbDriver: thinkingSvg?.getAttribute("data-octo-limb-driver") ?? null,
          pathChanged: arm?.getAttribute("d") !== canonicalPath,
          thinkingBodyAnimations:
            thinkingSvg?.querySelectorAll(
              'animateTransform[data-octo-animation="swimmer"], animateTransform[data-octo-animation^="mantle-"]',
            ).length ?? 0,
          thinkingLimbAnimations:
            thinkingSvg?.querySelectorAll('animate[data-octo-animation="tentacle"]')
              .length ?? 0,
          thinkingMantleScaleY: Number(
            thinkingSvg?.getAttribute("data-octo-scroll-mantle-scale-y") ?? 1,
          ),
          thinkingMantleTranslateY: Number(
            thinkingSvg?.getAttribute("data-octo-scroll-mantle-translate-y") ?? 0,
          ),
          mantleScaleX: Number(
            markSvg?.getAttribute("data-octo-scroll-mantle-scale-x") ?? 1,
          ),
          mantleScaleY: Number(
            markSvg?.getAttribute("data-octo-scroll-mantle-scale-y") ?? 1,
          ),
          mantleTranslateY: Number(
            markSvg?.getAttribute("data-octo-scroll-mantle-translate-y") ?? 0,
          ),
          mantleTransform:
            markSvg
              ?.querySelector('[data-octo-part="mantle-scroll-scale"]')
              ?.getAttribute("transform") ?? null,
          sweepsUp:
            Number(markSvg?.getAttribute("data-octo-scroll-tip-y") ?? 0) < -0.05,
        });
      }
      return samples;
    }, restPath);
    expect(
      activeSamples.some(
        ({
          animated,
          limbDriver,
          mantleScaleX,
          mantleScaleY,
          mantleTranslateY,
          mantleTransform,
          pathChanged,
          sweepsUp,
          thinkingBodyAnimations,
          thinkingLimbAnimations,
          thinkingMantleScaleY,
          thinkingMantleTranslateY,
        }) =>
          animated === "true" &&
          limbDriver === "scroll" &&
          pathChanged &&
          thinkingBodyAnimations === 3 &&
          thinkingLimbAnimations === 0 &&
          mantleScaleX >= 0.98 &&
          mantleScaleX < 1 &&
          mantleScaleY > 1 &&
          mantleScaleY <= 1.05 &&
          mantleTranslateY < 0 &&
          thinkingMantleScaleY === mantleScaleY &&
          thinkingMantleTranslateY === mantleTranslateY &&
          mantleTransform !== "scale(1 1)" &&
          sweepsUp,
      ),
    ).toBe(true);

    await expect
      .poll(
        () =>
          mark.evaluate((svg, canonicalPath) => {
            const arm = svg.querySelector(
              '[data-octo-part="tentacle"][data-octo-arm="1"]',
            );
            return {
              animated: svg.getAttribute("data-octo-animated"),
              pathRestored: arm?.getAttribute("d") === canonicalPath,
              phase: svg.getAttribute("data-octo-scroll-phase"),
              tipY: Number(svg.getAttribute("data-octo-scroll-tip-y")),
            };
          }, restPath),
        { intervals: [50, 100, 200], timeout: 6_000 },
      )
      .toEqual({ animated: "false", pathRestored: true, phase: "settled", tipY: 0 });
    await expect(thinkingMark).toHaveAttribute("data-octo-limb-driver", "thinking");
    await expect(
      thinkingMark.locator('animate[data-octo-animation="tentacle"]'),
    ).toHaveCount(4);

    const upwardTipSamples = await source.evaluate(async (element) => {
      const startingScrollTop = element.scrollTop;
      const samples: Array<{
        mantleScaleY: number;
        mantleScaleTransform: string | null;
        mantleTranslateTransform: string | null;
        mantleTranslateY: number;
        thinkingBodyAnimations: number;
        thinkingLimbAnimations: number;
        thinkingMantleScaleY: number;
        thinkingMantleTranslateY: number;
        tipY: number;
      }> = [];
      for (let frame = 1; frame <= 24; frame += 1) {
        element.scrollTop = Math.max(0, startingScrollTop - frame * 8);
        element.dispatchEvent(new Event("scroll"));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const markSvg = document.querySelector(
          '[data-testid="scroll-reactive-mark"] svg',
        );
        const thinkingSvg = document.querySelector(
          '[data-testid="scroll-reactive-thinking-mark"] svg',
        );
        samples.push({
          mantleScaleY: Number(
            markSvg?.getAttribute("data-octo-scroll-mantle-scale-y") ?? 1,
          ),
          mantleScaleTransform:
            markSvg
              ?.querySelector('[data-octo-part="mantle-scroll-scale"]')
              ?.getAttribute("transform") ?? null,
          mantleTranslateTransform:
            markSvg
              ?.querySelector('[data-octo-part="mantle-scroll-translate"]')
              ?.getAttribute("transform") ?? null,
          mantleTranslateY: Number(
            markSvg?.getAttribute("data-octo-scroll-mantle-translate-y") ?? 0,
          ),
          thinkingBodyAnimations:
            thinkingSvg?.querySelectorAll(
              'animateTransform[data-octo-animation="swimmer"], animateTransform[data-octo-animation^="mantle-"]',
            ).length ?? 0,
          thinkingLimbAnimations:
            thinkingSvg?.querySelectorAll('animate[data-octo-animation="tentacle"]')
              .length ?? 0,
          thinkingMantleScaleY: Number(
            thinkingSvg?.getAttribute("data-octo-scroll-mantle-scale-y") ?? 1,
          ),
          thinkingMantleTranslateY: Number(
            thinkingSvg?.getAttribute("data-octo-scroll-mantle-translate-y") ?? 0,
          ),
          tipY: Number(markSvg?.getAttribute("data-octo-scroll-tip-y") ?? 0),
        });
      }
      return samples;
    });
    expect(
      upwardTipSamples.some(
        ({
          mantleScaleY,
          mantleScaleTransform,
          mantleTranslateTransform,
          mantleTranslateY,
          thinkingBodyAnimations,
          thinkingLimbAnimations,
          thinkingMantleScaleY,
          thinkingMantleTranslateY,
          tipY,
        }) =>
          tipY > 0.05 &&
          mantleScaleY < 1 &&
          mantleTranslateY > 0 &&
          thinkingMantleScaleY === mantleScaleY &&
          thinkingMantleTranslateY === mantleTranslateY &&
          thinkingBodyAnimations === 3 &&
          thinkingLimbAnimations === 0 &&
          mantleScaleTransform !== "scale(1 1)" &&
          mantleTranslateTransform !== "translate(0 0)",
      ),
    ).toBe(true);

    await expect
      .poll(
        () =>
          mark.evaluate((svg, canonicalPath) => {
            const arm = svg.querySelector(
              '[data-octo-part="tentacle"][data-octo-arm="1"]',
            );
            return {
              animated: svg.getAttribute("data-octo-animated"),
              pathRestored: arm?.getAttribute("d") === canonicalPath,
              phase: svg.getAttribute("data-octo-scroll-phase"),
              tipY: Number(svg.getAttribute("data-octo-scroll-tip-y")),
            };
          }, restPath),
        { intervals: [50, 100, 200], timeout: 6_000 },
      )
      .toEqual({ animated: "false", pathRestored: true, phase: "settled", tipY: 0 });
    await expect(mark).toHaveAttribute("data-octo-scroll-mantle-scale-y", "1");
    await expect(mark).toHaveAttribute("data-octo-scroll-mantle-translate-y", "0");
    await expect(
      mark.locator('[data-octo-part="mantle-scroll-translate"]'),
    ).toHaveAttribute("transform", "translate(0 0)");
    await expect(
      mark.locator('[data-octo-part="mantle-scroll-scale"]'),
    ).toHaveAttribute("transform", "scale(1 1)");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await source.evaluate((element) => {
      element.scrollTop = 260;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(mark).toHaveAttribute("data-octo-animated", "false");
    await expect(mark).toHaveAttribute("data-octo-scroll-phase", "settled");
    await expect(mark).toHaveAttribute("data-octo-scroll-tip-y", "0");
    await expect(mark).toHaveAttribute("data-octo-scroll-mantle-scale-y", "1");
    await expect(mark).toHaveAttribute("data-octo-scroll-mantle-translate-y", "0");
    await expect(firstArm).toHaveAttribute("d", restPath!);
    await expect(thinkingMark).toHaveAttribute("data-octo-limb-driver", "idle");
    await expect(thinkingMark.locator("animate, animateTransform")).toHaveCount(0);
    expect(errors, errors.join("; ")).toEqual([]);
  });
});
