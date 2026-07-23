import { Card } from "../../../components/Card";
import { FactGrid } from "../../../components/FactGrid";
import { Text } from "../../../components/Text";
import {
  resolveProviderHostSurfacePolicy,
  type ProviderHostSurfaceEntry,
} from "../../../providers/providerHostSurfaces";
import {
  ProviderHostSurfaceActions,
  type SurfaceAction,
  type SurfaceActionBinding,
  type SurfaceHostActionBinding,
} from "./ProviderHostSurfaceActions";
import {
  ProviderHostSurfaceControls,
  type SurfaceControl,
  type SurfaceControlBinding,
  type SurfaceHostBinding,
  type SurfaceControlOption,
} from "./ProviderHostSurfaceControls";

type ProviderHostSurfaceCardProps = {
  entry: ProviderHostSurfaceEntry;
  hostActionBindings?: Record<string, SurfaceHostActionBinding>;
  hostControlBindings?: Record<string, SurfaceHostBinding>;
  hostSectionBindings?: Record<string, SurfaceHostSectionBinding>;
  presentation?: "default" | "embedded";
};

function formatCapabilitySummary(capabilityIds: string[] | undefined) {
  if (!Array.isArray(capabilityIds) || capabilityIds.length === 0) {
    return null;
  }
  return capabilityIds.join(" · ");
}

type SurfaceFact = {
  label: string;
  value: string;
};

type SurfaceSection = {
  title: string;
  description?: string;
  facts: SurfaceFact[];
  items: string[];
  hostBindingId?: string;
};

function readMetadataElements(value: unknown) {
  const metadata = normalizeSurfaceMetadataValue(value);
  if (!metadata || !Array.isArray((metadata as { elements?: unknown[] }).elements)) {
    return [];
  }
  return (metadata as { elements?: unknown[] }).elements ?? [];
}

function readElementEntries(value: unknown, elementId: string) {
  return readMetadataElements(value).filter((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    return (entry as { element?: unknown }).element === elementId;
  });
}

function normalizeActions(values: unknown): SurfaceAction[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const results: SurfaceAction[] = [];
  for (const action of values ?? []) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      continue;
    }
    const label =
      typeof (action as { label?: unknown }).label === "string"
        ? (action as { label?: string }).label?.trim() ?? ""
        : "";
    if (!label) {
      continue;
    }
    const description =
      typeof (action as { description?: unknown }).description === "string"
        ? (action as { description?: string }).description?.trim() ?? ""
        : "";
    const variantValue = (action as { variant?: unknown }).variant;
    const variant =
      variantValue === "primary" || variantValue === "outline" || variantValue === "ghost"
        ? variantValue
        : "outline";
    const bindingValue =
      (action as { binding?: unknown }).binding &&
      typeof (action as { binding?: unknown }).binding === "object" &&
      !Array.isArray((action as { binding?: unknown }).binding)
        ? ((action as { binding?: Record<string, unknown> }).binding ?? {})
        : null;
    const binding: SurfaceActionBinding | undefined = bindingValue
      ? {
          hostBindingId:
            typeof bindingValue.hostBindingId === "string"
              ? bindingValue.hostBindingId.trim() || undefined
              : undefined,
        }
      : undefined;
    results.push({
      label,
      description: description || undefined,
      variant,
      binding,
    });
  }
  return results;
}

function readActions(value: unknown): SurfaceAction[] {
  return readElementEntries(value, "actions").flatMap((entry) =>
    normalizeActions((entry as { actions?: unknown[] }).actions),
  );
}

export type SurfaceHostSectionBinding = {
  title?: string;
  description?: string;
  facts?: SurfaceFact[];
  items?: string[];
  hidden?: boolean;
};

function normalizeSurfaceMetadataValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readHighlights(value: unknown) {
  return readElementEntries(value, "highlights").flatMap((entry) =>
    Array.isArray((entry as { items?: unknown[] }).items)
      ? ((entry as { items?: unknown[] }).items ?? [])
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
  );
}

function readFacts(value: unknown): SurfaceFact[] {
  return readElementEntries(value, "facts").flatMap((entry) =>
    normalizeFacts((entry as { facts?: unknown[] }).facts),
  );
}

function normalizeFacts(values: unknown): SurfaceFact[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return (values ?? [])
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const label = typeof (item as { label?: unknown }).label === "string" ? (item as { label?: string }).label?.trim() ?? "" : "";
      const value = typeof (item as { value?: unknown }).value === "string" ? (item as { value?: string }).value?.trim() ?? "" : "";
      if (!label || !value) {
        return null;
      }
      return { label, value };
    })
    .filter((fact): fact is SurfaceFact => fact !== null);
}

function normalizeSection(section: unknown): SurfaceSection | null {
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return null;
  }
  const title = typeof (section as { title?: unknown }).title === "string"
    ? (section as { title?: string }).title?.trim() ?? ""
    : "";
  const description = typeof (section as { description?: unknown }).description === "string"
    ? (section as { description?: string }).description?.trim() ?? ""
    : "";
  const bindingValue =
    (section as { binding?: unknown }).binding &&
    typeof (section as { binding?: unknown }).binding === "object" &&
    !Array.isArray((section as { binding?: unknown }).binding)
      ? ((section as { binding?: Record<string, unknown> }).binding ?? {})
      : null;
  const hostBindingId = bindingValue && typeof bindingValue.hostBindingId === "string"
    ? bindingValue.hostBindingId.trim() || undefined
    : undefined;
  if (!title && !hostBindingId) {
    return null;
  }
  const facts = normalizeFacts((section as { facts?: unknown[] }).facts);
  const items = Array.isArray((section as { items?: unknown[] }).items)
    ? ((section as { items?: unknown[] }).items ?? [])
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  if (facts.length === 0 && items.length === 0 && !hostBindingId) {
    return null;
  }
  return {
    title,
    description: description || undefined,
    facts,
    items,
    hostBindingId,
  };
}

function normalizeSections(values: unknown): SurfaceSection[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const results: SurfaceSection[] = [];
  for (const section of values ?? []) {
    const normalized = normalizeSection(section);
    if (normalized) {
      results.push(normalized);
    }
  }
  return results;
}

function readSections(value: unknown): SurfaceSection[] {
  return normalizeSections(readElementEntries(value, "section"));
}

function readActionHint(value: unknown) {
  return readElementEntries(value, "hint")
    .map((entry) =>
      typeof (entry as { text?: unknown }).text === "string"
        ? (entry as { text?: string }).text?.trim() ?? ""
        : "",
    )
    .filter(Boolean)
    .join(" ");
}

function normalizeControls(values: unknown): SurfaceControl[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const results: SurfaceControl[] = [];
  for (const control of values ?? []) {
    if (!control || typeof control !== "object" || Array.isArray(control)) {
      continue;
    }
    const kind = (control as { kind?: unknown }).kind;
    if (kind !== "readonly" && kind !== "toggle" && kind !== "select") {
      continue;
    }
    const label = typeof (control as { label?: unknown }).label === "string"
      ? (control as { label?: string }).label?.trim() ?? ""
      : "";
    if (!label) {
      continue;
    }
    const description = typeof (control as { description?: unknown }).description === "string"
      ? (control as { description?: string }).description?.trim() ?? ""
      : "";
    const placeholder = typeof (control as { placeholder?: unknown }).placeholder === "string"
      ? (control as { placeholder?: string }).placeholder?.trim() ?? ""
      : "";
    const controlValue =
      typeof (control as { value?: unknown }).value === "string" ||
      typeof (control as { value?: unknown }).value === "boolean"
        ? (control as { value?: string | boolean }).value
        : undefined;
    const options: SurfaceControlOption[] = [];
    if (Array.isArray((control as { options?: unknown[] }).options)) {
      for (const option of (control as { options?: unknown[] }).options ?? []) {
        if (!option || typeof option !== "object" || Array.isArray(option)) {
          continue;
        }
        const optionLabel = typeof (option as { label?: unknown }).label === "string"
          ? (option as { label?: string }).label?.trim() ?? ""
          : "";
        const optionValue = typeof (option as { value?: unknown }).value === "string"
          ? (option as { value?: string }).value?.trim() ?? ""
          : "";
        if (!optionLabel || !optionValue) {
          continue;
        }
        const optionDescription = typeof (option as { description?: unknown }).description === "string"
          ? (option as { description?: string }).description?.trim() ?? ""
          : "";
        options.push({
          label: optionLabel,
          value: optionValue,
          description: optionDescription || undefined,
        });
      }
    }
    const bindingValue =
      (control as { binding?: unknown }).binding &&
      typeof (control as { binding?: unknown }).binding === "object" &&
      !Array.isArray((control as { binding?: unknown }).binding)
        ? ((control as { binding?: Record<string, unknown> }).binding ?? {})
        : null;
    const binding: SurfaceControlBinding | undefined = bindingValue
      ? {
          readResourceAlias: typeof bindingValue.readResourceAlias === "string"
            ? bindingValue.readResourceAlias.trim() || undefined
            : undefined,
          hostBindingId: typeof bindingValue.hostBindingId === "string"
            ? bindingValue.hostBindingId.trim() || undefined
            : undefined,
          readResourceUri: typeof bindingValue.readResourceUri === "string"
            ? bindingValue.readResourceUri.trim() || undefined
            : undefined,
          valuePath: typeof bindingValue.valuePath === "string"
            ? bindingValue.valuePath.trim() || undefined
            : undefined,
          writeToolAlias: typeof bindingValue.writeToolAlias === "string"
            ? bindingValue.writeToolAlias.trim() || undefined
            : undefined,
          writeToolName: typeof bindingValue.writeToolName === "string"
            ? bindingValue.writeToolName.trim() || undefined
            : undefined,
          writeValueArgument: typeof bindingValue.writeValueArgument === "string"
            ? bindingValue.writeValueArgument.trim() || undefined
            : undefined,
          writeArguments:
            bindingValue.writeArguments &&
            typeof bindingValue.writeArguments === "object" &&
            !Array.isArray(bindingValue.writeArguments)
              ? (bindingValue.writeArguments as Record<string, unknown>)
              : undefined,
        }
      : undefined;
    results.push({
      kind,
      label,
      description: description || undefined,
      value: controlValue,
      placeholder: placeholder || undefined,
      disabled: (control as { disabled?: unknown }).disabled === true,
      options,
      binding,
    });
  }
  return results;
}

function readControls(value: unknown): SurfaceControl[] {
  return readElementEntries(value, "controls").flatMap((entry) =>
    normalizeControls((entry as { controls?: unknown[] }).controls),
  );
}

export function ProviderHostSurfaceCard({
  entry,
  hostActionBindings,
  hostControlBindings,
  hostSectionBindings,
  presentation = "default",
}: ProviderHostSurfaceCardProps) {
  const surfacePolicy = resolveProviderHostSurfacePolicy(entry);
  const resolvedHostActionBindings = surfacePolicy.allowHostBindings ? hostActionBindings : undefined;
  const resolvedHostControlBindings = surfacePolicy.allowHostBindings ? hostControlBindings : undefined;
  const resolvedHostSectionBindings = surfacePolicy.allowHostBindings ? hostSectionBindings : undefined;
  const capabilitySummary = formatCapabilitySummary(
    entry.surface.capabilityIds ?? entry.provider.capabilityIds,
  );
  const highlights = readHighlights(entry.surface.metadata);
  const facts = readFacts(entry.surface.metadata);
  const sections = readSections(entry.surface.metadata);
  const actions = readActions(entry.surface.metadata);
  const controls = readControls(entry.surface.metadata);
  const actionHint = readActionHint(entry.surface.metadata);
  const hasStructuredContent =
    highlights.length > 0 ||
    facts.length > 0 ||
    sections.length > 0 ||
    controls.length > 0 ||
    actions.length > 0 ||
    actionHint.length > 0;
  const providerFacts: SurfaceFact[] = [
    {
      label: "Provider",
      value: entry.provider.title,
    },
    ...(entry.provider.providerType?.trim()
      ? [
          {
            label: "Type",
            value: entry.provider.providerType.trim(),
          },
        ]
      : []),
    ...(capabilitySummary
      ? [
          {
            label: "Capabilities",
            value: capabilitySummary,
          },
        ]
      : []),
  ];
  const renderedFacts =
    presentation === "embedded"
      ? []
      : facts.length > 0
        ? facts
        : hasStructuredContent
          ? []
          : providerFacts;

  const content = (
    <div className="flex flex-col gap-3">
      {presentation === "default" ? (
        <div className="space-y-1">
          <Text variant="bodyStrong" tone="secondary">
            {entry.surface.title?.trim() || entry.provider.title}
          </Text>
          <Text variant="caption" tone="muted">
            {entry.surface.description?.trim() ||
              entry.provider.description?.trim() ||
              `${entry.provider.title} declares this host surface through the shared provider manifest.`}
          </Text>
        </div>
      ) : null}

      {presentation === "default" && highlights.length > 0 ? (
        <Text variant="caption" tone="muted">
          {highlights.join(" · ")}
        </Text>
      ) : null}

      {renderedFacts.length > 0 ? <FactGrid items={renderedFacts} /> : null}

      {sections.length > 0 ? (
        <div className="grid gap-3">
          {sections.map((section) => {
            const hostSection = section.hostBindingId
              ? resolvedHostSectionBindings?.[section.hostBindingId]
              : undefined;
            if (hostSection?.hidden) {
              return null;
            }
            const effectiveTitle = hostSection?.title ?? section.title;
            const effectiveDescription = hostSection?.description ?? section.description;
            const effectiveFacts = hostSection?.facts ?? section.facts;
            const effectiveItems = hostSection?.items ?? section.items;
            if (!effectiveTitle && effectiveFacts.length === 0 && effectiveItems.length === 0 && !effectiveDescription) {
              return null;
            }
            return (
              <div key={effectiveTitle || section.hostBindingId || section.title} className="space-y-2">
                {effectiveTitle ? (
                  <Text variant="caption" tone="muted" className="block">
                    {effectiveTitle}
                  </Text>
                ) : null}
                {effectiveDescription ? (
                  <Text variant="caption" tone="muted">
                    {effectiveDescription}
                  </Text>
                ) : null}
                {effectiveFacts.length > 0 ? (
                  <FactGrid items={effectiveFacts} />
                ) : null}
                {effectiveItems.length > 0 ? (
                  <ul className="space-y-1">
                    {effectiveItems.map((item) => (
                      <Text
                        key={`${effectiveTitle || section.hostBindingId}:${item}`}
                        as="li"
                        variant="body"
                        tone="secondary"
                      >
                        {item}
                      </Text>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {controls.length > 0 ? (
        <ProviderHostSurfaceControls
          provider={entry.provider}
          controls={controls}
          hostBindings={resolvedHostControlBindings}
        />
      ) : null}

      {actions.length > 0 ? (
        <ProviderHostSurfaceActions
          actions={actions}
          hostBindings={resolvedHostActionBindings}
        />
      ) : null}

      {actionHint ? (
        <Text variant="caption" tone="muted">
          {actionHint}
        </Text>
      ) : null}
    </div>
  );

  if (presentation === "embedded") {
    return content;
  }

  return (
    <Card tone="default" radius="2xl" shadow="none" padding="sm" className="py-3">
      {content}
    </Card>
  );
}
