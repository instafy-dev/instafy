import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Exercise the exact origin-owned synchronous operation, not a second copy.
// Authorization/resize-ack races belong to the Rust tests; this case proves
// real Chromium focus, geometry and value preservation on inert content only.
const originSource = readFileSync(new URL(
  "../../../../origin-http-server/src/browser_screencast/input.rs",
  import.meta.url,
), "utf8");
const scriptMatches = [...originSource.matchAll(
  /const REVEAL_FOCUSED_EDITABLE_SCRIPT: &str = r#"([\s\S]*?)"#;/g,
)];
if (scriptMatches.length !== 1) throw new Error("Expected the production focused-editable script");
const revealScript = scriptMatches[0][1];

test("reveals only a clipped focused editable without changing focus or values", async ({ page }, testInfo) => {
  await page.route("**/*", (route) => route.abort());
  const cdp = await page.context().newCDPSession(page);
  const cases = [
    { name: "text", markup: '<input id="field" value="Inert text">', reveal: true },
    { name: "password", markup: '<input id="field" type="password" value="inert-fixture-only">', reveal: true },
    { name: "textarea", markup: '<textarea id="field">Inert textarea</textarea>', reveal: true },
    { name: "contenteditable", markup: '<div id="field" contenteditable="true">Inert editable</div>', reveal: true },
    { name: "open shadow input", markup: '<div id="host"></div>', shadow: true, reveal: true },
    { name: "nested overflow", markup: '<div id="scroller"><div style="height:300px"></div><input id="field" value="Inert nested"><div style="height:600px"></div></div>', nested: true, reveal: true },
    { name: "already visible", markup: '<input id="field" value="Inert visible">', visible: true, reveal: false },
    { name: "readonly", markup: '<input id="field" readonly value="Inert readonly">', reveal: false },
    { name: "readonly contenteditable input", markup: '<input id="field" readonly contenteditable="true" value="Inert readonly">', reveal: false },
    { name: "readonly textarea", markup: '<textarea id="field" readonly>Inert readonly</textarea>', reveal: false },
    { name: "disabled", markup: '<input id="field" disabled value="Inert disabled">', reveal: false },
    { name: "noneditable", markup: '<button id="field">Inert button</button>', reveal: false },
    { name: "non-text input", markup: '<input id="field" type="checkbox">', reveal: false },
  ];

  try {
    for (const scenario of cases) {
      await test.step(scenario.name, async () => {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: 411, height: 700, deviceScaleFactor: 1, mobile: false,
        });
        await page.setContent(`<!doctype html><meta charset="utf-8">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
          <style>html,body{margin:0}body{min-height:1600px;font:16px system-ui}
          #field{box-sizing:border-box;display:block;width:280px;height:40px;margin:0}
          #scroller{height:180px;overflow:auto;width:320px}</style>
          <div style="height:${scenario.visible ? 30 : 420}px"></div>${scenario.markup}`);
        await page.evaluate(({ shadow }) => {
          if (shadow) {
            document.getElementById("host")!.attachShadow({ mode: "open" }).innerHTML =
              '<input id="field" value="Inert shadow" style="box-sizing:border-box;width:280px;height:40px">';
          }
          const field = (document.getElementById("field") ?? document.getElementById("host")!.shadowRoot!.getElementById("field")) as HTMLElement;
          // Prevent automatic focus scrolling from doing the operation under test.
          field.focus({ preventScroll: true });
          window.scrollTo(0, 0);
          const fixture = window as Window & { __valueReads?: number; __valueWrites?: number };
          fixture.__valueReads = 0;
          fixture.__valueWrites = 0;
        }, { shadow: "shadow" in scenario && scenario.shadow });

        const snapshot = () => page.evaluate(() => {
          const field = (document.getElementById("field") ?? document.getElementById("host")!.shadowRoot!.getElementById("field")) as HTMLElement;
          let focused = document.activeElement;
          while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
          const rect = field.getBoundingClientRect();
          const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype
            : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : null;
          // Only the fixture observer reads the inert value. Access guards
          // below are scoped to the one synchronous production operation.
          const value = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")!.get!.call(field)
            : field.textContent;
          const fixture = window as Window & { __valueReads?: number; __valueWrites?: number };
          return {
            value, focusedId: focused?.id || focused?.tagName,
            fieldFocused: focused === field,
            top: rect.top, bottom: rect.bottom,
            scrollY, nestedScroll: document.getElementById("scroller")?.scrollTop ?? 0,
            viewportHeight: visualViewport!.height,
            reads: fixture.__valueReads, writes: fixture.__valueWrites,
          };
        });
        const original = await snapshot();
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: 411, height: 240, deviceScaleFactor: 1, mobile: false,
        });
        const clipped = await snapshot();
        expect(clipped.viewportHeight).toBe(240);
        if (scenario.reveal) {
          expect(clipped.fieldFocused).toBe(true);
          expect(clipped.bottom).toBeGreaterThan(240);
        }
        const result = await cdp.send("Runtime.evaluate", {
          // Playwright's trace recorder legitimately inspects form values
          // between calls. Install and restore this guard inside one atomic
          // evaluation, so only production-script accesses are counted.
          expression: `(() => {
            const field = document.getElementById('field') ?? document.getElementById('host').shadowRoot.getElementById('field');
            const guarded = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement;
            const original = Object.getOwnPropertyDescriptor(field, 'value');
            if (guarded) Object.defineProperty(field, 'value', {
              configurable: true,
              get() { window.__valueReads += 1; throw new Error('The reveal must not read values'); },
              set() { window.__valueWrites += 1; throw new Error('The reveal must not write values'); },
            });
            try {
              const result = ${revealScript}
              return result;
            } finally {
              if (guarded) {
                if (original) Object.defineProperty(field, 'value', original);
                else delete field.value;
              }
            }
          })()`,
          returnByValue: true, awaitPromise: false,
        });
        expect(result.exceptionDetails).toBeUndefined();
        expect(result.result.type).toBe("undefined");
        const after = await snapshot();
        expect(after.value).toBe(original.value);
        expect(after.focusedId).toBe(original.focusedId);
        expect(after.fieldFocused).toBe(original.fieldFocused);
        expect(after.reads).toBe(0);
        expect(after.writes).toBe(0);
        if (scenario.reveal) {
          expect(after.top).toBeGreaterThanOrEqual(0);
          // Nearest scrolling puts the clipped lower edge at the viewport edge,
          // instead of centering it or scrolling an already visible field.
          expect(after.bottom).toBeCloseTo(240, 0);
          expect(after.scrollY).toBeGreaterThan(clipped.scrollY);
          if ("nested" in scenario && scenario.nested) expect(after.nestedScroll).toBeGreaterThan(0);
        } else {
          expect(after).toEqual(clipped);
        }
        if (scenario.name === "text") {
          await testInfo.attach("Focused inert field after real Chromium viewport shrink", {
            body: await page.screenshot(), contentType: "image/png",
          });
        }
      });
    }
  } finally {
    await cdp.detach();
  }
});
