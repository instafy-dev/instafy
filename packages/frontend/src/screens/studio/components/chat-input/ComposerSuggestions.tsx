import type { ComponentPropsWithRef, ReactNode } from "react";
import { MenuItemContent } from "../../../../components/MenuItemContent";
import { Surface, type SurfaceProps } from "../../../../components/Surface";
import { STUDIO_MENU_NATIVE_ROW_CLASS } from "../../../../components/aria/studioMenuStyles";

/** Presentation only: Lexical owns the portal anchor, selection and keyboard focus. */
export function ComposerSuggestionMenu({ className, ...props }: SurfaceProps) {
  return (
    <Surface
      tone="floating"
      radius="2xl"
      shadow="lg"
      {...props}
      className={["fixed z-50 overflow-y-auto overscroll-contain p-2", className].filter(Boolean).join(" ")}
    />
  );
}

type ComposerSuggestionOptionProps = Omit<ComponentPropsWithRef<"button">, "children"> & {
  label: ReactNode;
  description?: ReactNode;
  start?: ReactNode;
  isHighlighted: boolean;
};

export function ComposerSuggestionOption({
  label,
  description,
  start,
  isHighlighted,
  className,
  ...props
}: ComposerSuggestionOptionProps) {
  return (
    <button
      type="button"
      {...props}
      data-highlighted={isHighlighted ? "true" : "false"}
      className={[STUDIO_MENU_NATIVE_ROW_CLASS, className].filter(Boolean).join(" ")}
    >
      <MenuItemContent start={start} description={description}>
        {label}
      </MenuItemContent>
    </button>
  );
}
