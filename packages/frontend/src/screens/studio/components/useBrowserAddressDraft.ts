import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** An address edit belongs to one tab. Redirects in that tab leave typing alone. */
export function useBrowserAddressDraft({
  pageIdentity,
  pageAddress,
  inputRef,
  onPageChange,
}: {
  pageIdentity: string | null;
  pageAddress: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onPageChange?: () => void;
}) {
  const [draft, setDraft] = useState({ identity: pageIdentity, value: pageAddress });
  const previousIdentity = useRef(pageIdentity);
  const onPageChangeRef = useRef(onPageChange);
  onPageChangeRef.current = onPageChange;

  useLayoutEffect(() => {
    const changedPage = previousIdentity.current !== pageIdentity;
    previousIdentity.current = pageIdentity;
    if (changedPage || document.activeElement !== inputRef.current) {
      setDraft((current) => current.identity === pageIdentity && current.value === pageAddress
        ? current : { identity: pageIdentity, value: pageAddress });
    }
    if (changedPage) onPageChangeRef.current?.();
  }, [inputRef, pageAddress, pageIdentity]);

  const setValue = useCallback((value: string) => {
    setDraft({ identity: pageIdentity, value });
  }, [pageIdentity]);

  // Do not expose the previous tab's draft even for the render before layout effects.
  return { value: draft.identity === pageIdentity ? draft.value : pageAddress, setValue };
}
