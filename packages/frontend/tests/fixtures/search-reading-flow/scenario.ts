import type { ChatMessage } from "../../../src/screens/studio/types";

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
export const IMAGE_PATH = `${PROJECT_ID}/${CONVERSATION_ID}/33333333-3333-4333-8333-333333333333.jpg`;
export const FILE_PATH = `${PROJECT_ID}/${CONVERSATION_ID}/44444444-4444-4444-8444-444444444444.md`;
export const IMAGE_NAME = "landing-page-reference.jpg";
export const FILE_NAME = "navigation-review-notes-for-the-autumn-website-refresh.md";
export const TARGET_ID = "older-navigation-notes";
export const TARGET_TEXT = "Here are the navigation notes and the original landing page image. Keep the quiet opening, with the project links easy to find on a phone.";
const stamp = Date.UTC(2026, 9, 28, 9, 15);
const author = { agent: { handle: "octo", avatarSeed: "octo" } };
export const olderMessages: ChatMessage[] = [
  { id: "older-question", role: "user", authorId: "review-user", timestamp: stamp, content: "Please compare the two navigation ideas before we update the website." },
  { id: "older-answer", role: "assistant", timestamp: stamp + 10000, content: "The simpler option gives the work more room. I would keep Projects and About at the top, then move secondary links into the footer.", metadata: author },
  { id: TARGET_ID, role: "user", authorId: "review-user", timestamp: stamp + 60000, content: TARGET_TEXT, metadata: { attachments: [
    { kind: "image", storagePath: IMAGE_PATH, fileName: IMAGE_NAME, mimeType: "image/jpeg", sizeBytes: 154000 },
    { kind: "file", storagePath: FILE_PATH, fileName: FILE_NAME, mimeType: "text/markdown", sizeBytes: 3200 },
  ] } },
  { id: "older-review", role: "assistant", timestamp: stamp + 70000, content: "I’ll use these as the reference. The navigation needs to remain readable at 320 pixels, and the same links should be available with a keyboard.\n\nThe image gives the opening a clear focal point; the notes explain where each link belongs.", metadata: author },
  ...Array.from({ length: 8 }, (_, index): ChatMessage => ({
    id: `older-followup-${index}`, role: index % 2 ? "assistant" : "user", authorId: index % 2 ? undefined : "review-user",
    timestamp: stamp + 90000 + index * 90000,
    content: ["Keep the contact link visible without making the header crowded.", "The contact link can stay after About. At narrow widths, the menu groups secondary links under one clear control.", "Please check the longest project title too.", "The title can wrap across two lines. I’ll keep the hit area wide enough for touch and leave room for the active indicator."][index % 4],
    metadata: index % 2 ? author : undefined,
  })),
];
export const newerMessages: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
  id: `newer-followup-${index}`, role: index % 2 ? "assistant" : "user", authorId: index % 2 ? undefined : "review-user",
  timestamp: stamp + (index + 20) * 90000,
  content: index === 11 ? "The review is ready. The project links, keyboard order and mobile spacing now agree with the original navigation notes."
    : index % 2 ? "I checked the next screen against the same reference. The links keep their order and the page remains readable when the text wraps."
      : "Use the same navigation order for the remaining project pages, and preserve the labels from our notes.",
  metadata: index % 2 ? author : undefined,
}));

const fileText = `# Navigation review\n\nThese notes accompany the original landing page reference.\n\n## Primary links\n\n- Projects\n- About\n- Contact\n\nKeep the link order the same on phones and desktop. Give every control a visible keyboard focus state.\n\n## Mobile reading\n\nAllow long project titles to wrap, preserve a comfortable reading width, and avoid horizontal page scrolling.\n\n` + Array.from({ length: 14 }, (_, index) => `### Review note ${index + 1}\n\nThe project links should remain easy to find as content grows. Test the opening, the project list and the contact footer at the smallest supported width.\n\n`).join("") + "Long source label: " + "navigation-review-source-".repeat(20);
let imageAttempts = 0;
let fileAttempts = 0;

/** Only the Storage transport is replaced. Validation, cache and viewers stay real. */
export async function downloadFixtureAttachment(path: string) {
  const options = new URLSearchParams(location.search);
  await new Promise(resolve => setTimeout(resolve, options.get("delay") === "1" ? 900 : 70));
  const attempt = path === IMAGE_PATH ? ++imageAttempts : ++fileAttempts;
  const failure = path === IMAGE_PATH ? options.get("image") : options.get("file");
  if (failure === "unavailable") return { data: null, error: { status: 404, message: "Not found" } };
  if (failure === "retry" && attempt === 1) return { data: null, error: { status: 503, message: "Unavailable" } };
  if (path === FILE_PATH) return { data: new Blob([
    failure === "large" ? "# Long navigation review\n\n" + "Read the project notes — mobile and keyboard.\n".repeat(3000) : fileText,
  ], { type: "text/markdown" }), error: null };
  if (path !== IMAGE_PATH) throw new Error("Unexpected fixture attachment");
  const response = await fetch("/landing-tentacles.jpg");
  if (!response.ok) throw new Error("The repository image could not be read");
  const source = await response.blob();
  if (["design-tall", "design-wide"].includes(options.get("imageShape") ?? "")) {
    // A local design reference makes image inspection useful: small text, card
    // details and distant sections are real pixels inside the downloaded image.
    const bitmap = await createImageBitmap(source);
    const tall = options.get("imageShape") === "design-tall";
    const canvas = document.createElement("canvas");
    canvas.width = tall ? 720 : 2400;
    canvas.height = tall ? 4320 : 1200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#f6f4f0";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const text = (value: string, x: number, y: number, size = 24, color = "#263047") => {
      context.fillStyle = color;
      context.font = `${size >= 32 ? 650 : 400} ${size}px system-ui, sans-serif`;
      context.fillText(value, x, y);
    };
    const section = (x: number, y: number, width: number, index: number) => {
      context.fillStyle = "#ffffff";
      context.fillRect(x, y, width, 820);
      context.drawImage(bitmap, x, y, width, 330);
      text(`0${index + 1} / PROJECT NOTES`, x + 28, y + 382, 18, "#66718b");
      text(["A quieter opening", "Projects in focus", "Room for detail", "Links that stay clear", "A useful footer"][index], x + 28, y + 438, 36);
      text("Navigation review · Autumn collection", x + 28, y + 488, 22);
      for (let line = 0; line < 5; line++) text([
        "Keep the main project links in the same order.",
        "Let long names wrap without hiding the work.",
        "Use space to separate each group of details.",
        "Check the layout at every reading width.",
        "Projects / About / Contact",
      ][line], x + 28, y + 548 + line * 46, 21);
      context.strokeStyle = "#dfe2e8";
      context.strokeRect(x + 28, y + 766, width - 56, 1);
      text(`REFERENCE ${index + 1} · 2026`, x + 28, y + 802, 16, "#66718b");
    };
    text("DESIGN LAB / WEBSITE REFRESH", 40, 52, 20, "#66718b");
    text(tall ? "Navigation, in detail" : "The complete project board", 40, 112, 42);
    text("Original image reference · inspect the headings and small type", 40, 155, 19);
    if (tall) for (let index = 0; index < 5; index++) section(40, 190 + index * 820, 640, index);
    else for (let index = 0; index < 3; index++) section(40 + index * 790, 220, 740, index);
    bitmap.close();
    const data = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not render the inspection fixture image")), "image/jpeg", .94));
    return { data, error: null };
  }
  if (options.get("imageShape") === "tall") {
    // A deterministic tall raster exercises fit/gesture geometry without
    // changing the production image element or requesting a remote asset.
    const bitmap = await createImageBitmap(source);
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 2160;
    const context = canvas.getContext("2d")!;
    for (let index = 0; index < 8; index++) context.drawImage(bitmap, 0, index * 270, 360, 270);
    bitmap.close();
    const data = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not render the tall fixture image")), "image/jpeg", .9));
    return { data, error: null };
  }
  return { data: source, error: null };
}
