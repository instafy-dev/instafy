import { useSyncExternalStore } from "react";
import { getProviderEventLogSnapshot, subscribeToProviderEventLog } from "./providerEventStore";
import { serializeProviderEventIdentity } from "./providerEvents";
import {
  selectProviderTriggerCandidates,
  type ProviderTriggerCandidate,
} from "./providerEventTriggers";

type ProviderTriggerQueueListener = () => void;

const dismissedProviderTriggerIds = new Set<string>();
const providerTriggerQueueListeners = new Set<ProviderTriggerQueueListener>();
let providerTriggerQueueSnapshot: ProviderTriggerCandidate[] = [];
let providerTriggerQueueBridgeInstalled = false;

function emitProviderTriggerQueueChange() {
  for (const listener of providerTriggerQueueListeners) {
    listener();
  }
}

function getProviderTriggerIdentity(candidate: ProviderTriggerCandidate) {
  return serializeProviderEventIdentity(candidate.latestEvent as Record<string, unknown>);
}

function pruneDismissedProviderTriggerIds() {
  const activeIds = new Set(
    selectProviderTriggerCandidates(getProviderEventLogSnapshot()).map((candidate) =>
      getProviderTriggerIdentity(candidate),
    ),
  );
  for (const identity of dismissedProviderTriggerIds) {
    if (!activeIds.has(identity)) {
      dismissedProviderTriggerIds.delete(identity);
    }
  }
}

function computeProviderTriggerQueue(): ProviderTriggerCandidate[] {
  pruneDismissedProviderTriggerIds();
  return selectProviderTriggerCandidates(getProviderEventLogSnapshot()).filter(
    (candidate) => !dismissedProviderTriggerIds.has(getProviderTriggerIdentity(candidate)),
  );
}

function refreshProviderTriggerQueueSnapshot() {
  const nextQueue = computeProviderTriggerQueue();
  if (
    nextQueue.length === providerTriggerQueueSnapshot.length &&
    nextQueue.every((entry, index) => entry === providerTriggerQueueSnapshot[index])
  ) {
    return;
  }
  providerTriggerQueueSnapshot = nextQueue;
  emitProviderTriggerQueueChange();
}

function ensureProviderTriggerQueueBridge() {
  if (providerTriggerQueueBridgeInstalled) {
    return;
  }
  subscribeToProviderEventLog(() => {
    refreshProviderTriggerQueueSnapshot();
  });
  providerTriggerQueueBridgeInstalled = true;
  refreshProviderTriggerQueueSnapshot();
}

export function getProviderTriggerQueueSnapshot() {
  ensureProviderTriggerQueueBridge();
  return providerTriggerQueueSnapshot;
}

export function dismissProviderTriggerCandidate(candidate: ProviderTriggerCandidate) {
  const identity = getProviderTriggerIdentity(candidate);
  if (dismissedProviderTriggerIds.has(identity)) {
    return;
  }
  dismissedProviderTriggerIds.add(identity);
  refreshProviderTriggerQueueSnapshot();
}

export function clearProviderTriggerQueue() {
  const queue = providerTriggerQueueSnapshot;
  if (queue.length === 0) {
    return;
  }
  for (const candidate of queue) {
    dismissedProviderTriggerIds.add(getProviderTriggerIdentity(candidate));
  }
  refreshProviderTriggerQueueSnapshot();
}

export function subscribeToProviderTriggerQueue(listener: ProviderTriggerQueueListener) {
  ensureProviderTriggerQueueBridge();
  providerTriggerQueueListeners.add(listener);
  return () => {
    providerTriggerQueueListeners.delete(listener);
  };
}

export function useProviderTriggerQueue() {
  return useSyncExternalStore(
    subscribeToProviderTriggerQueue,
    getProviderTriggerQueueSnapshot,
    getProviderTriggerQueueSnapshot,
  );
}
