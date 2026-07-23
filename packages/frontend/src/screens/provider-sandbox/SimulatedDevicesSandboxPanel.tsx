import { useState } from "react";
import type {
  ProviderUiSurfaceControlOption,
  ProviderUiSurfaceSandboxHostControl,
} from "@instafy/provider-contract";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Select } from "../../components/Select";
import {
  useProviderSandboxHostData,
  useProviderSandboxHostMutations,
} from "./providerSandboxSdk";

function formatHostControlValue(control: ProviderUiSurfaceSandboxHostControl) {
  if (control.kind === "toggle") {
    return control.value === true ? "On" : "Off";
  }
  if (
    control.kind === "select" &&
    typeof control.value === "string" &&
    control.value.trim().length > 0
  ) {
    const selectedOption = control.options?.find((option) => option.value === control.value);
    return selectedOption?.label ?? control.value.trim();
  }
  if (typeof control.value === "string" && control.value.trim().length > 0) {
    return control.value.trim();
  }
  return control.placeholder ?? "Not set";
}

export function SimulatedDevicesSandboxPanel() {
  const [powerState, setPowerState] = useState<"on" | "off">("off");
  const hostData = useProviderSandboxHostData();
  const hostMutations = useProviderSandboxHostMutations();

  return (
    <div className="space-y-4 rounded-3xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-5 shadow-sm">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Desk lamp demo</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          This local-trusted provider mounts an isolated settings surface inside the shared shell.
        </p>
      </div>

      <div className="flex items-center justify-between rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-base)] px-4 py-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-[var(--text-primary)]">Desk lamp</p>
          <p className="text-xs text-[var(--text-secondary)]">
            Sandboxed provider-owned demo control
          </p>
        </div>
        <Badge tone={powerState === "on" ? "success" : "neutral"}>
          {powerState === "on" ? "On" : "Off"}
        </Badge>
      </div>

      <Button
        variant={powerState === "on" ? "outline" : "primary"}
        onPress={() => setPowerState((current) => (current === "on" ? "off" : "on"))}
      >
        {powerState === "on" ? "Turn off" : "Turn on"}
      </Button>

      <Button
        variant="ghost"
        isDisabled={!hostMutations.canOpenExternal}
        onPress={() => {
          const docsUrl = "https://example.com/providers/simulated-devices";
          hostMutations.openExternal(docsUrl);
        }}
      >
        Open provider docs
      </Button>

      <Button
        variant="ghost"
        onPress={() => {
          hostData.refreshHostState();
        }}
      >
        Refresh host state
      </Button>

      {hostMutations.actions.length ? (
        <div className="space-y-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-base)] p-4">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-secondary)]">
            Host actions
          </p>
          <div className="flex flex-wrap gap-2">
            {hostMutations.actions.map((action) => (
              <Button
                key={action.id}
                variant={action.variant ?? "outline"}
                isDisabled={action.disabled}
                onPress={() => {
                  hostMutations.invokeHostAction(action.id);
                }}
              >
                {action.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {hostMutations.controls.length ? (
        <div className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-base)] p-4">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-secondary)]">
            Host controls
          </p>
          <div className="grid gap-3">
            {hostMutations.controls.map((control) => (
              <div
                key={control.id}
                className="space-y-2 rounded-2xl border border-[var(--border-subtle)] px-3 py-3"
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{control.label}</p>
                  {control.description ? (
                    <p className="text-xs text-[var(--text-secondary)]">{control.description}</p>
                  ) : null}
                </div>

                {control.kind === "toggle" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant={control.value === true ? "outline" : "primary"}
                      isDisabled={control.disabled || control.loading}
                      onPress={() => {
                        hostMutations.updateHostControl(control.id, control.value !== true);
                      }}
                    >
                      {control.value === true ? "Turn off" : "Turn on"}
                    </Button>
                    <Badge tone={control.value === true ? "success" : "neutral"}>
                      {formatHostControlValue(control)}
                    </Badge>
                  </div>
                ) : control.kind === "select" ? (
                  <div className="space-y-2">
                    <Select
                      aria-label={control.label}
                      value={typeof control.value === "string" ? control.value : ""}
                      disabled={control.disabled || control.loading}
                      onChange={(event) => {
                        hostMutations.updateHostControl(control.id, event.currentTarget.value);
                      }}
                    >
                      <option value="">{control.placeholder ?? "Select…"}</option>
                      {(control.options ?? []).map((option: ProviderUiSurfaceControlOption) => (
                        <option key={`${control.id}:${option.value}`} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                    <Badge tone="neutral">{formatHostControlValue(control)}</Badge>
                  </div>
                ) : (
                  <Badge tone="neutral">{formatHostControlValue(control)}</Badge>
                )}

                {control.loading ? <Badge tone="neutral">Loading</Badge> : null}
                {control.error ? (
                  <p className="text-xs text-[var(--text-danger)]">{control.error}</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {hostData.sections.length ? (
        <div className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-base)] p-4">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-secondary)]">
            Host sections
          </p>
          <div className="grid gap-3">
            {hostData.sections.map((section) => (
              <div
                key={section.id}
                className="space-y-2 rounded-2xl border border-[var(--border-subtle)] px-3 py-3"
              >
                {section.title ? (
                  <p className="text-sm font-medium text-[var(--text-primary)]">{section.title}</p>
                ) : null}
                {section.description ? (
                  <p className="text-xs text-[var(--text-secondary)]">{section.description}</p>
                ) : null}
                {section.facts?.length ? (
                  <dl className="grid gap-2 sm:grid-cols-2">
                    {section.facts.map((fact) => (
                      <div key={`${section.id}:${fact.label}:${fact.value}`} className="space-y-1">
                        <dt className="text-xs font-medium text-[var(--text-secondary)]">
                          {fact.label}
                        </dt>
                        <dd className="text-sm text-[var(--text-primary)]">{fact.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {section.items?.length ? (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--text-primary)]">
                    {section.items.map((item) => (
                      <li key={`${section.id}:${item}`}>{item}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {hostData.resources.length ? (
        <div className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-base)] p-4">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-secondary)]">
            Host resources
          </p>
          <div className="grid gap-3">
            {hostData.resources.map((resource) => (
              <div
                key={resource.id}
                className="space-y-2 rounded-2xl border border-[var(--border-subtle)] px-3 py-3"
              >
                {resource.title ? (
                  <p className="text-sm font-medium text-[var(--text-primary)]">{resource.title}</p>
                ) : null}
                {resource.description ? (
                  <p className="text-xs text-[var(--text-secondary)]">{resource.description}</p>
                ) : null}
                {resource.facts?.length ? (
                  <dl className="grid gap-2 sm:grid-cols-2">
                    {resource.facts.map((fact) => (
                      <div key={`${resource.id}:${fact.label}:${fact.value}`} className="space-y-1">
                        <dt className="text-xs font-medium text-[var(--text-secondary)]">
                          {fact.label}
                        </dt>
                        <dd className="text-sm text-[var(--text-primary)]">{fact.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {resource.items?.length ? (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--text-primary)]">
                    {resource.items.map((item) => (
                      <li key={`${resource.id}:${item}`}>{item}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
