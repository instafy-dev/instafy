import type { HTMLAttributes, ReactNode } from "react";
import { Xmark } from "iconoir-react";
import { IconButton } from "../Button";
import { Text } from "../Text";
import { useStudioDialogGutterClass } from "./StudioDialogSpacing";

type StudioDialogHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  onClose?: (() => void) | null;
  closeLabel?: string;
  closeButtonDisabled?: boolean;
  className?: string;
  titleClassName?: string;
  descriptionClassName?: string;
};

export function StudioDialogHeader({
  title,
  description,
  leading,
  trailing,
  onClose = null,
  closeLabel = "Close dialog",
  closeButtonDisabled = false,
  className,
  titleClassName,
  descriptionClassName,
}: StudioDialogHeaderProps) {
  const gutterClass = useStudioDialogGutterClass();
  const leftClassName = leading ? "flex min-w-0 items-start gap-2" : "min-w-0";

  return (
    <div
      className={[
        "shrink-0 border-b border-slate-200/70 py-4 dark:border-[color:var(--color-studio-dark-divider)]",
        gutterClass,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className={leftClassName}>
          {leading}
          <div className="min-w-0">
            <Text
              as="h2"
              variant="subtitle"
              tone="primary"
              className={["truncate", titleClassName].filter(Boolean).join(" ")}
            >
              {title}
            </Text>
            {description ? (
              <Text
                as="p"
                variant="body"
                tone="muted"
                className={["mt-1", descriptionClassName].filter(Boolean).join(" ")}
              >
                {description}
              </Text>
            ) : null}
          </div>
        </div>
        {trailing || onClose ? (
          <div className="flex shrink-0 items-center gap-2">
            {trailing}
            {onClose ? (
              <IconButton
                type="button"
                variant="ghost"
                tone="muted"
                size="sm"
                onPress={onClose}
                aria-label={closeLabel}
                isDisabled={closeButtonDisabled}
              >
                <Xmark className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type StudioDialogBodyProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  className?: string;
  scrollable?: boolean;
  padding?: "default" | "none";
};

export function StudioDialogBody({ children, className, scrollable = false, padding = "default", ...props }: StudioDialogBodyProps) {
  const gutterClass = useStudioDialogGutterClass();
  return <div {...props} className={[
    padding === "default" ? `${gutterClass} py-4` : "",
    scrollable ? "min-h-0 flex-1 overflow-y-auto overscroll-contain" : "",
    className,
  ].filter(Boolean).join(" ")}>{children}</div>;
}

/** Actions remain outside the editor body's scroll area. */
export function StudioDialogFooter({ children, className, padding = "none", divider = false }: {
  children: ReactNode;
  className?: string;
  /** Opt in when the contained actions do not already own their padding. */
  padding?: "none" | "default";
  divider?: boolean;
}) {
  const gutterClass = useStudioDialogGutterClass();
  return <div className={[
    "shrink-0",
    padding === "default" ? `${gutterClass} py-4` : "",
    divider ? "border-t border-slate-200/70 dark:border-[color:var(--color-studio-dark-divider)]" : "",
    className,
  ].filter(Boolean).join(" ")}>{children}</div>;
}

type StudioDialogSectionLabelProps = {
  children: ReactNode;
  className?: string;
};

export function StudioDialogSectionLabel({
  children,
  className,
}: StudioDialogSectionLabelProps) {
  return (
    <Text
      variant="captionStrong"
      tone="muted"
      className={className}
    >
      {children}
    </Text>
  );
}

type StudioDialogDividerProps = {
  className?: string;
};

export function StudioDialogDivider({ className }: StudioDialogDividerProps) {
  return (
    <div
      className={["h-px bg-slate-200/80 dark:bg-[var(--color-studio-dark-divider)]", className].filter(Boolean).join(" ")}
    />
  );
}
