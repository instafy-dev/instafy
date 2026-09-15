import { useEffect, useId, useMemo, useState } from "react";
import type {
  ProjectContentCapability,
  ProviderProjectBinding,
} from "@instafy/sdk/provider-project-binding";
import { Button } from "../../../components/Button";
import { Checkbox } from "../../../components/Checkbox";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import {
  StudioDialogBody,
  StudioDialogHeader,
  StudioDialogSectionLabel,
} from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { useStatus } from "../../../status/useStatus";
import { upsertProjectProviderBinding } from "../../../services/runtimeController/providerBindings";

export interface ProviderBindingApprovalDefaults {
  providerId?: string | null;
  purpose?: string | null;
  preferredPrefix?: string | null;
  capabilities?: ProjectContentCapability[];
  existingBinding?: ProviderProjectBinding | null;
  providerIdLocked?: boolean;
  title?: string;
  description?: string;
  saveLabel?: string;
}

interface ProviderBindingApprovalModalProps {
  isOpen: boolean;
  projectId: string | null;
  defaults: ProviderBindingApprovalDefaults;
  onClose: () => void;
  onSaved?: (binding: ProviderProjectBinding) => void;
}

function hasCapability(
  capabilities: ProjectContentCapability[] | undefined,
  capability: ProjectContentCapability,
): boolean {
  return Boolean(capabilities?.includes(capability));
}

function normalizeRootUriInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
    return trimmed;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${encodeURI(normalized)}`;
  }
  return null;
}

export function ProviderBindingApprovalModal({
  isOpen,
  projectId,
  defaults,
  onClose,
  onSaved,
}: ProviderBindingApprovalModalProps) {
  const fieldId = useId();
  const { showStatus } = useStatus();
  const [providerId, setProviderId] = useState("");
  const [purpose, setPurpose] = useState("");
  const [prefix, setPrefix] = useState("");
  const [rootUri, setRootUri] = useState("");
  const [readEnabled, setReadEnabled] = useState(true);
  const [writeEnabled, setWriteEnabled] = useState(true);
  const [savePending, setSavePending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const initialProviderId = defaults.providerId ?? defaults.existingBinding?.providerId ?? "";
    const initialPurpose = defaults.purpose ?? defaults.existingBinding?.purpose ?? "";
    const initialPrefix =
      defaults.preferredPrefix ?? defaults.existingBinding?.grantedPrefix ?? "";
    const initialRootUri = defaults.existingBinding?.rootUri ?? "";
    const initialCapabilities =
      defaults.capabilities ?? defaults.existingBinding?.grantedCapabilities ?? ["project_content_read"];

    setProviderId(initialProviderId);
    setPurpose(initialPurpose);
    setPrefix(initialPrefix);
    setRootUri(initialRootUri);
    setReadEnabled(
      hasCapability(initialCapabilities, "project_content_read") ||
        hasCapability(initialCapabilities, "project_content_write"),
    );
    setWriteEnabled(hasCapability(initialCapabilities, "project_content_write"));
    setSavePending(false);
    setFormError(null);
  }, [defaults, isOpen]);

  const computedCapabilities = useMemo<ProjectContentCapability[]>(() => {
    const result: ProjectContentCapability[] = [];
    if (readEnabled || writeEnabled) {
      result.push("project_content_read");
    }
    if (writeEnabled) {
      result.push("project_content_write");
    }
    return result;
  }, [readEnabled, writeEnabled]);

  const normalizedProviderId = providerId.trim();
  const normalizedPurpose = purpose.trim();
  const normalizedPrefix = prefix.trim();
  const normalizedRootUri = normalizeRootUriInput(rootUri);
  const hasRootUriInput = rootUri.trim().length > 0;
  const defaultPrefix =
    normalizedProviderId.length > 0 ? `.instafy/providers/${normalizedProviderId}/` : ".instafy/providers/provider/";
  const resolvedPrefix = normalizedPrefix || defaultPrefix;
  const providerIdLocked = Boolean(defaults.providerIdLocked);

  const handleSave = async () => {
    if (!projectId) {
      setFormError("Select a project before granting provider access.");
      return;
    }
    if (!normalizedProviderId) {
      setFormError("Provider is required.");
      return;
    }
    if (!normalizedPurpose) {
      setFormError("Purpose is required.");
      return;
    }
    if (computedCapabilities.length === 0) {
      setFormError("Select at least one access level.");
      return;
    }
    if (hasRootUriInput && !normalizedRootUri) {
      setFormError("Workspace root must be a file URI or absolute path.");
      return;
    }

    setSavePending(true);
    setFormError(null);
    try {
      const binding = await upsertProjectProviderBinding({
        projectId,
        providerId: normalizedProviderId,
        purpose: normalizedPurpose,
        grantedCapabilities: computedCapabilities,
        grantedPrefix: resolvedPrefix,
        rootUri: normalizedRootUri,
      });
      if (!binding) {
        throw new Error("Unable to save provider access.");
      }
      showStatus(
        defaults.existingBinding ? `Updated provider access for ${normalizedProviderId}.` : `Granted provider access to ${normalizedProviderId}.`,
        "success",
        2500,
      );
      onSaved?.(binding);
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFormError(message);
      showStatus(message, "error", 4000);
    } finally {
      setSavePending(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <StudioDialogModal isOpen={isOpen} onOpenChange={(next) => !next && onClose()} dialogAriaLabel="Provider access approval">
      <StudioDialogHeader
        title={defaults.title ?? "Approve provider access"}
        description={
          defaults.description ??
          "Allow this provider to use the current project workspace."
        }
        onClose={onClose}
      />
      <StudioDialogBody className="space-y-4">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Provider" htmlFor={`${fieldId}-provider`}>
              <Input
                id={`${fieldId}-provider`}
                value={providerId}
                onChange={(event) => {
                  setProviderId(event.target.value);
                  if (formError) {
                    setFormError(null);
                  }
                }}
                disabled={providerIdLocked || savePending}
                placeholder="provider-id"
                data-testid="provider-binding-provider-id"
              />
            </Field>
            <Field label="Storage folder" htmlFor={`${fieldId}-prefix`}>
              <Input
                id={`${fieldId}-prefix`}
                value={prefix}
                onChange={(event) => {
                  setPrefix(event.target.value);
                  if (formError) {
                    setFormError(null);
                  }
                }}
                disabled={savePending}
                placeholder={defaultPrefix}
                data-testid="provider-binding-prefix"
              />
            </Field>
          </div>

          <Field label="Purpose" htmlFor={`${fieldId}-purpose`}>
            <Input
              id={`${fieldId}-purpose`}
              value={purpose}
              onChange={(event) => {
                setPurpose(event.target.value);
                if (formError) {
                  setFormError(null);
                }
              }}
              disabled={savePending}
              placeholder="Store learned state and project summaries."
              data-testid="provider-binding-purpose"
            />
          </Field>

          <Field label="Workspace root" htmlFor={`${fieldId}-root`} hint="Optional. Leave blank to use the linked local workspace when one is available.">
            <Input
              id={`${fieldId}-root`}
              value={rootUri}
              onChange={(event) => {
                setRootUri(event.target.value);
                if (formError) {
                  setFormError(null);
                }
              }}
              disabled={savePending}
              placeholder="file:///home/name/project or /home/name/project"
              data-testid="provider-binding-root-uri"
            />
          </Field>

          <div className="space-y-2">
            <StudioDialogSectionLabel>Access</StudioDialogSectionLabel>
            <div className="space-y-2 rounded-2xl border border-slate-200/70 px-3 py-3 dark:border-slate-800">
              <Checkbox
                isSelected={readEnabled}
                isDisabled={savePending}
                onChange={(selected) => {
                  setReadEnabled(selected);
                  if (!selected) {
                    setWriteEnabled(false);
                  }
                  if (formError) {
                    setFormError(null);
                  }
                }}
                label="Read project files"
                description="Allow this provider to inspect files and saved state."
                data-testid="provider-binding-read"
              />
              <Checkbox
                isSelected={writeEnabled}
                isDisabled={savePending}
                onChange={(selected) => {
                  setWriteEnabled(selected);
                  if (selected) {
                    setReadEnabled(true);
                  }
                  if (formError) {
                    setFormError(null);
                  }
                }}
                label="Write project files"
                description="Allow this provider to create or update project content."
                data-testid="provider-binding-write"
              />
            </div>
          </div>

          {formError ? (
            <Text variant="caption" tone="danger" data-testid="provider-binding-error">
              {formError}
            </Text>
          ) : null}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            onPress={onClose}
            variant="ghost"
            size="sm"
            radius="xl"
            isDisabled={savePending}
            data-testid="provider-binding-cancel"
          >
            Cancel
          </Button>
          <Button
            onPress={() => void handleSave()}
            variant="primary"
            size="sm"
            radius="xl"
            isDisabled={savePending}
            data-testid="provider-binding-save"
          >
            {savePending ? "Saving…" : defaults.saveLabel ?? "Allow access"}
          </Button>
        </div>
      </StudioDialogBody>
    </StudioDialogModal>
  );
}
