import { expect, test, type Page } from "@playwright/test";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE = "/__composer-image-markup__";
const DRAFT = "Keep this draft while I mark up the screenshot.";

type FileSnapshot = { id: string; name: string; type: string; size: number; sha256: string; hasOriginal: boolean };

async function mount(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  // Token-detail helpers share this optional registry; this fixture has no
  // transcript artifacts or provider features. The attachment hook, lightbox,
  // canvas drawing/export, object URLs, and browser File objects remain real.
  await page.route("**/src/capabilities/localCapabilityArtifactRegistry.ts*", route => route.fulfill({
    contentType: "application/javascript", body: "export function resolveLocalCapabilityArtifact(){return null;}",
  }));
  await page.route("**/*", async route => {
    if (route.request().method() !== "GET") {
      failures.push(`Unexpected ${route.request().method()} request`);
      await route.abort();
    } else await route.fallback();
  });
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDOMNS from "${deps.reactDomClient}";
    import { useChatComposerAttachments } from "/src/screens/studio/components/useChatComposerAttachments.ts";
    import { ChatImageLightboxOverlay } from "/src/screens/studio/components/ChatPanelOverlays.tsx";
    const React=ReactNS.default??ReactNS, {createRoot}=ReactDOMNS.default??ReactDOMNS, h=React.createElement;
    function Fixture(){
      const [draft,setDraft]=React.useState(${JSON.stringify(DRAFT)});
      const [draftKey,setDraftKey]=React.useState("first");
      const [selectedId,setSelectedId]=React.useState(null);
      const [locked,setLocked]=React.useState(false);
      const [snapshot,setSnapshot]=React.useState([]);
      const [status,setStatus]=React.useState("");
      const attachments=useChatComposerAttachments({draftKey,isInputLocked:()=>locked,showStatus:setStatus});
      const selected=attachments.imageAttachments.find(item=>item.id===selectedId)??null;
      React.useEffect(()=>{
        let current=true;
        void Promise.all(attachments.imageAttachments.map(async item=>({id:item.id,name:item.file.name,type:item.file.type,size:item.file.size,
          sha256:Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await item.file.arrayBuffer()))).map(value=>value.toString(16).padStart(2,"0")).join(""),
          hasOriginal:Boolean(item.originalFile)}))).then(value=>{if(current)setSnapshot(value);});
        return()=>{current=false;};
      },[attachments.imageAttachments]);
      return h("main",{style:{padding:12,minHeight:"100dvh"}},
        h("h1",null,"Synthetic image markup component QA"),
        h("p",null,"No upload, controller, runtime or model execution."),
        h("textarea",{"data-testid":"fixture-draft","aria-label":"Draft",value:draft,onChange:event=>setDraft(event.target.value),style:{display:"block",width:"100%"}}),
        h("input",{type:"file",accept:"image/*",multiple:true,ref:attachments.imageInputRef,onChange:attachments.handleImageInputChange,"data-testid":"fixture-image-input"}),
        h("button",{"data-testid":"fixture-upload-toggle",onClick:()=>setLocked(value=>!value)},locked?"Finish simulated upload":"Start simulated upload"),
        h("button",{"data-testid":"fixture-chat-switch",onClick:()=>{setSelectedId(null);setDraftKey(value=>value==="first"?"second":"first");}},"Switch fixture chat"),
        h("output",{"data-testid":"fixture-files",hidden:true},JSON.stringify(snapshot)),
        h("output",{"data-testid":"fixture-status"},status),
        h("section",{style:{display:"flex",gap:8,overflowX:"auto"}},attachments.imageAttachments.map((item,index)=>h("button",{
          key:item.id,"data-testid":"fixture-preview-"+index,onClick:()=>setSelectedId(item.id),"aria-label":"Preview image "+(index+1)},
          h("img",{src:item.previewUrl,alt:item.file.name,style:{width:100,height:80,objectFit:"contain"}})))),
        h(ChatImageLightboxOverlay,{
          imageLightbox:selected?{src:selected.previewUrl,alt:selected.file.name}:null,onClose:()=>setSelectedId(null),editDisabled:locked,
          onSaveMarkup:selected?(blob)=>{
            const replacement=new File([blob],selected.file.name.replace(/\\.[^.]+$/,"")+".png",{type:"image/png"});
            if(!attachments.replaceImageAttachment(selected.id,selected.file,replacement))throw new Error("Attachment changed before save");
          }:undefined,
          onRestoreOriginal:selected?.originalFile?()=>attachments.restoreImageAttachment(selected.id,selected.file):undefined,
        }));
    }
    createRoot(document.getElementById("root")).render(h(Fixture));`;
  await page.route(`**${FIXTURE}/main.js`, route => route.fulfill({ contentType: "application/javascript", body: main }));
  await page.route(`**${FIXTURE}`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="/@vite/client"></script><script type="module" src="${FIXTURE}/main.js"></script>
    </head><body><div id="root"></div></body></html>` }));
  await page.goto(FIXTURE);
  await expect(page.getByTestId("fixture-draft")).toHaveValue(DRAFT);
  expect(failures).toEqual([]);
  return failures;
}

async function selectImages(page: Page) {
  const buffers = await page.evaluate(() => ["#e2e8f0", "#bae6fd"].map(color => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#334155";
    context.fillRect(25, 25, 65, 25);
    return canvas.toDataURL("image/png").split(",")[1];
  }));
  await page.getByTestId("fixture-image-input").setInputFiles(buffers.map((buffer, index) => ({
    name: `screenshot-${index + 1}.png`, mimeType: "image/png", buffer: Buffer.from(buffer, "base64"),
  })));
  await expect(page.getByTestId("fixture-preview-1")).toBeVisible();
  await expect.poll(async () => (await files(page)).length).toBe(2);
}

async function files(page: Page): Promise<FileSnapshot[]> {
  return page.getByTestId("fixture-files").evaluate(node => JSON.parse(node.textContent ?? "[]"));
}

async function openMarkup(page: Page, index = 0) {
  await page.getByTestId(`fixture-preview-${index}`).click();
  await expect(page.getByTestId("chat-image-lightbox-image")).toBeVisible();
  await page.getByTestId("chat-image-markup-open").click();
  await expect(page.getByTestId("image-markup-canvas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pen", exact: true })).toBeEnabled();
}

async function draw(page: Page, tool: "Pen" | "Arrow", y = 0.55) {
  await page.getByRole("button", { name: tool, exact: true }).click();
  const bounds = await page.getByTestId("image-markup-canvas").boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * 0.2, bounds!.y + bounds!.height * y);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.75, bounds!.y + bounds!.height * (y - 0.15), { steps: 12 });
  await page.mouse.up();
}

const canvasPixels = (page: Page) => page.getByTestId("image-markup-canvas").evaluate(async node => {
  // Compare painted pixels after the browser has presented the pointer frame,
  // rather than racing a canvas renderer's requestAnimationFrame callback.
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const canvas = node as HTMLCanvasElement;
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
  const hash = await crypto.subtle.digest("SHA-256", pixels);
  return Array.from(new Uint8Array(hash)).map(value => value.toString(16).padStart(2, "0")).join("");
});

test("saving pen and arrow markup changes actual PNG bytes for only the selected attachment and preserves the draft", async ({ page }, testInfo) => {
  const failures = await mount(page);
  await selectImages(page);
  const original = await files(page);
  await openMarkup(page);
  const baseline = await canvasPixels(page);
  await draw(page, "Pen");
  await draw(page, "Arrow", 0.8);
  expect(await canvasPixels(page)).not.toBe(baseline);
  await page.getByRole("button", { name: "Save markup", exact: true }).click();
  await expect(page.getByTestId("image-markup-canvas")).toBeHidden();
  await expect(page.getByTestId("chat-image-lightbox-image")).toBeVisible();
  await expect.poll(async () => (await files(page))[0]?.sha256).not.toBe(original[0].sha256);
  const updated = await files(page);
  expect(updated[0]).toMatchObject({ id: original[0].id, type: "image/png", hasOriginal: true });
  expect(updated[1]).toEqual(original[1]);
  const exportedPixels = await page.getByTestId("chat-image-lightbox-image").evaluate(async node => {
    const image = node as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let redPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 180 && pixels[index] > pixels[index + 1] * 1.5 && pixels[index] > pixels[index + 2] * 1.5) redPixels++;
    }
    return { width: canvas.width, height: canvas.height, redPixels };
  });
  expect(exportedPixels).toMatchObject({ width: 320, height: 200 });
  expect(exportedPixels.redPixels).toBeGreaterThan(100);
  await expect(page.getByTestId("chat-image-restore-original")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("saved-markup-preview.png") });
  await page.getByTestId("chat-image-lightbox-close").click();
  await expect(page.getByTestId("fixture-draft")).toHaveValue(DRAFT);
  await expect(page.getByTestId("fixture-preview-0")).toBeFocused();
  expect(failures).toEqual([]);
});

test("Undo and Clear drawing reset real canvas pixels while Cancel leaves the selected File unchanged", async ({ page }, testInfo) => {
  const failures = await mount(page);
  await selectImages(page);
  const original = await files(page);
  await openMarkup(page);
  const baseline = await canvasPixels(page);
  await draw(page, "Pen");
  const pen = await canvasPixels(page);
  expect(pen).not.toBe(baseline);
  const readInk = () => page.getByTestId("image-markup-canvas").evaluate(async node => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const canvas = node as HTMLCanvasElement;
    const bytes = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    const positions: number[] = [];
    for (let index = 0; index < bytes.length; index += 4) {
      if (bytes[index] > 160 && bytes[index] > bytes[index + 1] + 50 && bytes[index] > bytes[index + 2] + 50) positions.push(index / 4);
    }
    return { positions, lowerInk: positions.filter(index => Math.floor(index / canvas.width) > canvas.height * 0.65).length };
  });
  const beforeInk = await readInk();
  expect(beforeInk.positions.length).toBeGreaterThan(100);
  expect(beforeInk.lowerInk).toBe(0);
  await page.getByTestId("image-markup-canvas").screenshot({ path: testInfo.outputPath("pen-before-arrow.png") });
  await draw(page, "Arrow", 0.85);
  expect((await readInk()).lowerInk).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const afterInk = await readInk();
  // Canvas acceleration can change antialias edge pixels on repaint. Assert
  // the original pen remains and the spatially separate arrow is gone.
  const retained = new Set(afterInk.positions);
  expect(beforeInk.positions.filter(index => retained.has(index)).length / beforeInk.positions.length).toBeGreaterThan(0.98);
  expect(afterInk.positions.length / beforeInk.positions.length).toBeLessThan(1.15);
  expect(afterInk.lowerInk).toBe(0);
  await page.getByTestId("image-markup-canvas").screenshot({ path: testInfo.outputPath("pen-after-undo.png") });
  await page.getByRole("button", { name: "Clear drawing", exact: true }).click();
  expect(await canvasPixels(page)).toBe(baseline);
  await draw(page, "Arrow");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("image-markup-canvas")).toBeHidden();
  expect(await files(page)).toEqual(original);
  await page.getByTestId("chat-image-lightbox-close").click();
  await expect(page.getByTestId("fixture-draft")).toHaveValue(DRAFT);
  expect(failures).toEqual([]);
});

test("Restore original returns the exact original bytes after repeated edits without altering another image or chat draft", async ({ page }) => {
  const failures = await mount(page);
  await selectImages(page);
  const original = await files(page);
  await openMarkup(page, 1);
  await draw(page, "Arrow");
  await page.getByRole("button", { name: "Save markup", exact: true }).click();
  await expect(page.getByTestId("chat-image-restore-original")).toBeVisible();
  await page.getByTestId("chat-image-markup-open").click();
  await expect(page.getByTestId("image-markup-canvas")).toBeVisible();
  await draw(page, "Pen", 0.8);
  await page.getByRole("button", { name: "Save markup", exact: true }).click();
  await page.getByTestId("chat-image-restore-original").click();
  await expect.poll(async () => (await files(page))[1]?.sha256).toBe(original[1].sha256);
  expect(await files(page)).toEqual(original);
  await page.getByTestId("chat-image-lightbox-close").click();
  await page.getByTestId("fixture-chat-switch").click();
  await expect.poll(async () => (await files(page)).length).toBe(0);
  await page.getByTestId("fixture-chat-switch").click();
  await expect.poll(async () => (await files(page)).length).toBe(2);
  expect(await files(page)).toEqual(original);
  await expect(page.getByTestId("fixture-draft")).toHaveValue(DRAFT);
  expect(failures).toEqual([]);
});

test("markup controls and canvas fit a short phone viewport and Escape keeps dialog focus and original bytes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 438 });
  const failures = await mount(page);
  await selectImages(page);
  const original = await files(page);
  await openMarkup(page);
  await draw(page, "Pen");
  const geometry = await page.getByRole("dialog").evaluate(node => {
    const bounds = node.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: innerWidth, height: innerHeight,
      pageWidth: document.documentElement.scrollWidth };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height + 1);
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.width);
  for (const label of ["Pen", "Arrow", "Undo", "Clear drawing", "Save markup", "Cancel"]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toBeInViewport();
  }
  for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect.poll(() => page.getByRole("dialog").evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  const screenshot = testInfo.outputPath("phone-image-markup.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("phone image markup", { contentType: "image/png", path: screenshot });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("image-markup-canvas")).toBeHidden();
  expect(await files(page)).toEqual(original);
  expect(failures).toEqual([]);
});

test("upload lock preserves preview access while preventing markup and restoration", async ({ page }) => {
  const failures = await mount(page);
  await selectImages(page);
  await openMarkup(page);
  await draw(page, "Pen");
  await page.getByRole("button", { name: "Save markup", exact: true }).click();
  await expect.poll(async () => (await files(page))[0]?.hasOriginal).toBe(true);
  const edited = await files(page);
  await page.getByTestId("chat-image-lightbox-close").click();
  await page.getByTestId("fixture-upload-toggle").click();
  await page.getByTestId("fixture-preview-0").click();
  await expect(page.getByTestId("chat-image-lightbox-image")).toBeVisible();
  await expect(page.getByTestId("chat-image-markup-open")).toBeDisabled();
  await expect(page.getByTestId("chat-image-restore-original")).toBeDisabled();
  expect(await files(page)).toEqual(edited);
  await page.getByTestId("chat-image-lightbox-close").click();
  await page.getByTestId("fixture-upload-toggle").click();
  await page.getByTestId("fixture-preview-0").click();
  await expect(page.getByTestId("chat-image-markup-open")).toBeEnabled();
  await expect(page.getByTestId("chat-image-restore-original")).toBeEnabled();
  expect(failures).toEqual([]);
});
