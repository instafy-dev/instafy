import { ProviderSurfaceSandboxShell } from "./provider-sandbox/ProviderSurfaceSandboxShell";
import { ProviderSandboxSdkProvider } from "./provider-sandbox/providerSandboxSdk";
import { useEmbeddedProviderSandboxRuntime } from "./provider-sandbox/useEmbeddedProviderSandboxRuntime";

export function ProviderSurfaceSandboxPage() {
  const { rootRef, snapshot } = useEmbeddedProviderSandboxRuntime();

  return (
    <main
      ref={rootRef}
      className="min-h-screen bg-[var(--surface-base)] px-6 py-8 text-[var(--text-primary)]"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <ProviderSandboxSdkProvider snapshot={snapshot}>
          <ProviderSurfaceSandboxShell />
        </ProviderSandboxSdkProvider>
      </div>
    </main>
  );
}
