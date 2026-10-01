import { forwardRef, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ComboBox, ComboBoxStateContext, InputContext, PopoverContext, Text, useContextProps } from "react-aria-components";
import { Clock, NavArrowRight, Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Input, type InputProps } from "../../../components/Input";
import { MobileFocusDialog } from "../../../components/aria/MobileFocusDialog";
import { useBreakpoint } from "../../../hooks/useBreakpoint";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { StudioListBox, StudioListBoxItem } from "../../../components/aria/StudioListBox";
import { BrowserToolsOverlayContext } from "./BrowserToolsPopover";
import { BrowserAddressMenuAnchorContext } from "./BrowserChromeShell";
import { useBrowserAddressHistory, type BrowserAddressHistoryEntry } from "./browserAddressHistory";

type BrowserAddressFieldProps = Pick<InputProps, "value" | "placeholder" | "disabled" | "onBlur"> & {
  testIdPrefix: string;
  errorId?: string;
  invalid?: boolean;
  /** Return false when navigation is rejected so the editor stays open. */
  onNavigate: (address: string) => boolean;
  errorMessage?: string | null;
  onValueChange: (value: string) => void;
  historyUserId?: string | null;
  currentPage?: { url: string; title?: string | null } | null;
};

// Let React Aria own combobox interactions while retaining the app's Input.
const AddressInput = forwardRef<HTMLInputElement, InputProps>(function AddressInput(props, ref) {
  const [inputProps, inputRef] = useContextProps(props, ref, InputContext);
  return <Input {...inputProps} ref={inputRef} />;
});

export const BrowserAddressField = forwardRef<HTMLInputElement, BrowserAddressFieldProps>(function BrowserAddressField({
  historyUserId, currentPage, onValueChange, onNavigate, value, disabled, onBlur, ...props
}, ref) {
  const { entries, clear } = useBrowserAddressHistory(historyUserId, currentPage);
  const desktop = useBreakpoint("sm");
  const [editing, setEditing] = useState(false);
  const originalValue = useRef("");
  const navigateSelection = useRef(false);
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
  const query = String(value ?? "").trim().toLocaleLowerCase();
  const suggestions = useMemo(() => entries.filter(entry =>
    !query || `${entry.title} ${entry.url}`.toLocaleLowerCase().includes(query),
  ).slice(0, 8), [entries, query]);

  useEffect(() => {
    if (!editing) return;
    if (disabled) onValueChange(currentPage?.url ?? originalValue.current);
    if (desktop || disabled) setEditing(false);
  }, [desktop, disabled, editing, currentPage?.url, onValueChange]);

  const navigate = (address: string) => {
    if (!disabled && onNavigate(address)) setEditing(false);
  };
  const cancel = () => {
    onValueChange(currentPage?.url ?? originalValue.current);
    setEditing(false);
  };

  useEffect(() => {
    if (pendingNavigation === null) return;
    setPendingNavigation(null);
    // Navigation can blur the input. Commit the combobox selection first so
    // that blur cannot restore the previous address during selection.
    if (!disabled && onNavigate(pendingNavigation)) setEditing(false);
  }, [pendingNavigation, disabled, onNavigate]);

  const editor = (
    <ComboBox
      aria-label="Address"
      className="min-w-0 w-full"
      allowsCustomValue
      menuTrigger="focus"
      items={suggestions}
      inputValue={String(value ?? "")}
      onInputChange={onValueChange}
      onBlur={desktop ? onBlur : undefined}
      isDisabled={disabled}
      isInvalid={props.invalid}
      onSelectionChange={key => {
        const entry = suggestions.find(item => item.url === key);
        const shouldNavigate = navigateSelection.current;
        navigateSelection.current = false;
        if (!entry || disabled) return;
        onValueChange(entry.url);
        if (shouldNavigate) setPendingNavigation(entry.url);
      }}
    >
      <AddressControls {...props} ref={ref} disabled={disabled} entries={suggestions}
        clear={clear} navigateSelection={navigateSelection} mobile={!desktop}
        onCancel={cancel} onClear={() => onValueChange("")}
        onNavigate={() => navigate(String(value ?? ""))} />
    </ComboBox>
  );
  if (desktop) return editor;
  return <>
    <Button slot={null} variant="outline" size="xs" radius="full"
      className="h-8 max-[540px]:h-10 pointer-coarse:h-11 w-full min-w-0 !justify-start px-3 text-left !text-base font-normal"
      aria-label="Address" aria-haspopup="dialog" aria-expanded={editing}
      data-testid={`${props.testIdPrefix}-address-trigger`} isDisabled={disabled}
      onPress={() => { originalValue.current = String(value ?? ""); setEditing(true); }}>
      <span className="truncate">{value || props.placeholder || "Enter an address"}</span>
    </Button>
    {editing && editor}
  </>;
});

const AddressControls = forwardRef<HTMLInputElement, Pick<BrowserAddressFieldProps,
  "testIdPrefix" | "errorId" | "invalid" | "errorMessage" | "placeholder" | "disabled"> & {
  mobile: boolean;
  onCancel: () => void;
  onClear: () => void;
  onNavigate: () => void;
  entries: BrowserAddressHistoryEntry[];
  clear: () => void;
  navigateSelection: { current: boolean };
}>(function AddressControls({
  testIdPrefix, errorId, invalid, errorMessage, onNavigate, mobile, onCancel, onClear, entries, clear, navigateSelection, ...inputProps
}, ref) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const focusInput = () => formRef.current?.querySelector("input")?.focus();
  const state = useContext(ComboBoxStateContext);
  // The phone dialog replaces the popover. Register the same interaction
  // boundary so combobox blur and screen-reader isolation include its controls.
  const [, dialogRef] = useContextProps({}, null, PopoverContext);
  const registerOverlay = useContext(BrowserToolsOverlayContext);
  const menuAnchor = useContext(BrowserAddressMenuAnchorContext);
  const open = Boolean(state?.isOpen && entries.length && !inputProps.disabled);
  const overlayOpen = Boolean(state && (mobile || open));
  useLayoutEffect(() => overlayOpen ? registerOverlay?.() : undefined, [overlayOpen, registerOverlay]);

  const suggestions = <>
    <StudioListBox<BrowserAddressHistoryEntry> aria-label="Recent sites"
      onPointerDownCapture={() => { navigateSelection.current = true; }}
      onClickCapture={() => { navigateSelection.current = true; }}>
      {entry => <StudioListBoxItem id={entry.url} textValue={entry.url}
        className="min-h-11 @[28rem]/address-suggestions:pointer-fine:min-h-8 !justify-start gap-2 overflow-hidden">
        <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
        <div className="flex min-w-0 flex-1 flex-col @[28rem]/address-suggestions:flex-row @[28rem]/address-suggestions:items-baseline @[28rem]/address-suggestions:gap-2">
          <Text slot="label" className="min-w-0 truncate leading-4 @[28rem]/address-suggestions:max-w-[60%] @[28rem]/address-suggestions:shrink-0">{entry.title || new URL(entry.url).hostname}</Text>
          <Text slot="description" title={entry.url} className="min-w-0 truncate text-xs leading-4 text-slate-500 dark:text-slate-400">{entry.url.replace(/^https?:\/\//, "")}</Text>
        </div>
      </StudioListBoxItem>}
    </StudioListBox>
    <div className="flex justify-end">
      <Button slot={null} size="xs" variant="ghost" className="px-2.5 text-slate-500 dark:text-slate-400"
        onPress={() => { navigateSelection.current = false; clear(); state?.close(); if (mobile) focusInput(); }}>
        Clear recent sites
      </Button>
    </div>
  </>;
  const menu = mobile ? <div className="@container/address-suggestions p-2">{suggestions}</div> : <StudioPopover isNonModal isOpen={open} placement="bottom start" offset={2}
    triggerRef={menuAnchor?.ref}
    crossOffset={menuAnchor ? 8 : 0}
    containerPadding={8}
    style={menuAnchor && menuAnchor.width > 0 ? { width: Math.max(0, menuAnchor.width - 16) } : undefined}
    className="@container/address-suggestions z-[90] w-[max(var(--trigger-width),18rem)] max-w-[calc(100vw-1rem)] p-1"
    data-browser-session-safe-zone="true">
    {suggestions}
  </StudioPopover>;

  // React Aria builds the option collection before mounting its state provider.
  // That pass needs the options, not a second native form or forwarded input ref.
  if (!state) return menu;

  const form = (
    <form ref={formRef} className="relative w-full min-w-0" data-testid={`${testIdPrefix}-address-form`}
      onSubmit={event => { event.preventDefault(); if (!mobile) state.close(); onNavigate(); }}>
      <label className="sr-only" htmlFor={id}>Address</label>
      <AddressInput
        {...inputProps}
        ref={ref}
        id={id}
        aria-label="Address"
        aria-describedby={mobile && errorMessage ? `${id}-error` : errorId}
        aria-invalid={invalid || undefined}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        type="text"
        inputMode="url"
        enterKeyHint="go"
        autoFocus={mobile}
        onFocus={mobile ? event => event.currentTarget.select() : undefined}
        size="xs"
        radius="full"
        className={`h-8 min-w-0 pl-3 pr-9 aria-invalid:border-rose-400 aria-invalid:focus-visible:ring-rose-500/20 max-[540px]:h-10 max-[540px]:pr-11 pointer-coarse:h-11 pointer-coarse:pr-12 ${mobile ? "!h-11 !pr-24" : ""}`}
        data-testid={`${testIdPrefix}-address`}
        onKeyDownCapture={event => {
          navigateSelection.current = event.key === "Enter" && !event.nativeEvent.isComposing;
          if (event.key === "Enter" && !event.nativeEvent.isComposing &&
              (!state?.isOpen || state.selectionManager.focusedKey == null)) {
            // A custom address must still submit when matching suggestions are
            // open. React Aria otherwise consumes Enter to commit the text.
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <span className="absolute inset-y-0 right-0 flex items-center">
        {mobile && state.inputValue && <IconButton slot={null} aria-label="Clear address" variant="ghost" radius="full"
          className="h-11 w-11" preventFocusOnPress onPress={() => { onClear(); focusInput(); state.open(); }}>
          <Xmark aria-hidden="true" className="h-4 w-4" />
        </IconButton>}
        <IconButton
          slot={null}
          aria-label="Go"
          title="Go"
          data-testid={`${testIdPrefix}-go`}
          type="submit"
          size="xs"
          radius="full"
          variant="ghost"
          className={mobile ? "!h-11 !w-11" : "max-[540px]:h-10 max-[540px]:w-10"}
          isDisabled={inputProps.disabled}
        >
          <NavArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </IconButton>
      </span>
      {!mobile && menu}
    </form>
  );
  return mobile ? <MobileFocusDialog isOpen onOpenChange={open => { if (!open) onCancel(); }}
    dialogAriaLabel="Enter an address" dismissLabel="Back" header={form} dialogRef={dialogRef}
    data-testid={`${testIdPrefix}-address-editor`}>
    {errorMessage && <p id={`${id}-error`} role="alert" className="px-4 py-2 text-sm text-rose-600 dark:text-rose-400">{errorMessage}</p>}
    {open && menu}
  </MobileFocusDialog> : form;
});
