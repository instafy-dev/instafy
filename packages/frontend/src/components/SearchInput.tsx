import { forwardRef } from "react";
import { Search } from "iconoir-react";
import { Input, type InputProps } from "./Input";

export type SearchInputProps = Omit<InputProps, "type"> & {
  label: string;
  iconTestId?: string;
  inputTestId?: string;
};

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { id, label, iconTestId, inputTestId, className, size = "sm", radius = "xl", tone = "muted", ...props },
  ref,
) {
  if (!id) {
    throw new Error("SearchInput requires an id.");
  }

  const { ["data-testid"]: dataTestId, ...restProps } = props as InputProps & {
    "data-testid"?: string;
  };
  const resolvedTestId = inputTestId ?? dataTestId;

  return (
    <>
      <label htmlFor={id} className="sr-only" aria-hidden="true">
        {label}
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-slate-500"
          aria-hidden="true"
          data-testid={iconTestId}
        />
        <Input
          ref={ref}
          id={id}
          type="search"
          size={size}
          radius={radius}
          tone={tone}
          aria-label={label}
          className={["pl-9", className].filter(Boolean).join(" ")}
          data-testid={resolvedTestId}
          {...restProps}
        />
      </div>
    </>
  );
});

SearchInput.displayName = "SearchInput";
