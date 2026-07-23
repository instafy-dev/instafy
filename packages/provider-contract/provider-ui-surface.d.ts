import type {
  ProviderUiSurfaceSandboxContainer,
} from "./provider-sandbox.js";

export type ProviderHostSurfaceId =
  | "extension_tile"
  | "settings_card"
  | "status_card"
  | "setup_wizard"
  | "detail_view"
  | "result_renderer"
  | (string & {});

export type ProviderUiSurfaceFact = {
  label: string;
  value: string;
};

export type ProviderUiSurfaceSectionBinding = {
  hostBindingId?: string;
};

export type ProviderUiSurfaceSection = {
  title: string;
  description?: string;
  facts?: ProviderUiSurfaceFact[];
  items?: string[];
  binding?: ProviderUiSurfaceSectionBinding;
};

export type ProviderUiSurfaceControlOption = {
  label: string;
  value: string;
  description?: string;
};

export type ProviderUiSurfaceActionBinding = {
  hostBindingId?: string;
};

export type ProviderUiSurfaceAction = {
  label: string;
  description?: string;
  variant?: "primary" | "outline" | "ghost";
  binding?: ProviderUiSurfaceActionBinding;
};

export type ProviderUiSurfaceControlBinding = {
  hostBindingId?: string;
  readResourceAlias?: string;
  readResourceUri?: string;
  valuePath?: string;
  writeToolAlias?: string;
  writeToolName?: string;
  writeValueArgument?: string;
  writeArguments?: Record<string, unknown>;
};

export type ProviderUiSurfaceControl = {
  kind: "readonly" | "toggle" | "select";
  label: string;
  description?: string;
  value?: string | boolean;
  placeholder?: string;
  disabled?: boolean;
  options?: ProviderUiSurfaceControlOption[];
  binding?: ProviderUiSurfaceControlBinding;
};

export type ProviderUiSurfaceTrustLevel =
  | "first_party"
  | "local_trusted"
  | "untrusted";

export type ProviderUiSurfaceRenderMode =
  | "host_declarative"
  | "sandboxed";

export type ProviderUiSurfacePolicy = {
  trustLevel?: ProviderUiSurfaceTrustLevel;
  renderMode?: ProviderUiSurfaceRenderMode;
};

export type ProviderUiSurfaceElement =
  | {
      element: "highlights";
      items: string[];
    }
  | {
      element: "facts";
      facts: ProviderUiSurfaceFact[];
    }
  | ({
      element: "section";
    } & ProviderUiSurfaceSection)
  | {
      element: "controls";
      controls: ProviderUiSurfaceControl[];
    }
  | {
      element: "actions";
      actions: ProviderUiSurfaceAction[];
    }
  | {
      element: "hint";
      text: string;
    };

export type ProviderUiSurfaceHighlightsElement = Extract<
  ProviderUiSurfaceElement,
  { element: "highlights" }
>;
export type ProviderUiSurfaceFactsElement = Extract<
  ProviderUiSurfaceElement,
  { element: "facts" }
>;
export type ProviderUiSurfaceSectionElement = Extract<
  ProviderUiSurfaceElement,
  { element: "section" }
>;
export type ProviderUiSurfaceControlsElement = Extract<
  ProviderUiSurfaceElement,
  { element: "controls" }
>;
export type ProviderUiSurfaceActionsElement = Extract<
  ProviderUiSurfaceElement,
  { element: "actions" }
>;
export type ProviderUiSurfaceHintElement = Extract<
  ProviderUiSurfaceElement,
  { element: "hint" }
>;

export type ProviderUiSurfaceElementInput =
  | ProviderUiSurfaceElement
  | ProviderUiSurfaceElementInput[]
  | null
  | undefined;

export type ProviderUiSurfaceExtensionAttachmentActionInput = Partial<ProviderUiSurfaceAction>;
export type ProviderUiSurfaceOptionalSectionInput =
  | Partial<ProviderUiSurfaceSection>
  | false
  | null
  | undefined;
export type ProviderUiSurfaceExtensionStatusSectionsInput = {
  setup?: ProviderUiSurfaceOptionalSectionInput;
  currentAttachment?: ProviderUiSurfaceOptionalSectionInput;
  currentRuntime?: ProviderUiSurfaceOptionalSectionInput;
  savedSetup?: ProviderUiSurfaceOptionalSectionInput;
  availabilityIssue?: ProviderUiSurfaceOptionalSectionInput;
};
export type ProviderUiSurfaceSpeechSettingsControlsInput = {
  includeScopeControl?: boolean;
};
export type ProviderUiSurfaceSpeechDesktopHostActionsInput = {
  includeRefreshTunnel?: boolean;
};
export type ProviderUiSurfaceSpeechStatusControlsInput = {
  includeFallbackControl?: boolean;
};

export type ProviderUiSurfaceMetadata = {
  kind?: string;
  policy?: ProviderUiSurfacePolicy;
  sandbox?: ProviderUiSurfaceSandboxContainer;
  elements?: ProviderUiSurfaceElement[];
} & Record<string, unknown>;

export type ProviderHostSurfaceFact = ProviderUiSurfaceFact;
export type ProviderHostSurfaceSectionBinding = ProviderUiSurfaceSectionBinding;
export type ProviderHostSurfaceSection = ProviderUiSurfaceSection;
export type ProviderHostSurfaceControlOption = ProviderUiSurfaceControlOption;
export type ProviderHostSurfaceActionBinding = ProviderUiSurfaceActionBinding;
export type ProviderHostSurfaceAction = ProviderUiSurfaceAction;
export type ProviderHostSurfaceControlBinding = ProviderUiSurfaceControlBinding;
export type ProviderHostSurfaceControl = ProviderUiSurfaceControl;
export type ProviderHostSurfaceMetadata = ProviderUiSurfaceMetadata;

export function createProviderUiSurfacePolicy(
  input: Partial<ProviderUiSurfacePolicy> | null | undefined,
): ProviderUiSurfacePolicy | undefined;
export function createProviderUiSurfaceHighlights(
  items: string[] | null | undefined,
): ProviderUiSurfaceHighlightsElement | undefined;
export function createProviderUiSurfaceFacts(
  facts: Array<Partial<ProviderUiSurfaceFact> | null | undefined> | null | undefined,
): ProviderUiSurfaceFactsElement | undefined;
export function createProviderUiSurfaceSection(
  input: Partial<ProviderUiSurfaceSection> | null | undefined,
): ProviderUiSurfaceSectionElement | undefined;
export function createProviderUiSurfaceControls(
  controls: Array<Partial<ProviderUiSurfaceControl> | null | undefined> | null | undefined,
): ProviderUiSurfaceControlsElement | undefined;
export function createProviderUiSurfaceActions(
  actions: Array<Partial<ProviderUiSurfaceAction> | null | undefined> | null | undefined,
): ProviderUiSurfaceActionsElement | undefined;
export function createProviderUiSurfaceHint(
  text: string | null | undefined,
): ProviderUiSurfaceHintElement | undefined;
export function createProviderUiSurfaceElements(
  elements: ProviderUiSurfaceElementInput[] | null | undefined,
): ProviderUiSurfaceElement[] | undefined;
export function createProviderUiSurfaceExtensionAttachmentAction(
  input?: ProviderUiSurfaceExtensionAttachmentActionInput | null | undefined,
): ProviderUiSurfaceActionsElement | undefined;
export function createProviderUiSurfaceExtensionStatusSections(
  input?: ProviderUiSurfaceExtensionStatusSectionsInput | null | undefined,
): ProviderUiSurfaceSectionElement[];
export function createProviderUiSurfaceSpeechSettingsControls(
  input?: ProviderUiSurfaceSpeechSettingsControlsInput | null | undefined,
): ProviderUiSurfaceControlsElement | undefined;
export function createProviderUiSurfaceSpeechDesktopHostActions(
  input?: ProviderUiSurfaceSpeechDesktopHostActionsInput | null | undefined,
): ProviderUiSurfaceActionsElement | undefined;
export function createProviderUiSurfaceSpeechStatusControls(
  input?: ProviderUiSurfaceSpeechStatusControlsInput | null | undefined,
): ProviderUiSurfaceControlsElement | undefined;
export function createProviderUiSurfaceMetadata(
  input: Partial<ProviderUiSurfaceMetadata> | null | undefined,
): ProviderUiSurfaceMetadata | undefined;
