import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const INTERACTIVE = [
  EDITABLE, "button", "a", "label", "summary", '[tabindex]:not([tabindex="-1"])',
  '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="checkbox"]',
  '[role="radio"]', '[role="switch"]', '[role="option"]', '[role="tab"]',
  '[role="slider"]', '[role="spinbutton"]', '[role="combobox"]', '[role="textbox"]',
].join(", ");

/** Use one iPhone keyboard policy for chat, search, forms and editors. */
export function installNativeKeyboardAccessory(doc: Document = document): () => void {
  if (Capacitor.getPlatform() !== "ios" || !Capacitor.isPluginAvailable("Keyboard")) {
    return () => undefined;
  }

  // Apply before React mounts any fields. Keep the policy constant as focus
  // moves so WebKit never needs to replace a cached accessory between screens.
  void Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {
    // Editing must still work if an older native shell cannot apply the policy.
  });
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (
      target instanceof Element &&
      doc.activeElement instanceof HTMLElement &&
      doc.activeElement.matches(EDITABLE) &&
      !target.closest(INTERACTIVE)
    ) {
      // A completed background tap replaces Done everywhere, including dialogs.
      // Waiting for click avoids dismissing on scroll, drag or text selection.
      // Controls and labels keep their existing focus and activation behavior.
      doc.activeElement.blur();
    }
  };

  doc.addEventListener("click", onClick, true);
  return () => {
    doc.removeEventListener("click", onClick, true);
  };
}
