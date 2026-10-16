import { useState } from "react";
import { RuntimeMenuPanel } from "../../../src/runtime/components/RuntimeMenuPanel";
import type { RuntimeMenuOption } from "../../../src/runtime/useRuntimeMenu";

const noop = () => {};
const stoppedRuntime: RuntimeMenuOption = {
  id: "review-runtime",
  label: "Review machine",
  detail: "A stopped self-hosted machine used only for the local component review.",
  state: "offline",
  badge: null,
  isSessionOverride: false,
  tunnel: null,
  needsActivation: false,
  isLikelyLocal: false,
  provider: "self-hosted",
  runtimeImage: "example/runtime:review",
};
const runningRuntime: RuntimeMenuOption = {
  ...stoppedRuntime,
  id: "review-running",
  label: "Running machine",
  detail: "Expand this machine to inspect its Stop action.",
  state: "online",
};

// Real production panels with local selection and inert lifecycle callbacks.
// No controller or device calls.
// The warning's Open space fallback uses Router context if it is ever shown.
export function RuntimeSurfaces() {
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string | null>(stoppedRuntime.id);
  const [headerSelectedRuntimeId, setHeaderSelectedRuntimeId] = useState<string | null>(null);
  return (
    <div className="grid items-start gap-6 lg:col-span-2 lg:grid-cols-2">
      <section aria-label="Runtime list actions">
        <RuntimeMenuPanel
          title="Machine picker"
          runtimeEnsureError={null}
          connectionWarning={null}
          runtimeOptions={[stoppedRuntime, runningRuntime]}
          selectedRuntimeId={selectedRuntimeId}
          defaultExpandedOptionId={stoppedRuntime.id}
          onSelectOption={setSelectedRuntimeId}
          onClose={noop}
          onStartRuntime={noop}
          onTerminateRuntime={noop}
          onRemoveRuntime={noop}
          listClassName="mt-2"
        />
      </section>
      <section aria-label="Runtime header actions">
        <RuntimeMenuPanel
          title="Machines page"
          runtimeEnsureError={null}
          connectionWarning={null}
          runtimeOptions={[stoppedRuntime, runningRuntime]}
          selectedRuntimeId={headerSelectedRuntimeId}
          defaultExpandedOptionId={stoppedRuntime.id}
          onSelectOption={setHeaderSelectedRuntimeId}
          onClose={noop}
          onStartRuntime={noop}
          onTerminateRuntime={noop}
          onRemoveRuntime={noop}
          headerActions
          interactionMode="manage"
          listClassName="mt-2"
        />
      </section>
      <section aria-label="Runtime recovery actions">
        <RuntimeMenuPanel
          title="Machine recovery"
          runtimeEnsureError="Review fixture: all hosted runtime slots are occupied."
          runtimeEnsureLimit={{
            limitReached: true, activeCount: 1, maxActiveCount: 1,
            blockerRuntimeId: "review-blocker", blockerProjectId: "review-space",
            blockerRuntimeLabel: "Background machine", blockerProjectLabel: "Other space",
          }}
          connectionWarning={null}
          runtimeOptions={[runningRuntime]}
          selectedRuntimeId={null}
          onSelectOption={noop}
          onClose={noop}
          // Exercise the recoverable failure state without contacting a runtime.
          onTakeOverHostedRuntimeLimit={async () => false}
          listClassName="mt-2"
        />
      </section>
    </div>
  );
}
