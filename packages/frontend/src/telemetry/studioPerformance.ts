export type StudioPerformanceOperation = "studio_startup" | "conversation_switch" | "space_switch" | "organization_switch";
export type StudioPerformanceOutcome = "ready" | "error" | "timeout" | "superseded" | "hidden";
export type StudioMessageCountBucket = "0" | "1-50" | "51-200" | "201-1000" | "1001+";

/** Deliberately contains no account, workspace, conversation, URL, or message data. */
export interface StudioPerformanceSample {
  version: 1;
  operation: StudioPerformanceOperation;
  outcome: StudioPerformanceOutcome;
  durationMs: number;
  /** A readiness check waited for access, discovery, selection, or content; not proof a spinner painted. */
  loadingShown: boolean;
  messageCountBucket: StudioMessageCountBucket;
  viewport: "narrow" | "wide";
}

type Destination = { projectId?: string | null; organizationId?: string | null; conversationId?: string | null };
type Pending = Destination & {
  operation: StudioPerformanceOperation;
  startedAt: number;
  loadingShown: boolean;
  timer: ReturnType<typeof setTimeout>;
};
export type StudioVisibleContent = Required<Destination> & {
  messageCount: number;
  loading: boolean;
  error: boolean;
};

export function studioMessageCountBucket(count: number): StudioMessageCountBucket {
  return count <= 0 ? "0" : count <= 50 ? "1-50" : count <= 200 ? "51-200" : count <= 1_000 ? "201-1000" : "1001+";
}

/** One in-flight navigation and a small replay buffer; never retains transcript objects. */
export function createStudioPerformanceTracker({
  now = () => performance.now(),
  visible = () => typeof document === "undefined" || document.visibilityState !== "hidden",
  viewport = (): "narrow" | "wide" => typeof window !== "undefined" && window.innerWidth < 768 ? "narrow" : "wide",
} = {}) {
  let pending: Pending | null = null;
  const listeners = new Set<(sample: StudioPerformanceSample) => void>();
  const recent: StudioPerformanceSample[] = [];

  function finish(outcome: StudioPerformanceOutcome, messageCount = 0) {
    const current = pending;
    if (!current) return;
    pending = null;
    clearTimeout(current.timer);
    const sample: StudioPerformanceSample = Object.freeze({
      version: 1,
      operation: current.operation,
      outcome,
      durationMs: Math.round(Math.max(0, Math.min(60_000, now() - current.startedAt))),
      loadingShown: current.loadingShown,
      messageCountBucket: studioMessageCountBucket(messageCount),
      viewport: viewport(),
    });
    recent.push(sample);
    if (recent.length > 32) recent.shift();
    for (const listener of listeners) {
      try { listener(sample); } catch { /* Optional analytics must never affect navigation. */ }
    }
  }

  function begin(operation: StudioPerformanceOperation, destination: Destination = {}, startedAt = now()) {
    finish("superseded");
    if (!visible()) return;
    pending = {
      ...destination, operation, startedAt, loadingShown: false,
      timer: setTimeout(() => finish(visible() ? "timeout" : "hidden"), Math.max(0, 30_000 - (now() - startedAt))),
    };
  }

  function matches(destination: StudioVisibleContent, panel = false): boolean {
    return pending !== null &&
      (!panel || pending.operation !== "conversation_switch") &&
      (!pending.projectId || pending.projectId === destination.projectId) &&
      (pending.organizationId === undefined || pending.organizationId === destination.organizationId) &&
      (panel || !pending.conversationId || pending.conversationId === destination.conversationId);
  }

  function observe(content: StudioVisibleContent, panel = false): (() => void) | null {
    if (!matches(content, panel)) return null;
    if (!visible()) { finish("hidden"); return null; }
    if (content.loading) pending!.loadingShown = true;
    if (content.loading && !content.error) return null;
    const observed = pending;
    return () => {
      if (pending !== observed || !matches(content, panel)) return;
      finish(!visible() ? "hidden" : content.error && content.messageCount === 0 ? "error" : "ready", content.messageCount);
    };
  }

  return {
    begin,
    beginProject(projectId: string, organizationId: string | null, previousOrganizationId: string | null) {
      if (pending?.operation === "studio_startup") {
        pending.projectId = projectId;
        pending.organizationId = organizationId;
        return;
      }
      if (pending?.operation === "organization_switch" && pending.organizationId === organizationId) {
        pending.projectId = projectId;
        return;
      }
      if (pending?.projectId === projectId && pending.operation !== "conversation_switch") return;
      begin(organizationId === previousOrganizationId ? "space_switch" : "organization_switch", { projectId, organizationId });
    },
    beginConversation(projectId: string, conversationId: string) {
      if (pending?.operation === "studio_startup" ||
          (pending && pending.operation !== "conversation_switch" && pending.projectId === projectId)) {
        pending.projectId = projectId;
        pending.conversationId = conversationId;
        return;
      }
      if (pending?.projectId === projectId && pending.conversationId === conversationId) return;
      begin("conversation_switch", { projectId, conversationId });
    },
    /** Capture a completion for this navigation only; a later switch invalidates it. */
    observe,
    observePanel(content: Omit<StudioVisibleContent, "conversationId" | "messageCount">) {
      return observe({ ...content, conversationId: null, messageCount: 0 }, true);
    },
    cancelConversation() {
      if (pending?.operation === "conversation_switch") finish("superseded");
    },
    cancelOrganizationDiscovery(organizationId: string | null) {
      if (pending?.operation === "organization_switch" && pending.organizationId === organizationId && !pending.projectId) {
        finish("superseded");
      }
    },
    cancel(outcome: "superseded" | "hidden" = "superseded") { finish(outcome); },
    clear() {
      if (pending) clearTimeout(pending.timer);
      pending = null;
      recent.length = 0;
    },
    subscribe(listener: (sample: StudioPerformanceSample) => void, { replay = false } = {}) {
      listeners.add(listener);
      if (replay) for (const sample of [...recent]) {
        try { listener(sample); } catch { /* Keep a broken observer isolated. */ }
      }
      return () => { listeners.delete(listener); };
    },
  };
}

export const studioPerformance = createStudioPerformanceTracker();

/** Trusted build-time feature modules choose their own opt-in, bounded transport. */
export const subscribeStudioPerformance = studioPerformance.subscribe;
