// A space without a name is stored without one (NULL on the controller, ""
// locally) and every surface shows the same words for it. Older builds wrote
// their own placeholder into the store and, from the New space form, onto the
// controller; those read as untitled too, so they never hide a real name.
export const UNTITLED_SPACE_NAME = "Untitled space";

const LEGACY_PLACEHOLDER_NAMES = new Set(["untitled space", "untitled instafy project"]);

export function isUntitledSpaceName(name: string | null | undefined): boolean {
  const trimmed = name?.trim() ?? "";
  return trimmed.length === 0 || LEGACY_PLACEHOLDER_NAMES.has(trimmed.toLowerCase());
}

export function spaceDisplayName(name: string | null | undefined): string {
  return isUntitledSpaceName(name) ? UNTITLED_SPACE_NAME : (name ?? "").trim();
}

/** The stored name, or null when it is empty or a placeholder. */
export function realSpaceName(name: string | null | undefined): string | null {
  return isUntitledSpaceName(name) ? null : (name ?? "").trim();
}
