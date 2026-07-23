import { useCallback, useState } from "react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";

export type SurfaceActionBinding = {
  hostBindingId?: string;
};

export type SurfaceAction = {
  label: string;
  description?: string;
  variant: "primary" | "outline" | "ghost";
  binding?: SurfaceActionBinding;
};

export type SurfaceHostActionBinding = {
  label?: string;
  busyLabel?: string;
  description?: string;
  variant?: "primary" | "outline" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  hidden?: boolean;
  onPress?: () => Promise<void> | void;
};

type ProviderHostSurfaceActionsProps = {
  actions: SurfaceAction[];
  hostBindings?: Record<string, SurfaceHostActionBinding>;
};

type ActionRuntimeState = {
  loading: boolean;
  error: string | null;
};

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildActionKey(action: SurfaceAction) {
  return action.label;
}

export function ProviderHostSurfaceActions({
  actions,
  hostBindings,
}: ProviderHostSurfaceActionsProps) {
  const [actionState, setActionState] = useState<Record<string, ActionRuntimeState>>({});

  const handlePress = useCallback(
    async (action: SurfaceAction) => {
      const actionKey = buildActionKey(action);
      const hostBindingId = normalizeOptionalString(action.binding?.hostBindingId);
      const hostBinding = hostBindingId ? hostBindings?.[hostBindingId] : undefined;
      if (!hostBinding?.onPress) {
        return;
      }

      setActionState((current) => ({
        ...current,
        [actionKey]: {
          loading: true,
          error: null,
        },
      }));

      try {
        await hostBinding.onPress();
        setActionState((current) => ({
          ...current,
          [actionKey]: {
            loading: false,
            error: null,
          },
        }));
      } catch (error) {
        setActionState((current) => ({
          ...current,
          [actionKey]: {
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    [hostBindings],
  );

  if (actions.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2">
      {actions.map((action) => {
        const actionKey = buildActionKey(action);
        const hostBindingId = normalizeOptionalString(action.binding?.hostBindingId);
        const hostBinding = hostBindingId ? hostBindings?.[hostBindingId] : undefined;
        if (hostBinding?.hidden) {
          return null;
        }

        const runtimeState = actionState[actionKey];
        const loading = runtimeState?.loading === true || hostBinding?.loading === true;
        const error = runtimeState?.error ?? null;
        const label = loading
          ? hostBinding?.busyLabel ?? `${hostBinding?.label ?? action.label}…`
          : hostBinding?.label ?? action.label;
        const description = hostBinding?.description ?? action.description;
        const variant = hostBinding?.variant ?? action.variant;
        const disabled = hostBinding?.disabled === true || loading || !hostBinding?.onPress;

        return (
          <div
            key={actionKey}
            className="rounded-xl border border-[var(--border)] px-3 py-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-1">
                <Text variant="caption" tone="muted" className="block">
                  {action.label}
                </Text>
                {description ? (
                  <Text variant="caption" tone="muted">
                    {description}
                  </Text>
                ) : null}
              </div>
              <Button
                variant={variant}
                size="xs"
                radius="xl"
                onPress={() => {
                  void handlePress(action);
                }}
                isDisabled={disabled}
                data-testid={`provider-host-surface-action-${action.label
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/(^-|-$)/g, "")}`}
              >
                {label}
              </Button>
            </div>
            {error ? (
              <Text variant="caption" tone="danger" className="mt-2 block">
                {error}
              </Text>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
