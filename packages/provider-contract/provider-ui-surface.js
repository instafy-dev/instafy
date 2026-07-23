import { createProviderUiSurfaceSandboxContainer } from "./provider-sandbox.js";
import {
  normalizeBoolean,
  normalizeRecord,
  normalizeStringArray,
  normalizeTrimmedString,
} from "./shared.js";

function normalizeUiSurfaceFact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const label = normalizeTrimmedString(value.label);
  const factValue = normalizeTrimmedString(value.value);
  if (!label || !factValue) {
    return null;
  }
  return {
    label,
    value: factValue,
  };
}

function normalizeUiSurfaceFacts(values) {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const facts = values
    .map((value) => normalizeUiSurfaceFact(value))
    .filter((value) => Boolean(value));
  return facts.length > 0 ? facts : undefined;
}

function normalizeUiSurfaceSectionBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const hostBindingId = normalizeTrimmedString(value.hostBindingId);
  return hostBindingId ? { hostBindingId } : undefined;
}

function normalizeUiSurfaceSection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const title = normalizeTrimmedString(value.title);
  const description = normalizeTrimmedString(value.description);
  const facts = normalizeUiSurfaceFacts(value.facts);
  const items = normalizeStringArray(value.items);
  const binding = normalizeUiSurfaceSectionBinding(value.binding);
  if (!title && !binding) {
    return null;
  }
  if (!description && !facts && !items && !binding) {
    return null;
  }
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(facts ? { facts } : {}),
    ...(items ? { items } : {}),
    ...(binding ? { binding } : {}),
  };
}

function normalizeUiSurfaceControlOption(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const label = normalizeTrimmedString(value.label);
  const optionValue = normalizeTrimmedString(value.value);
  const description = normalizeTrimmedString(value.description);
  if (!label || !optionValue) {
    return null;
  }
  return {
    label,
    value: optionValue,
    ...(description ? { description } : {}),
  };
}

function normalizeUiSurfaceActionBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const hostBindingId = normalizeTrimmedString(value.hostBindingId);
  return hostBindingId ? { hostBindingId } : undefined;
}

function normalizeUiSurfaceAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const label = normalizeTrimmedString(value.label);
  const description = normalizeTrimmedString(value.description);
  const variant =
    value.variant === "primary" || value.variant === "outline" || value.variant === "ghost"
      ? value.variant
      : undefined;
  const binding = normalizeUiSurfaceActionBinding(value.binding);
  if (!label) {
    return null;
  }
  return {
    label,
    ...(description ? { description } : {}),
    ...(variant ? { variant } : {}),
    ...(binding ? { binding } : {}),
  };
}

function normalizeUiSurfaceActions(values) {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const actions = values
    .map((value) => normalizeUiSurfaceAction(value))
    .filter((value) => Boolean(value));
  return actions.length > 0 ? actions : undefined;
}

function normalizeUiSurfaceControlBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const normalized = {
    hostBindingId: normalizeTrimmedString(value.hostBindingId),
    readResourceAlias: normalizeTrimmedString(value.readResourceAlias),
    readResourceUri: normalizeTrimmedString(value.readResourceUri),
    valuePath: normalizeTrimmedString(value.valuePath),
    writeToolAlias: normalizeTrimmedString(value.writeToolAlias),
    writeToolName: normalizeTrimmedString(value.writeToolName),
    writeValueArgument: normalizeTrimmedString(value.writeValueArgument),
    writeArguments: normalizeRecord(value.writeArguments),
  };
  return Object.values(normalized).some((item) => item !== undefined) ? normalized : undefined;
}

function normalizeUiSurfaceControl(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const kind =
    value.kind === "readonly" || value.kind === "toggle" || value.kind === "select"
      ? value.kind
      : undefined;
  const label = normalizeTrimmedString(value.label);
  const description = normalizeTrimmedString(value.description);
  const placeholder = normalizeTrimmedString(value.placeholder);
  const controlValue =
    typeof value.value === "string" || typeof value.value === "boolean" ? value.value : undefined;
  const disabled = normalizeBoolean(value.disabled);
  const options = Array.isArray(value.options)
    ? value.options
        .map((option) => normalizeUiSurfaceControlOption(option))
        .filter((option) => Boolean(option))
    : undefined;
  const binding = normalizeUiSurfaceControlBinding(value.binding);
  if (!kind || !label) {
    return null;
  }
  return {
    kind,
    label,
    ...(description ? { description } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(controlValue !== undefined ? { value: controlValue } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
    ...(options?.length ? { options } : {}),
    ...(binding ? { binding } : {}),
  };
}

function normalizeUiSurfacePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const trustLevel =
    value.trustLevel === "first_party" ||
    value.trustLevel === "local_trusted" ||
    value.trustLevel === "untrusted"
      ? value.trustLevel
      : undefined;
  const renderMode =
    value.renderMode === "host_declarative" ||
    value.renderMode === "sandboxed"
      ? value.renderMode
      : undefined;
  return trustLevel || renderMode
    ? {
        ...(trustLevel ? { trustLevel } : {}),
        ...(renderMode ? { renderMode } : {}),
      }
    : undefined;
}

function normalizeUiSurfaceControls(values) {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const controls = values
    .map((value) => normalizeUiSurfaceControl(value))
    .filter((value) => Boolean(value));
  return controls.length > 0 ? controls : undefined;
}

function normalizeUiSurfaceElement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const element = normalizeTrimmedString(value.element);
  if (!element) {
    return null;
  }
  switch (element) {
    case "highlights": {
      const items = normalizeStringArray(value.items);
      return items ? { element: "highlights", items } : null;
    }
    case "facts": {
      const facts = normalizeUiSurfaceFacts(value.facts);
      return facts ? { element: "facts", facts } : null;
    }
    case "section": {
      const section = normalizeUiSurfaceSection(value);
      return section ? { element: "section", ...section } : null;
    }
    case "controls": {
      const controls = normalizeUiSurfaceControls(value.controls);
      return controls ? { element: "controls", controls } : null;
    }
    case "actions": {
      const actions = normalizeUiSurfaceActions(value.actions);
      return actions ? { element: "actions", actions } : null;
    }
    case "hint": {
      const text = normalizeTrimmedString(value.text);
      return text ? { element: "hint", text } : null;
    }
    default:
      return null;
  }
}

const DEFAULT_EXTENSION_ATTACHMENT_ACTION_DESCRIPTION =
  "Attach or detach this provider.";

export function createProviderUiSurfaceHighlights(items) {
  const normalizedItems = normalizeStringArray(items);
  return normalizedItems ? { element: "highlights", items: normalizedItems } : undefined;
}

export function createProviderUiSurfaceFacts(facts) {
  const normalizedFacts = normalizeUiSurfaceFacts(facts);
  return normalizedFacts ? { element: "facts", facts: normalizedFacts } : undefined;
}

export function createProviderUiSurfaceSection(input) {
  const section = normalizeUiSurfaceSection(input);
  return section ? { element: "section", ...section } : undefined;
}

export function createProviderUiSurfaceControls(controls) {
  const normalizedControls = normalizeUiSurfaceControls(controls);
  return normalizedControls
    ? { element: "controls", controls: normalizedControls }
    : undefined;
}

export function createProviderUiSurfaceActions(actions) {
  const normalizedActions = normalizeUiSurfaceActions(actions);
  return normalizedActions ? { element: "actions", actions: normalizedActions } : undefined;
}

export function createProviderUiSurfaceHint(text) {
  const normalizedText = normalizeTrimmedString(text);
  return normalizedText ? { element: "hint", text: normalizedText } : undefined;
}

function collectUiSurfaceElements(values, results) {
  if (!Array.isArray(values)) {
    return results;
  }
  for (const value of values) {
    if (Array.isArray(value)) {
      collectUiSurfaceElements(value, results);
      continue;
    }
    const normalized = normalizeUiSurfaceElement(value);
    if (normalized) {
      results.push(normalized);
    }
  }
  return results;
}

export function createProviderUiSurfaceElements(elements) {
  if (!Array.isArray(elements)) {
    return undefined;
  }
  const normalizedElements = collectUiSurfaceElements(elements, []);
  return normalizedElements.length > 0 ? normalizedElements : undefined;
}

export function createProviderUiSurfacePolicy(input) {
  return normalizeUiSurfacePolicy(input);
}

export function createProviderUiSurfaceExtensionAttachmentAction(input) {
  const actionInput =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const bindingInput =
    actionInput.binding &&
    typeof actionInput.binding === "object" &&
    !Array.isArray(actionInput.binding)
      ? actionInput.binding
      : {};
  return createProviderUiSurfaceActions([
    {
      ...actionInput,
      label: actionInput.label ?? "Attachment",
      description:
        actionInput.description ?? DEFAULT_EXTENSION_ATTACHMENT_ACTION_DESCRIPTION,
      variant: actionInput.variant ?? "outline",
      binding: {
        ...bindingInput,
        hostBindingId:
          normalizeTrimmedString(bindingInput.hostBindingId) ?? "extension_attachment_action",
      },
    },
  ]);
}

function createExtensionBoundSection(defaultTitle, defaultHostBindingId, input) {
  if (input === false) {
    return undefined;
  }
  const sectionInput =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const bindingInput =
    sectionInput.binding &&
    typeof sectionInput.binding === "object" &&
    !Array.isArray(sectionInput.binding)
      ? sectionInput.binding
      : {};
  return createProviderUiSurfaceSection({
    ...sectionInput,
    title: sectionInput.title ?? defaultTitle,
    binding: {
      ...bindingInput,
      hostBindingId:
        normalizeTrimmedString(bindingInput.hostBindingId) ?? defaultHostBindingId,
    },
  });
}

export function createProviderUiSurfaceExtensionStatusSections(input) {
  const normalizedInput =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return [
    createExtensionBoundSection("Setup", "extension_setup_guidance", normalizedInput.setup),
    createExtensionBoundSection(
      "Current attachment",
      "extension_attachment_status",
      normalizedInput.currentAttachment,
    ),
    createExtensionBoundSection(
      "Current runtime",
      "extension_runtime_status",
      normalizedInput.currentRuntime,
    ),
    createExtensionBoundSection(
      "Saved setup",
      "extension_saved_state",
      normalizedInput.savedSetup,
    ),
    createExtensionBoundSection(
      "Availability issue",
      "extension_issue_status",
      normalizedInput.availabilityIssue,
    ),
  ].filter((value) => Boolean(value));
}

export function createProviderUiSurfaceSpeechSettingsControls(input) {
  const normalizedInput =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const includeScopeControl = normalizedInput.includeScopeControl !== false;
  return createProviderUiSurfaceControls([
    {
      kind: "select",
      label: "Speech route",
      description: "Choose the preferred speech backend for this space.",
      placeholder: "Auto",
      binding: {
        hostBindingId: "speech_route_mode",
      },
      options: [
        {
          label: "Auto",
          value: "auto",
          description: "Use the best available speech path.",
        },
        {
          label: "Speech provider",
          value: "provider",
          description: "Use the shared speech host when it is ready.",
        },
        {
          label: "This device",
          value: "device",
          description: "Keep speech on this device.",
        },
      ],
    },
    {
      kind: "readonly",
      label: "Preference source",
      description: "Shows whether this setting is shared or device-only.",
      binding: {
        hostBindingId: "speech_preference_source",
      },
    },
    {
      kind: "select",
      label: "Provider voice",
      description: "Optional provider voice.",
      placeholder: "Automatic provider voice",
      binding: {
        hostBindingId: "speech_provider_voice",
      },
      options: [],
    },
    {
      kind: "select",
      label: "Device voice",
      description: "Optional device voice.",
      placeholder: "Automatic device voice",
      binding: {
        hostBindingId: "speech_device_voice",
      },
      options: [],
    },
    ...(includeScopeControl
      ? [
          {
            kind: "readonly",
            label: "Scope",
            value: "Shared across host speech surfaces",
          },
        ]
      : []),
  ]);
}

export function createProviderUiSurfaceSpeechDesktopHostActions(input) {
  const normalizedInput =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const includeRefreshTunnel = normalizedInput.includeRefreshTunnel !== false;
  return createProviderUiSurfaceActions([
    {
      label: "Desktop host",
      description:
        "Turn this Mac into a shared speech host for your other Instafy clients, or turn it back off.",
      variant: "primary",
      binding: {
        hostBindingId: "desktop_voice_host_toggle",
      },
    },
    {
      label: "Repair Desktop host",
      description: "Repair the desktop speech runtime.",
      variant: "outline",
      binding: {
        hostBindingId: "desktop_voice_host_repair",
      },
    },
    {
      label: "Restart Desktop host",
      description: "Restart desktop speech services.",
      variant: "outline",
      binding: {
        hostBindingId: "desktop_voice_host_restart",
      },
    },
    {
      label: "Remove downloaded runtime",
      description: "Delete the downloaded speech runtime when Desktop hosting is off.",
      variant: "outline",
      binding: {
        hostBindingId: "desktop_voice_runtime_remove",
      },
    },
    ...(includeRefreshTunnel
      ? [
          {
            label: "Refresh Desktop tunnel",
            description: "Refresh remote access to this Desktop host.",
            variant: "outline",
            binding: {
              hostBindingId: "desktop_speech_tunnel_refresh",
            },
          },
        ]
      : []),
  ]);
}

export function createProviderUiSurfaceSpeechStatusControls(input) {
  const normalizedInput =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const includeFallbackControl = normalizedInput.includeFallbackControl !== false;
  return createProviderUiSurfaceControls([
    {
      kind: "toggle",
      label: "Warmup-aware readiness",
      description: "Use hosted speech only after it is ready.",
      value: true,
      disabled: true,
    },
    ...(includeFallbackControl
      ? [
          {
            kind: "readonly",
            label: "Fallback",
            value: "Device speech remains available when no hosted route is ready",
          },
        ]
      : []),
  ]);
}

export function createProviderUiSurfaceMetadata(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const kind = normalizeTrimmedString(input.kind);
  const policy = createProviderUiSurfacePolicy(input.policy);
  const sandbox = createProviderUiSurfaceSandboxContainer(input.sandbox);
  const elements = createProviderUiSurfaceElements(input.elements) ?? [];

  if (!kind && !policy && !sandbox && elements.length === 0) {
    return undefined;
  }

  return {
    ...(kind ? { kind } : {}),
    ...(policy ? { policy } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(elements.length > 0 ? { elements } : {}),
  };
}
