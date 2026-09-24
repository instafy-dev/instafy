import { useEffect, type ReactNode, type Ref } from "react";
import { Search } from "iconoir-react";
import { Button } from "../../../components/Button";

/** Desktop navigation shares one row. Search temporarily expands into that row. */
export function StudioDesktopHeader({ contextRef, searchTriggerRef, searchOpen, onSearch, children }: {
  contextRef: Ref<HTMLDivElement>;
  searchTriggerRef: Ref<HTMLButtonElement>;
  searchOpen: boolean;
  onSearch: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey ||
        !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k" ||
        document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      onSearch();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onSearch]);

  return <header className="studio-context-header instafy-titlebar-drag" aria-label="Working context" data-search-open={searchOpen}>
    <div className="studio-desktop-context-column">
      <div ref={contextRef} className="studio-context-slot" />
      <Button ref={searchTriggerRef} variant="ghost" size="sm" radius="lg"
        className="studio-desktop-search-trigger" hidden={searchOpen}
        aria-label="Search" aria-keyshortcuts="Meta+k Control+k" title="Search (⌘K / Ctrl+K)"
        data-testid="studio-desktop-search-trigger" onPress={onSearch}>
        <Search className="h-[18px] w-[18px]" aria-hidden="true" />
      </Button>
    </div>
    <div className="studio-desktop-tabs" hidden={searchOpen} inert={searchOpen || undefined}>
      {children}
    </div>
  </header>;
}
