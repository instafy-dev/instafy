import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Badge } from "../../../components/Badge";
import { Checkbox } from "../../../components/Checkbox";
import { Field } from "../../../components/Field";
import { Select } from "../../../components/Select";
import { Text } from "../../../components/Text";
import {
  callLocalProviderTool,
  readLocalProviderResource,
  type LocalProviderSummary,
} from "../../../capabilities/localProviderHostClient";

export type SurfaceControlOption = {
  label: string;
  value: string;
  description?: string;
};

export type SurfaceControlBinding = {
  hostBindingId?: string;
  readResourceAlias?: string;
  readResourceUri?: string;
  valuePath?: string;
  writeToolAlias?: string;
  writeToolName?: string;
  writeValueArgument?: string;
  writeArguments?: Record<string, unknown>;
};

export type SurfaceHostBinding = {
  value?: string | boolean;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  hidden?: boolean;
  description?: string;
  placeholder?: string;
  options?: SurfaceControlOption[];
  hideOptionBadges?: boolean;
  onChange?: (nextValue: string | boolean) => Promise<void> | void;
};

export type SurfaceControl = {
  kind: "readonly" | "toggle" | "select";
  label: string;
  description?: string;
  value?: string | boolean;
  placeholder?: string;
  disabled: boolean;
  options: SurfaceControlOption[];
  binding?: SurfaceControlBinding;
};

type ProviderHostSurfaceControlsProps = {
  provider: LocalProviderSummary;
  controls: SurfaceControl[];
  hostBindings?: Record<string, SurfaceHostBinding>;
};

type ControlRuntimeState = {
  value?: string | boolean;
  loading: boolean;
  error: string | null;
};

type ResolvedControlBinding = {
  readResourceUri: string | null;
  writeToolName: string | null;
};

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveBoundResourceUri(provider: LocalProviderSummary, binding?: SurfaceControlBinding) {
  if (!binding) {
    return null;
  }
  const explicit = normalizeOptionalString(binding.readResourceUri);
  if (explicit) {
    return explicit;
  }
  const alias = normalizeOptionalString(binding.readResourceAlias);
  if (!alias) {
    return null;
  }
  const aliases = provider.resourceAliases as Record<string, string | undefined> | undefined;
  return normalizeOptionalString(aliases?.[alias]);
}

function resolveBoundToolName(provider: LocalProviderSummary, binding?: SurfaceControlBinding) {
  if (!binding) {
    return null;
  }
  const explicit = normalizeOptionalString(binding.writeToolName);
  if (explicit) {
    return explicit;
  }
  const alias = normalizeOptionalString(binding.writeToolAlias);
  if (!alias) {
    return null;
  }
  const aliases = provider.toolAliases as Record<string, string | undefined> | undefined;
  return normalizeOptionalString(aliases?.[alias]);
}

function resolveHostBindingId(binding?: SurfaceControlBinding) {
  return normalizeOptionalString(binding?.hostBindingId);
}

function readValueAtPath(value: unknown, path?: string | null): unknown {
  const normalizedPath = normalizeOptionalString(path);
  if (!normalizedPath) {
    return value;
  }
  return normalizedPath.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function coerceBoundControlValue(value: unknown): string | boolean | undefined {
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function buildControlKey(control: SurfaceControl) {
  return `${control.kind}:${control.label}`;
}

export function readSurfaceControlBindings(
  provider: LocalProviderSummary,
  controls: SurfaceControl[],
): Record<string, ResolvedControlBinding> {
  return Object.fromEntries(
    controls.map((control) => [
      buildControlKey(control),
      {
        readResourceUri: resolveBoundResourceUri(provider, control.binding),
        writeToolName: resolveBoundToolName(provider, control.binding),
      },
    ]),
  );
}

function formatControlValueWithOptions(
  control: SurfaceControl,
  options: SurfaceControlOption[],
  runtimeValue?: string | boolean,
) {
  const effectiveValue = runtimeValue ?? control.value;
  if (control.kind === "toggle") {
    if (typeof effectiveValue === "boolean") {
      return effectiveValue ? "On" : "Off";
    }
    return control.placeholder ?? "Not set";
  }

  if (control.kind === "select") {
    if (typeof effectiveValue === "string" && effectiveValue.trim().length > 0) {
      const selectedOption = options.find((option) => option.value === effectiveValue);
      return selectedOption?.label ?? effectiveValue.trim();
    }
    return control.placeholder ?? "No selection declared";
  }

  if (typeof effectiveValue === "string" && effectiveValue.trim().length > 0) {
    return effectiveValue.trim();
  }

  return control.placeholder ?? "Not provided";
}

export function ProviderHostSurfaceControls({
  provider,
  controls,
  hostBindings,
}: ProviderHostSurfaceControlsProps) {
  const fieldId = useId();
  const bindings = useMemo(() => readSurfaceControlBindings(provider, controls), [provider, controls]);
  const [controlState, setControlState] = useState<Record<string, ControlRuntimeState>>({});

  useEffect(() => {
    let cancelled = false;
    const boundControls = controls.filter((control) => bindings[buildControlKey(control)]?.readResourceUri);
    if (boundControls.length === 0) {
      setControlState((current) => {
        const next = { ...current };
        for (const control of controls) {
          if (!bindings[buildControlKey(control)]?.readResourceUri) {
            delete next[buildControlKey(control)];
          }
        }
        return next;
      });
      return () => {
        cancelled = true;
      };
    }

    for (const control of boundControls) {
      const controlKey = buildControlKey(control);
      setControlState((current) => ({
        ...current,
        [controlKey]: {
          value: current[controlKey]?.value,
          loading: true,
          error: null,
        },
      }));
      void (async () => {
        try {
          const result = await readLocalProviderResource(
            provider.id,
            bindings[controlKey]?.readResourceUri ?? "",
          );
          if (cancelled) {
            return;
          }
          const nextValue = coerceBoundControlValue(
            readValueAtPath(result.value, control.binding?.valuePath),
          );
          setControlState((current) => ({
            ...current,
            [controlKey]: {
              value: nextValue,
              loading: false,
              error: null,
            },
          }));
        } catch (error) {
          if (cancelled) {
            return;
          }
          setControlState((current) => ({
            ...current,
            [controlKey]: {
              value: current[controlKey]?.value,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            },
          }));
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [bindings, controls, provider.id]);

  const handleWrite = useCallback(
    async (control: SurfaceControl, nextValue: string | boolean) => {
      const controlKey = buildControlKey(control);
      const hostBindingId = resolveHostBindingId(control.binding);
      const hostBinding = hostBindingId ? hostBindings?.[hostBindingId] : undefined;
      if (hostBinding?.onChange) {
        setControlState((current) => ({
          ...current,
          [controlKey]: {
            value: nextValue,
            loading: true,
            error: null,
          },
        }));
        try {
          await hostBinding.onChange(nextValue);
          setControlState((current) => ({
            ...current,
            [controlKey]: {
              value: nextValue,
              loading: false,
              error: null,
            },
          }));
        } catch (error) {
          setControlState((current) => ({
            ...current,
            [controlKey]: {
              value: current[controlKey]?.value ?? hostBinding.value ?? control.value,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            },
          }));
        }
        return;
      }

      const writeToolName = bindings[controlKey]?.writeToolName;
      if (!writeToolName) {
        return;
      }
      setControlState((current) => ({
        ...current,
        [controlKey]: {
          value: current[controlKey]?.value ?? control.value,
          loading: true,
          error: null,
        },
      }));
      try {
        await callLocalProviderTool(provider.id, writeToolName, {
          ...(control.binding?.writeArguments ?? {}),
          [normalizeOptionalString(control.binding?.writeValueArgument) ?? "value"]: nextValue,
        });
        setControlState((current) => ({
          ...current,
          [controlKey]: {
            value: nextValue,
            loading: false,
            error: null,
          },
        }));
      } catch (error) {
        setControlState((current) => ({
          ...current,
          [controlKey]: {
            value: current[controlKey]?.value ?? control.value,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    [bindings, hostBindings, provider.id],
  );

  if (controls.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {controls.map((control, index) => {
        const controlKey = buildControlKey(control);
        const runtimeState = controlState[controlKey];
        const hostBindingId = resolveHostBindingId(control.binding);
        const hostBinding = hostBindingId ? hostBindings?.[hostBindingId] : undefined;
        if (hostBinding?.hidden) {
          return null;
        }
        const boundValue = hostBinding
          ? runtimeState?.loading === true || runtimeState?.error
            ? runtimeState?.value ?? hostBinding.value
            : hostBinding.value ?? runtimeState?.value
          : runtimeState?.value;
        const loading =
          runtimeState?.loading === true || hostBinding?.loading === true;
        const error = runtimeState?.error ?? hostBinding?.error ?? null;
        const writeToolName = bindings[controlKey]?.writeToolName;
        const hostManaged = control.disabled || hostBinding?.disabled === true;
        const canWrite = !hostManaged && Boolean(hostBinding?.onChange ?? writeToolName);
        const effectiveOptions = hostBinding?.options ?? control.options;
        const effectiveDescription = hostBinding?.description ?? control.description;
        const effectivePlaceholder = hostBinding?.placeholder ?? control.placeholder;
        const effectiveControl =
          effectiveOptions !== control.options || effectivePlaceholder !== control.placeholder
            ? {
                ...control,
                options: effectiveOptions,
                placeholder: effectivePlaceholder,
              }
            : control;
        const formattedValue = formatControlValueWithOptions(effectiveControl, effectiveOptions, boundValue);
        const showHostManagedBadge = hostManaged && control.kind !== "readonly";
        const statusBadges = loading || showHostManagedBadge ? (
          <div className="flex flex-wrap items-center gap-2">
            {loading ? <Badge tone="neutral">Loading</Badge> : null}
            {showHostManagedBadge ? <Badge tone="neutral">Host-managed</Badge> : null}
          </div>
        ) : null;

        return (
          <div key={controlKey}>
            {control.kind === "toggle" ? (
              <div className="space-y-2">
                <Checkbox
                  isSelected={
                    typeof (boundValue ?? control.value) === "boolean"
                      ? Boolean(boundValue ?? control.value)
                      : false
                  }
                  isDisabled={!canWrite || loading}
                  onChange={(next) => {
                    void handleWrite(control, next);
                  }}
                  label={control.label}
                  description={effectiveDescription}
                />
                {statusBadges}
                {error ? (
                  <Text variant="caption" tone="danger" className="block">
                    {error}
                  </Text>
                ) : null}
              </div>
            ) : control.kind === "select" && canWrite ? (
              <div className="space-y-2">
                <Field label={control.label} htmlFor={`${fieldId}-${index}`} hint={effectiveDescription} error={error}>
                  <Select
                    id={`${fieldId}-${index}`}
                    aria-label={control.label}
                    value={typeof (boundValue ?? control.value) === "string" ? String(boundValue ?? control.value) : ""}
                    disabled={loading}
                    onChange={(event) => {
                      void handleWrite(control, event.currentTarget.value);
                    }}
                    data-testid={`provider-host-surface-control-${provider.id}-${control.label
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "-")
                      .replace(/(^-|-$)/g, "")}`}
                  >
                    <option value="">{effectivePlaceholder ?? "Select…"}</option>
                    {effectiveOptions.map((option) => (
                      <option key={`${control.label}:${option.value}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                {statusBadges}
              </div>
            ) : (
              <Field label={control.label} hint={effectiveDescription} error={error}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Text variant="bodyStrong" tone="primary" className="min-w-0 flex-1">
                    {formattedValue}
                  </Text>
                  {statusBadges}
                </div>
              </Field>
            )}
          </div>
        );
      })}
    </div>
  );
}
