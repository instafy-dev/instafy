const ESCAPE_OWNER_SELECTOR = [
  '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[role="listbox"]', '[role="tooltip"]',
  '[data-studio-popover]', '[data-react-aria-top-layer]', '[data-chat-escape-owner]',
  '[data-testid="chat-composer-overlay"][data-expanded="true"]',
  '[data-testid="chat-saved-message-popover"]', '[data-testid="assistant-mention-menu"]',
  '[data-testid="chat-slash-command-menu"]',
].join(",");

function isVisible(element: Element): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  // Lexical keeps empty typeahead anchors mounted even when no suggestions
  // are open. Only the populated popup owns Escape, not its dormant anchor.
  if (element.matches('[role="listbox"][aria-label="Typeahead menu"]')
    && element.childElementCount === 0 && !element.textContent?.trim()) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (getComputedStyle(current).display === "none") return false;
  }
  return true;
}

/** Snapshot before other Escape handlers can remove their overlay. Never consumes Escape. */
export function chatRunStopEscapeBlocked(event: KeyboardEvent, options: {
  active: boolean;
  blocked?: boolean;
  document?: Document;
}): boolean {
  const doc = options.document ?? document;
  if (!options.active || options.blocked || doc.visibilityState === "hidden" || event.key !== "Escape"
    || event.repeat || event.isComposing || event.keyCode === 229 || event.defaultPrevented
    || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true;
  if ([...doc.querySelectorAll(ESCAPE_OWNER_SELECTOR)].some(isVisible)) return true;
  const focused = event.target instanceof Element ? event.target : doc.activeElement;
  // Editors, terminals and browser surfaces have their own Escape behavior.
  // The ordinary chat composer is intentionally not excluded: its expanded,
  // autocomplete and draft handlers are guarded by the owner/context above.
  return Boolean(focused?.closest([
    '.monaco-editor', '.xterm', '[data-testid="browser-session-modal"]',
    '[data-testid="personal-browser-surface"]', '[data-testid="browser-session-viewport"]',
    '[data-testid="remote-browser-mobile-keyboard"]', 'iframe',
  ].join(",")));
}
