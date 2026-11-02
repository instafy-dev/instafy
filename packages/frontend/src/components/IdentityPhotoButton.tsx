import { useRef, type ReactNode, type Ref } from "react";
import { EditPencil } from "iconoir-react";
import { Button } from "./Button";

/**
 * The photo target takes the shape of the picture it wraps, so its hover fill
 * and focus ring never show past the picture's corners: a person's circle, a
 * bot's AI tile (docs/Brand.md, "One rule for faces"), or a team's or space's
 * rounded square.
 */
export type IdentityPhotoShape = "circle" | "aiTile" | "square";

const PHOTO_BUTTON_RADIUS = {
  circle: "full",
  aiTile: "aiTile",
  square: "xl",
} as const satisfies Record<IdentityPhotoShape, string>;

/** One accessible photo target shared by people, bots, teams and spaces. */
export function IdentityPhotoButton({ children, label, disabled, shape = "circle", onSelect,
  accept = "image/*", testId, inputTestId, buttonRef }: {
  children: ReactNode;
  label: string;
  disabled?: boolean;
  shape?: IdentityPhotoShape;
  onSelect: (file: File) => void;
  accept?: string;
  testId?: string;
  inputTestId?: string;
  /** The photo target itself, for a form that moves focus to it. */
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" accept={accept} aria-label={label} disabled={disabled}
      className="hidden" data-testid={inputTestId} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) onSelect(file);
      }} />
    <Button ref={buttonRef} aria-label={label} title={label} onPress={() => input.current?.click()}
      isDisabled={disabled} variant="ghost" size="icon" radius={PHOTO_BUTTON_RADIUS[shape]}
      className="group relative h-16 w-16 shrink-0" data-testid={testId}>
      {children}
      <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm group-hover:bg-slate-50 dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)] dark:text-slate-100 dark:group-hover:bg-[var(--color-studio-dark-control-hover)]">
        <EditPencil className="h-3.5 w-3.5" />
      </span>
    </Button>
  </>;
}
