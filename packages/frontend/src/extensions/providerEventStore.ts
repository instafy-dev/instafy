import { useSyncExternalStore } from "react";
import {
  PROVIDER_EVENT_DEBUG_INJECT_EVENT,
  PROVIDER_EVENT_OBSERVED_EVENT,
} from "./providerEventChannel";
import {
  appendProviderEventLog,
  type ProviderEventLogEntry,
} from "./providerEventLog";

type ProviderEventLogListener = () => void;

let providerEventLogEntries: ProviderEventLogEntry[] = [];
const providerEventLogListeners = new Set<ProviderEventLogListener>();
let providerEventWindowBridgeInstalled = false;

function emitProviderEventLogChange() {
  for (const listener of providerEventLogListeners) {
    listener();
  }
}

function normalizeProviderEventWindowDetail(detail: unknown) {
  if (
    detail &&
    typeof detail === "object" &&
    !Array.isArray(detail) &&
    Array.isArray((detail as { events?: unknown[] }).events)
  ) {
    return (detail as { events: unknown[] }).events;
  }
  return detail;
}

function applyProviderEventLogValues(values: unknown) {
  const nextEntries = appendProviderEventLog(providerEventLogEntries, values);
  if (
    nextEntries.length === providerEventLogEntries.length &&
    nextEntries.every((entry, index) => entry === providerEventLogEntries[index])
  ) {
    return;
  }
  providerEventLogEntries = nextEntries;
  emitProviderEventLogChange();
}

function ensureProviderEventWindowBridge() {
  if (providerEventWindowBridgeInstalled || typeof window === "undefined") {
    return;
  }
  const handleProviderEvents = (event: Event) => {
    applyProviderEventLogValues(
      normalizeProviderEventWindowDetail((event as CustomEvent<unknown>).detail),
    );
  };
  window.addEventListener(PROVIDER_EVENT_DEBUG_INJECT_EVENT, handleProviderEvents);
  window.addEventListener(PROVIDER_EVENT_OBSERVED_EVENT, handleProviderEvents);
  providerEventWindowBridgeInstalled = true;
}

export function appendProviderEventsToStore(values: unknown) {
  applyProviderEventLogValues(values);
}

export function clearProviderEventLogStore() {
  if (providerEventLogEntries.length === 0) {
    return;
  }
  providerEventLogEntries = [];
  emitProviderEventLogChange();
}

export function getProviderEventLogSnapshot() {
  return providerEventLogEntries;
}

export function subscribeToProviderEventLog(listener: ProviderEventLogListener) {
  ensureProviderEventWindowBridge();
  providerEventLogListeners.add(listener);
  return () => {
    providerEventLogListeners.delete(listener);
  };
}

export function useProviderEventLogStore() {
  return useSyncExternalStore(
    subscribeToProviderEventLog,
    getProviderEventLogSnapshot,
    getProviderEventLogSnapshot,
  );
}
