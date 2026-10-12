import { isAbsolute, relative, resolve } from "node:path";

/**
 * A dev-server watch filter that skips `tmp/` directories inside one checkout.
 *
 * The repository keeps scratch worktrees under `tmp/`, and a dev server for
 * the main checkout must not watch them. A plain `**\/tmp/**` glob also
 * matches an ancestor of the checkout itself, so a dev server started inside
 * a worktree at `<repo>/tmp/<name>` would ignore every one of its own files
 * and keep serving the first transform of each module forever. Matching
 * against the path relative to the checkout root keeps both cases right.
 */
export function createCheckoutTmpIgnore(checkoutRoot: string): (file: string) => boolean {
  const root = resolve(checkoutRoot);
  return (file: string): boolean => {
    const rel = relative(root, resolve(root, file));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
    return rel.split(/[\\/]+/).includes("tmp");
  };
}
