export function normalizeAssistantHandleLabel(handle: string | null | undefined): string {
  const value = typeof handle === "string" ? handle.trim() : "";
  const withoutAt = value.startsWith("@") ? value.slice(1).trim() : value;
  return withoutAt || "octo";
}
