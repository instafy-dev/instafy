import { desktopWindowChrome } from "../../lib/desktopShell";

// When the desktop shell hides the macOS title bar (hiddenInset), the web app
// owns the top of the window: a fixed drag strip makes the window movable and
// a document-level inset keeps interactive content out from under the traffic
// lights. Both are gated on the bridge capability, so browsers and older app
// shells are untouched.
let installed = false;

export function installDesktopWindowChromeBootstrap(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  if (desktopWindowChrome() !== "hiddenInset") return;
  document.documentElement.classList.add("desktop-window-chrome-inset");
  const strip = document.createElement("div");
  strip.className = "desktop-window-drag-strip";
  strip.setAttribute("aria-hidden", "true");
  document.body.prepend(strip);
}
