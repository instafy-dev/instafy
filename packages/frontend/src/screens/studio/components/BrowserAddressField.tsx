import { forwardRef, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEventHandler } from "react";
import { ComboBox, ComboBoxStateContext, InputContext, Text, useContextProps } from "react-aria-components";
import { Clock, NavArrowRight } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Input, type InputProps } from "../../../components/Input";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { StudioListBox, StudioListBoxItem } from "../../../components/aria/StudioListBox";
import { BrowserToolsOverlayContext } from "./BrowserToolsPopover";
import { useBrowserAddressHistory, type BrowserAddressHistoryEntry } from "./browserAddressHistory";

type BrowserAddressFieldProps = Pick<InputProps, "value" | "placeholder" | "disabled" | "onBlur"> & {
  testIdPrefix: string;
  errorId?: string;
  invalid?: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onValueChange: (value: string) => void;
  onNavigateSuggestion?: (url: string) => void;
  historyUserId?: string | null;
  currentPage?: { url: string; title?: string | null } | null;
};

// Let React Aria own combobox interactions while retaining the app's Input.
const AddressInput = forwardRef<HTMLInputElement, InputProps>(function AddressInput(props, ref) {
  const [inputProps, inputRef] = useContextProps(props, ref, InputContext);
  return <Input {...inputProps} ref={inputRef} />;
});

export const BrowserAddressField = forwardRef<HTMLInputElement, BrowserAddressFieldProps>(function BrowserAddressField({
  historyUserId, currentPage, onValueChange, onNavigateSuggestion, value, disabled, onBlur, ...props
}, ref) {
  const { entries, clear } = useBrowserAddressHistory(historyUserId, currentPage);
  const navigateSelection = useRef(false);
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
  const query = String(value ?? "").trim().toLocaleLowerCase();
  const suggestions = useMemo(() => entries.filter(entry =>
    !query || `${entry.title} ${entry.url}`.toLocaleLowerCase().includes(query),
  ).slice(0, 8), [entries, query]);

  useEffect(() => {
    if (pendingNavigation === null) return;
    setPendingNavigation(null);
    // Navigation can blur the input. Commit the combobox selection first so
    // that blur cannot restore the previous address during selection.
    if (!disabled) onNavigateSuggestion?.(pendingNavigation);
  }, [pendingNavigation, disabled, onNavigateSuggestion]);

  return (
    <ComboBox
      aria-label="Address"
      className="min-w-0 w-full"
      allowsCustomValue
      menuTrigger="focus"
      items={suggestions}
      inputValue={String(value ?? "")}
      onInputChange={onValueChange}
      onBlur={onBlur}
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
        clear={clear} navigateSelection={navigateSelection} />
    </ComboBox>
  );
});

const AddressControls = forwardRef<HTMLInputElement, Pick<BrowserAddressFieldProps,
  "testIdPrefix" | "errorId" | "invalid" | "onSubmit" | "placeholder" | "disabled"> & {
  entries: BrowserAddressHistoryEntry[];
  clear: () => void;
  navigateSelection: { current: boolean };
}>(function AddressControls({
  testIdPrefix, errorId, invalid, onSubmit, entries, clear, navigateSelection, ...inputProps
}, ref) {
  const id = useId();
  const state = useContext(ComboBoxStateContext);
  const registerOverlay = useContext(BrowserToolsOverlayContext);
  const open = Boolean(state?.isOpen && entries.length && !inputProps.disabled);
  useLayoutEffect(() => open ? registerOverlay?.() : undefined, [open, registerOverlay]);

  const menu = <StudioPopover isNonModal isOpen={open} placement="bottom start" offset={2}
    className="@container/address-suggestions z-[90] w-[max(var(--trigger-width),18rem)] max-w-[calc(100vw-1.5rem)] p-1"
    data-browser-session-safe-zone="true">
    <StudioListBox<BrowserAddressHistoryEntry> aria-label="Recent sites"
      onPointerDownCapture={() => { navigateSelection.current = true; }}
      onClickCapture={() => { navigateSelection.current = true; }}>
      {entry => <StudioListBoxItem id={entry.url} textValue={entry.url}
        className="min-h-11 !justify-start gap-3 overflow-hidden">
        <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
        <div className="flex min-w-0 flex-1 flex-col @[28rem]/address-suggestions:flex-row @[28rem]/address-suggestions:items-baseline @[28rem]/address-suggestions:gap-2">
          <Text slot="label" className="min-w-0 truncate leading-4 @[28rem]/address-suggestions:max-w-[60%] @[28rem]/address-suggestions:shrink-0">{entry.title || new URL(entry.url).hostname}</Text>
          <Text slot="description" title={entry.url} className="min-w-0 truncate text-xs leading-4 text-slate-500 dark:text-slate-400">{entry.url.replace(/^https?:\/\//, "")}</Text>
        </div>
      </StudioListBoxItem>}
    </StudioListBox>
    <Button slot={null} size="xs" variant="ghost" className="mt-0.5 w-full justify-end text-slate-500 dark:text-slate-400"
      onPress={() => { navigateSelection.current = false; clear(); state?.close(); }}>
      Clear recent sites
    </Button>
  </StudioPopover>;

  // React Aria builds the option collection before mounting its state provider.
  // That pass needs the options, not a second native form or forwarded input ref.
  if (!state) return menu;

  return (
    <form className="relative w-full min-w-0" data-testid={`${testIdPrefix}-address-form`}
      onSubmit={event => { state?.close(); onSubmit(event); }}>
      <label className="sr-only" htmlFor={id}>Address</label>
      <AddressInput
        {...inputProps}
        ref={ref}
        id={id}
        aria-label="Address"
        aria-describedby={errorId}
        aria-invalid={invalid || undefined}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        type="text"
        size="xs"
        radius="full"
        className="h-8 min-w-0 pl-3 pr-9 aria-invalid:border-rose-400 aria-invalid:focus-visible:ring-rose-500/20 max-[540px]:h-10 max-[540px]:pr-11 pointer-coarse:h-11 pointer-coarse:pr-12"
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
        <IconButton
          slot={null}
          aria-label="Go"
          title="Go"
          data-testid={`${testIdPrefix}-go`}
          type="submit"
          size="xs"
          radius="full"
          variant="ghost"
          className="max-[540px]:h-10 max-[540px]:w-10"
          isDisabled={inputProps.disabled}
        >
          <NavArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </IconButton>
      </span>
      {menu}
    </form>
  );
});
