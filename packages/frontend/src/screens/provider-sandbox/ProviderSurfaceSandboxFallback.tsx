export function ProviderSurfaceSandboxFallback() {
  return (
    <div className="rounded-3xl border border-dashed border-[var(--border-subtle)] bg-[var(--surface-muted)] p-5">
      <p className="text-sm text-[var(--text-secondary)]">
        No provider-specific sandbox view is registered for this route yet. Providers can point a
        sandboxed surface at a same-origin or external isolated UI URL when they need richer
        custom UI than the shared host surface SDK supports.
      </p>
    </div>
  );
}
