import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const version = process.env.INSTAFY_REVIEW_VERSION === "before" ? "before" : "after";
const base = `http://127.0.0.1:${version === "before" ? 5374 : 5372}/tests/fixtures/chat-pane-reading-space/index.html`;
const artifactRoot = process.env.INSTAFY_REVIEW_ARTIFACT_DIR;
const cases: {id:string;width:number;height:number;pane:number;layout:string;scrollbar?:string}[] = [
  {id:"split-420",width:1280,height:900,pane:420,layout:"split"},
  {id:"split-560",width:1280,height:900,pane:560,layout:"split"},
  {id:"mobile-320",width:320,height:740,pane:320,layout:"full"},
  {id:"mobile-390",width:390,height:844,pane:390,layout:"full"},
  {id:"wide",width:1440,height:900,pane:1440,layout:"full"},
  {id:"split-420-scrollbar",width:1280,height:900,pane:420,layout:"split",scrollbar:"classic"},
];

async function latest(page: Page, state = "working") {
  await expect(page.getByTestId("chat-input")).toBeVisible();
  if (state === "working") await expect(page.getByTestId("browser-approval-row")).toBeAttached();
  await page.getByTestId("chat-message-scroll").evaluate(element => element.scrollTo(0, element.scrollHeight));
  await page.getByTestId("chat-message-scroll").hover({position:{x:8,y:80}});
  await page.mouse.wheel(0,-1);
  if (state === "working") await expect(page.getByTestId("assistant-typing-indicator")).toBeVisible();
  else await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(0);
}

for (const size of cases) test.describe(size.id, () => {
  test.use({isMobile:size.width < 640, hasTouch:size.width < 640});
  for (const theme of ["light","dark"]) for (const people of ["solo","group"]) for (const state of size.scrollbar ? ["working"] : ["working","completed"]) {
  test(`${version} ${size.id} ${theme} ${people} ${state}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror",error=>errors.push(error.message));
    await page.setViewportSize(size);
    await page.goto(`${base}?pane=${size.pane}&layout=${size.layout}&theme=${theme}&people=${people}&scrollbar=${size.scrollbar ?? "system"}&state=${state}`);
    await latest(page,state);
    expect(errors).toEqual([]);
    const sizes = await page.getByTestId("chat-message-scroll").evaluate(element => ({client:element.clientWidth,scroll:element.scrollWidth}));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.client+1);
    const doc = await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
    expect(doc.scroll).toBeLessThanOrEqual(doc.client+1);
    if (artifactRoot) {
      await mkdir(path.join(artifactRoot,version),{recursive:true});
      await page.screenshot({path:path.join(artifactRoot,version,`${size.id}-${theme}-${people}${state === "completed" ? "-completed" : ""}.png`),animations:"disabled"});
    }
    if(version==="before")return;
    await expect(page.getByTestId("chat-transcript-viewport")).toHaveAttribute("data-chat-identity-layout", people === "solo" ? "solo" : "participants");
    const layout = await page.getByTestId("chat-message-scroll").evaluate(element => {
      const column=element.firstElementChild!;
      const scroll=element.getBoundingClientRect();
      const rect=column.getBoundingClientRect();
      const form=document.querySelector('[data-testid="chat-composer-surface"]')!.getBoundingClientRect();
      return {left:rect.left,right:rect.right,formLeft:form.left,formRight:form.right,scrollbar:element.offsetWidth-element.clientWidth,clearance:scroll.right-(element.offsetWidth-element.clientWidth)-rect.right};
    });
    expect(layout.clearance).toBeGreaterThanOrEqual(15);
    expect(Math.abs(layout.left-layout.formLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.right-layout.formRight)).toBeLessThanOrEqual(1);
    if(size.scrollbar === "classic") expect(layout.scrollbar).toBe(12);
    else if (size.width >= 640) {
      expect(await page.evaluate(()=>matchMedia("(pointer: fine) and (hover: hover)").matches)).toBe(true);
      expect(layout.scrollbar).toBe(12);
    } else {
      expect(await page.evaluate(()=>matchMedia("(pointer: coarse)").matches)).toBe(true);
      expect(await page.getByTestId("chat-message-scroll").evaluate(element=>getComputedStyle(element).getPropertyValue("--studio-scrollbar-thumb"))).toBe("");
    }
    const gutters = await page.locator(".chat-message-avatar-gutter").evaluateAll(elements => elements.filter(element => getComputedStyle(element).display !== "none").length);
    expect(gutters).toBe(people === "group" && size.pane >= 640 ? await page.locator(".chat-message-avatar-gutter").count() : 0);
    const inlineFaces = await page.locator(".chat-speaker-inline-avatar").evaluateAll(elements => elements.filter(element => getComputedStyle(element).display !== "none").length);
    if (people === "solo") {
      expect(inlineFaces).toBe(state === "working" ? 1 : 0);
      await expect(page.getByTestId("chat-speaker-agent-profile")).toHaveCount(0);
      if (state === "working") {
        const face=page.getByTestId("assistant-thinking-octo-compact");
        await expect(face).toBeVisible();
        await expect(face.locator("svg[data-octo-animated]")).toHaveAttribute("data-octo-animated","true");
        const status=page.getByTestId("assistant-typing-indicator");
        expect(await status.evaluate(element=>element.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
      }
    }
    else if (size.pane < 640) expect(inlineFaces).toBeGreaterThan(0);
  });
  }
});

if (version === "after") {
  for (const theme of ["light", "dark"]) test(`completed reply timestamp from keyboard ${theme}`, async ({page}) => {
    await page.setViewportSize({width:1280,height:900});
    await page.goto(`${base}?pane=420&theme=${theme}&state=completed`);
    await latest(page,"completed");
    const action=page.locator('[data-chat-message-id="latest-assistant"]').last().getByTestId("chat-message-actions");
    await action.press("Enter");
    await expect(page.getByRole("dialog",{name:"Message actions",exact:true})).toBeVisible();
    await expect(page.getByTestId("chat-message-sent-time").locator("time")).toHaveAttribute("datetime","2026-11-02T10:08:40.000Z");
    await expect(page.getByTestId("chat-message-sent-time")).toBeVisible();
    if (artifactRoot) await page.screenshot({path:path.join(artifactRoot,"after",`message-time-desktop-${theme}.png`),animations:"disabled"});
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(action).toBeFocused();
  });

  test.describe("touch message details", () => {
    test.use({isMobile:true,hasTouch:true,viewport:{width:320,height:740}});
    for (const kind of ["reply", "error"]) test(`mobile keyboard reaches ${kind} actions inside the pane`, async ({page}) => {
      await page.goto(`${base}?layout=full&theme=dark&state=completed${kind === "error" ? "&error=1" : ""}`);
      await latest(page,"completed");
      const action=page.locator('[data-chat-message-id="latest-assistant"]').last().getByTestId("chat-message-actions");
      await page.keyboard.press("Tab");
      await action.focus();
      await expect(action).toHaveCSS("opacity","1");
      const geometry=await action.evaluate(element=>{
        const scroller=document.querySelector('[data-testid="chat-message-scroll"]')!;
        const rect=element.getBoundingClientRect();
        return {left:rect.left,right:rect.right,height:rect.height,scrollbarStart:scroller.getBoundingClientRect().right-((scroller as HTMLElement).offsetWidth-scroller.clientWidth)};
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.scrollbarStart-4);
      expect(geometry.height).toBeGreaterThanOrEqual(44);
      if (artifactRoot) await page.screenshot({path:path.join(artifactRoot,"after",`message-focus-mobile-${kind}.png`),animations:"disabled"});
      await action.press("Enter");
      await expect(page.getByTestId("chat-message-sent-time")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(action).toBeFocused();
    });
    for (const theme of ["light","dark"]) test(`completed reply long press shows timestamp ${theme}`, async ({page}) => {
      await page.goto(`${base}?layout=full&theme=${theme}&state=completed`);
      await latest(page,"completed");
      const message=page.locator('[data-chat-message-id="latest-assistant"]').last();
      const box=await message.boundingBox();
      if (!box) throw new Error("Expected visible completed reply");
      const cdp=await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:box.x+30,y:box.y+18}]});
      await expect(page.getByRole("dialog",{name:"Message actions",exact:true})).toBeVisible();
      await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
      await expect(page.getByTestId("chat-message-sent-time").locator("time")).toHaveAttribute("datetime","2026-11-02T10:08:40.000Z");
      await expect(page.getByTestId("chat-message-sent-time")).toBeVisible();
      if (artifactRoot) await page.screenshot({path:path.join(artifactRoot,"after",`message-time-mobile-${theme}.png`),animations:"disabled"});
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await cdp.detach();
    });
  });

  test("shared scrollbar respects forced colors", async ({page}) => {
    await page.setViewportSize({width:1280,height:900});
    await page.emulateMedia({forcedColors:"active"});
    await page.goto(`${base}?pane=420`);
    await latest(page);
    expect(await page.getByTestId("chat-message-scroll").evaluate(element=>getComputedStyle(element).getPropertyValue("--studio-scrollbar-thumb"))).toBe("");
  });

  for (const theme of ["light","dark"]) test(`busy status wraps and keeps its face idle ${theme}`, async ({page}) => {
    await page.setViewportSize({width:320,height:740});
    await page.goto(`${base}?layout=full&theme=${theme}&status=busy`);
    await latest(page);
    const status=page.getByTestId("assistant-typing-indicator");
    await expect(status.locator("svg[data-octo-animated]")).toHaveAttribute("data-octo-animated","false");
    const sizes=await status.evaluate(element=>({client:element.clientWidth,scroll:element.scrollWidth,height:element.getBoundingClientRect().height}));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.client+1);
    expect(sizes.height).toBeGreaterThan(32);
    if (artifactRoot) await page.screenshot({path:path.join(artifactRoot,"after",`busy-mobile-${theme}.png`),animations:"disabled"});
  });

  test("message More stays clear of the scrollbar", async ({page}) => {
    await page.setViewportSize({width:1280,height:900});
    await page.goto(`${base}?pane=420&theme=dark`);
    await latest(page);
    const message=page.locator('[data-chat-message-id="latest-assistant"]').last();
    await message.hover();
    const action=message.getByTestId("chat-message-actions");
    await expect(action).toHaveCSS("opacity","1");
    const geometry=await action.evaluate(element=>{
      const scroller=document.querySelector('[data-testid="chat-message-scroll"]')!;
      const rect=element.getBoundingClientRect();
      return {left:rect.left,right:rect.right,scrollbarStart:scroller.getBoundingClientRect().right-(scroller.clientLeft+(scroller as HTMLElement).offsetWidth-scroller.clientWidth)};
    });
    console.log("Message More geometry",JSON.stringify(geometry));
    if (artifactRoot) await page.screenshot({path:path.join(artifactRoot,"after","message-more-420-dark.png"),animations:"disabled"});
    expect(geometry.right).toBeLessThanOrEqual(geometry.scrollbarStart-8);
  });

  for (const width of [320, 1280]) for (const theme of ["light", "dark"]) {
    test(`keyboard identity and local approval ${width} ${theme}`, async ({page}) => {
      await page.setViewportSize({width,height:900});
      await page.goto(`${base}?pane=420&people=group&theme=${theme}`);
      const identity = page.getByTestId("chat-speaker-agent-profile").filter({hasText:"route-planner"}).first();
      await identity.press("Enter");
      await expect(page.getByTestId("review-event")).toHaveText(JSON.stringify({handle:"route-planner",agentId:"review-agent-planner",avatarSeed:"review-planner"}));
      await latest(page);
      await page.getByRole("button",{name:"Deny",exact:true}).click();
      await expect(page.getByTestId("review-event")).toHaveText("Browser request: deny");
      await expect(page.getByTestId("browser-approval-row")).toHaveCount(0);
      await expect(page.getByTestId("chat-input")).toHaveText("Keep the riverside route.");
    });
  }

  test("pane width controls group identity at a fixed desktop viewport", async ({page}) => {
    await page.setViewportSize({width:1280,height:900});
    await page.goto(`${base}?pane=420&people=group`);
    await expect(page.locator(".chat-message-avatar-gutter").first()).toBeHidden();
    await page.getByTestId("chat-input").fill("Keep this unsent draft while resizing.");
    const handle=page.getByRole("separator");
    await handle.press("End");
    await expect(page.locator(".chat-message-avatar-gutter").first()).toBeVisible();
    await handle.press("Home");
    await expect(page.locator(".chat-message-avatar-gutter").first()).toBeHidden();
    await latest(page);
    await expect(page.getByTestId("chat-input")).toHaveText("Keep this unsent draft while resizing.");
  });

  for (const width of [320,1280]) for (const theme of ["light","dark"]) test(`compact peer typing, multiple agents and warning ${width} ${theme}`, async ({page}) => {
    await page.setViewportSize({width,height:900});
    await page.goto(`${base}?pane=420&people=group&typing=multi&warning=1&theme=${theme}`);
    await latest(page);
    await expect(page.getByTestId("human-typing-indicator")).toContainText("Alex is typing");
    const heading=page.locator(".chat-typing-speaker-header");
    await expect(heading).toContainText("Octo");
    await expect(heading).toContainText("route-planner");
    await heading.getByTestId("chat-speaker-agent-profile").filter({hasText:"route-planner"}).press("Enter");
    await expect(page.getByTestId("review-event")).toContainText('"agentId":"review-agent-planner"');
    const warning=page.getByTestId("chat-workspace-start-stalled");
    await expect(warning).toBeVisible();
    await expect(warning.locator(".chat-message-gutter-spine")).toBeHidden();
    if (artifactRoot) await page.screenshot({path:path.join(artifactRoot,"after",`multi-typing-${width}-${theme}.png`),animations:"disabled"});
    await page.getByTestId("chat-workspace-start-retry").click();
    await expect(page.getByTestId("review-event")).toHaveText("Workspace retry requested");
  });

  test("same-handle speakers retain their exact profile identities in a compact pane", async ({page}) => {
    await page.setViewportSize({width:1280,height:900});
    await page.goto(`${base}?pane=420&people=group&sameHandle=1`);
    const identities=page.getByTestId("chat-speaker-agent-profile").filter({hasText:"route-planner"});
    await identities.nth(0).press("Enter");
    await expect(page.getByTestId("review-event")).toContainText('"agentId":"review-agent-planner"');
    await identities.nth(1).press("Enter");
    await expect(page.getByTestId("review-event")).toContainText('"agentId":"review-agent-planner-two"');
  });

  for (const width of [320,1280]) test(`long content stays within pane ${width}`, async ({page}) => {
    await page.setViewportSize({width,height:900});
    await page.goto(`${base}?pane=420&stress=1&theme=dark`);
    await latest(page);
    const dimensions=await page.getByTestId("chat-message-scroll").evaluate(element=>({client:element.clientWidth,scroll:element.scrollWidth}));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client+1);
    const code=page.getByTestId("chat-message-scroll").locator("pre");
    await expect(code).toBeVisible();
    expect(await code.evaluate(element=>element.scrollWidth)).toBeGreaterThan(await code.evaluate(element=>element.clientWidth));
  });
}
