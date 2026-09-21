import { randomUUID } from "node:crypto";
import { parseBrowserTabInput, type BrowserTabInput } from "./browserTabInput";

export type ExploreViewport = { width: number; height: number; dpr: number };
export type ExploreNavigation = "back" | "forward" | "reload";
export interface ExplorePage {
  frame(): Promise<Uint8Array | null>;
  resize(viewport: ExploreViewport): Promise<void>;
  input(input: BrowserTabInput, current: () => boolean): Promise<void>;
  navigate(action: ExploreNavigation): Promise<void>;
  close(): void;
}
export function exploreViewport(raw: unknown): ExploreViewport {
  if (!raw || typeof raw !== "object")
    throw new Error("Invalid Explore viewport.");
  const { width, height, dpr } = raw as ExploreViewport;
  if (
    !Number.isInteger(width) ||
    width < 240 ||
    width > 1920 ||
    !Number.isInteger(height) ||
    height < 160 ||
    height > 1440 ||
    !Number.isFinite(dpr) ||
    dpr < 1 ||
    dpr > 3
  )
    throw new Error("Invalid Explore viewport.");
  return {
    width,
    height,
    dpr: Math.min(dpr, Math.sqrt(1_920_000 / (width * height))),
  };
}

type View = {
  page: ExplorePage;
  valid: () => boolean;
  timer?: ReturnType<typeof setTimeout>;
  born: number;
  queue: Promise<void>;
  queued: number;
  capturing: boolean;
};
/** Ephemeral, explicitly approved views; no renderer gets an Electron session. */
export class BrowserTabExplore {
  private readonly views = new Map<string, View>();
  open(
    create: (viewport: ExploreViewport) => ExplorePage,
    valid: () => boolean,
    raw: unknown,
  ): string {
    if (!valid()) throw new Error("Tab sharing ended.");
    if (this.views.size >= 4)
      throw new Error("Close an Explore view before opening another.");
    const viewport = exploreViewport(raw),
      id = randomUUID();
    const page = create(viewport);
    const view: View = {
      page,
      valid,
      born: Date.now(),
      queue: Promise.resolve(),
      queued: 0,
      capturing: false,
    };
    this.views.set(id, view);
    this.renew(id);
    return id;
  }
  renew(id: string): boolean {
    const view = this.views.get(id);
    if (!view || !view.valid() || Date.now() - view.born >= 30 * 60_000) {
      this.close(id);
      return false;
    }
    clearTimeout(view.timer);
    view.timer = setTimeout(() => this.close(id), 4000);
    view.timer.unref?.();
    return true;
  }
  private current(id: string, view: View) {
    return this.views.get(id) === view && view.valid();
  }
  async frame(id: string) {
    const view = this.views.get(id);
    if (!view || !this.current(id, view)) throw new Error("Explore ended.");
    if (view.capturing) return null;
    view.capturing = true;
    try {
      const bytes = await view.page.frame();
      if (!this.current(id, view)) throw new Error("Explore ended.");
      if (bytes && bytes.length > 1024 * 1024)
        throw new Error("Explore frame too large.");
      return bytes;
    } finally {
      view.capturing = false;
    }
  }
  private async enqueue(
    id: string,
    operation: (page: ExplorePage, current: () => boolean) => Promise<void>,
  ) {
    const view = this.views.get(id);
    if (!view || !this.current(id, view)) throw new Error("Explore ended.");
    if (view.queued >= 32) throw new Error("Explore input is busy.");
    view.queued++;
    const current = () => this.current(id, view);
    const promise = view.queue.then(async () => {
      if (!current()) throw new Error("Explore ended.");
      await operation(view.page, current);
    });
    view.queue = promise.catch(() => {});
    try {
      await promise;
    } finally {
      view.queued--;
    }
  }
  input(id: string, raw: unknown) {
    const input = parseBrowserTabInput(raw);
    return this.enqueue(id, (page, current) => page.input(input, current));
  }
  resize(id: string, raw: unknown) {
    const viewport = exploreViewport(raw);
    return this.enqueue(id, (page) => page.resize(viewport));
  }
  navigate(id: string, raw: unknown) {
    if (raw !== "back" && raw !== "forward" && raw !== "reload")
      throw new Error("Invalid Explore navigation.");
    return this.enqueue(id, (page) => page.navigate(raw));
  }
  close(id: string) {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    clearTimeout(view.timer);
    view.page.close();
  }
  closeAll() {
    for (const id of this.views.keys()) this.close(id);
  }
}
