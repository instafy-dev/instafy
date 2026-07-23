import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, EditPencil, MoreHoriz, Pause, Play, Trash } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Button, IconButton } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { StudioMenu, StudioMenuItem, StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { Text } from "../../../components/Text";
import { Textarea } from "../../../components/Textarea";
import { Toggle } from "../../../components/Toggle";
import { SettingsShell } from "./SettingsShell";
import {
  controllerClient,
  type ControllerAutomation,
  type ControllerAutomationRuntimeMode,
  type ControllerAutomationScheduleKind,
  type ControllerAutomationStatus,
} from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { useProjects } from "../../../projects/useProjects";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import {
  LIST_ROW_FOCUS_WITHIN_RING,
  LIST_ROW_SURFACE_BASE,
  DRAWER_LIST_ROW_META_CLASS,
  DRAWER_LIST_ROW_TEXT_CLASS,
  listRowSurfaceToneClassName,
} from "../../../components/listRowStyles";

type AutomationDraft = {
  id?: string;
  name: string;
  promptText: string;
  scheduleKind: ControllerAutomationScheduleKind;
  runAtLocal: string;
  intervalHours: number;
  byDay: string[];
  byHour: number;
  byMinute: number;
  timezone: string;
  runtimeMode: ControllerAutomationRuntimeMode;
  runtimeProvider: string;
  enabled: boolean;
};

const WEEK_DAYS: Array<{ code: string; label: string }> = [
  { code: "mo", label: "Mo" },
  { code: "tu", label: "Tu" },
  { code: "we", label: "We" },
  { code: "th", label: "Th" },
  { code: "fr", label: "Fr" },
  { code: "sa", label: "Sa" },
  { code: "su", label: "Su" },
];

function localTimezone(): string {
  try {
    if (typeof Intl !== "undefined") {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (typeof tz === "string" && tz.trim()) {
        return tz.trim();
      }
    }
  } catch {
    // ignore
  }
  return "UTC";
}

function formatSchedule(automation: ControllerAutomation): string {
  if (automation.scheduleKind === "once") {
    return "Once";
  }
  if (automation.scheduleKind === "weekly") {
    const dayLabel = automation.byDay.length > 0 ? automation.byDay.map((day) => day.toUpperCase()).join(" ") : "WEEKLY";
    const hour = typeof automation.byHour === "number" ? automation.byHour : 9;
    const minute = typeof automation.byMinute === "number" ? automation.byMinute : 0;
    const padded = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    return `${dayLabel} ${padded} (${automation.timezone || "UTC"})`;
  }
  const interval = automation.intervalHours && automation.intervalHours > 0 ? automation.intervalHours : 24;
  return `Every ${interval}h`;
}

function formatWhen(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  try {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      return raw;
    }
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return raw;
  }
}

function formatDateTimeLocalInTimeZone(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour");
    const minute = get("minute");
    const second = get("second");
    if (year && month && day && hour && minute && second) {
      return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
    }
  } catch {
    // ignore
  }

  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function draftFromAutomation(automation: ControllerAutomation): AutomationDraft {
  const timezone = automation.timezone?.trim() || localTimezone();
  const runAtSource = automation.runAt ?? automation.nextRunAt ?? null;
  const runAtLocal = runAtSource
    ? formatDateTimeLocalInTimeZone(new Date(runAtSource), timezone)
    : formatDateTimeLocalInTimeZone(new Date(Date.now() + 60 * 60 * 1000), timezone);
  return {
    id: automation.id,
    name: automation.name,
    promptText: automation.promptText,
    scheduleKind: automation.scheduleKind,
    runAtLocal,
    intervalHours: automation.intervalHours ?? 24,
    byDay: automation.byDay ?? ["mo", "tu", "we", "th", "fr"],
    byHour: automation.byHour ?? 9,
    byMinute: automation.byMinute ?? 0,
    timezone,
    runtimeMode: automation.runtimeMode,
    runtimeProvider: automation.runtimeProvider ?? "",
    enabled: automation.status === "active",
  };
}

function emptyDraft(): AutomationDraft {
  const timezone = localTimezone();
  return {
    name: "",
    promptText: "",
    scheduleKind: "weekly",
    runAtLocal: formatDateTimeLocalInTimeZone(new Date(Date.now() + 60 * 60 * 1000), timezone),
    intervalHours: 24,
    byDay: ["mo", "tu", "we", "th", "fr"],
    byHour: 9,
    byMinute: 0,
    timezone,
    runtimeMode: "auto",
    runtimeProvider: "",
    enabled: true,
  };
}

export function AutomationsPanel() {
  const { activeProjectId } = useProjects();
  const { openConversationTab } = useWorkspaceTabs();
  const { showStatus } = useStatus();
  const [automations, setAutomations] = useState<ControllerAutomation[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<AutomationDraft>(() => emptyDraft());
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeProjectId) {
      setAutomations([]);
      return;
    }
    setLoading(true);
    try {
      const data = await controllerClient.automations.listForProject({
        projectId: activeProjectId,
      });
      setAutomations(data ?? []);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(message || "Unable to load automations.", "error", 5000);
      setAutomations([]);
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, showStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sortedAutomations = useMemo(() => {
    return [...automations].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }, [automations]);

  const openCreate = () => {
    setDraft(emptyDraft());
    setEditorOpen(true);
  };

  const openEdit = (automation: ControllerAutomation) => {
    setDraft(draftFromAutomation(automation));
    setEditorOpen(true);
  };

  const persistDraft = async () => {
    if (!activeProjectId) {
      return;
    }
    const name = draft.name.trim();
    if (!name) {
      showStatus("Name is required.", "error", 3500);
      return;
    }
    const promptText = draft.promptText.trim();
    if (!promptText) {
      showStatus("Prompt is required.", "error", 3500);
      return;
    }
    setSaving(true);
    try {
      const timezone = draft.timezone.trim() || "UTC";
      const runtimeProvider = draft.runtimeProvider.trim() || null;
      const status: ControllerAutomationStatus = draft.enabled ? "active" : "paused";

      if (draft.id) {
        await controllerClient.automations.update({
          automationId: draft.id,
          name,
          promptText,
          scheduleKind: draft.scheduleKind,
          runAt: draft.scheduleKind === "once" ? draft.runAtLocal : undefined,
          intervalHours: draft.scheduleKind === "hourly" ? draft.intervalHours : null,
          byDay: draft.scheduleKind === "weekly" ? draft.byDay : null,
          byHour: draft.scheduleKind === "weekly" ? draft.byHour : null,
          byMinute: draft.scheduleKind === "weekly" ? draft.byMinute : null,
          timezone,
          runtimeMode: draft.runtimeMode,
          runtimeProvider,
          status,
        });
      } else {
        await controllerClient.automations.create({
          projectId: activeProjectId,
          name,
          promptText,
          scheduleKind: draft.scheduleKind,
          runAt: draft.scheduleKind === "once" ? draft.runAtLocal : undefined,
          intervalHours: draft.scheduleKind === "hourly" ? draft.intervalHours : null,
          byDay: draft.scheduleKind === "weekly" ? draft.byDay : null,
          byHour: draft.scheduleKind === "weekly" ? draft.byHour : null,
          byMinute: draft.scheduleKind === "weekly" ? draft.byMinute : null,
          timezone,
          runtimeMode: draft.runtimeMode,
          runtimeProvider,
          status,
        });
      }

      setEditorOpen(false);
      await refresh();
      showStatus("Automation saved.", "success", 2500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(message || "Unable to save automation.", "error", 6000);
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async (automation: ControllerAutomation) => {
    try {
      await controllerClient.automations.runNow({ automationId: automation.id });
      showStatus("Automation queued.", "success", 2500);
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(message || "Unable to run automation.", "error", 6000);
    }
  };

  const handleTogglePause = async (automation: ControllerAutomation) => {
    const nextStatus: ControllerAutomationStatus = automation.status === "paused" ? "active" : "paused";
    try {
      await controllerClient.automations.update({
        automationId: automation.id,
        status: nextStatus,
      });
      await refresh();
      showStatus(nextStatus === "paused" ? "Automation paused." : "Automation resumed.", "success", 2500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(message || "Unable to update automation.", "error", 6000);
    }
  };

  const handleDelete = async (automation: ControllerAutomation) => {
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Delete automation "${automation.name}"?`);
      if (!confirmed) {
        return;
      }
    }
    try {
      await controllerClient.automations.delete({ automationId: automation.id });
      await refresh();
      showStatus("Automation deleted.", "success", 2500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(message || "Unable to delete automation.", "error", 6000);
    }
  };

  return (
    <SettingsShell
      testId="automations-panel"
      title="Automations"
      subtitle="Run prompts on a schedule."
      actions={
        <Button
          variant="primary"
          size="sm"
          radius="xl"
          onPress={openCreate}
          data-testid="automations-create-button"
        >
          New
        </Button>
      }
    >
      <div className="space-y-3">
        {loading ? (
          <Text tone="muted">Loading…</Text>
        ) : sortedAutomations.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
            <Text tone="muted">No automations yet.</Text>
          </div>
        ) : (
          <div className="space-y-2">
            {sortedAutomations.map((automation) => {
              const nextRun = formatWhen(automation.nextRunAt);
              const lastRun = formatWhen(automation.lastRunAt);
              const schedule = formatSchedule(automation);
              const mutedMetaParts = [
                schedule,
                automation.runtimeMode === "hosted" ? "Cloud" : automation.runtimeMode === "existing" ? "Existing" : "Auto",
                nextRun ? `Next ${nextRun}` : null,
              ].filter(Boolean);

              const isDoneOnce =
                automation.scheduleKind === "once" &&
                automation.status === "paused" &&
                !automation.nextRunAt &&
                Boolean(automation.lastRunAt);
              const statusLabel = isDoneOnce
                ? "Done"
                : automation.status === "paused"
                  ? "Paused"
                  : automation.lastError
                    ? "Error"
                    : "Active";
              const statusTone =
                automation.lastError ? "text-rose-600 dark:text-rose-400" : automation.status === "paused" ? "text-slate-500 dark:text-slate-400" : "";

              return (
                <div
                  key={automation.id}
                  className={[
                    LIST_ROW_SURFACE_BASE,
                    listRowSurfaceToneClassName(false),
                    LIST_ROW_FOCUS_WITHIN_RING,
                    "px-3 py-2.5",
                  ].join(" ")}
                  data-testid={`automation-row-${automation.id}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-slate-100 text-slate-600 dark:bg-slate-900/60 dark:text-slate-300">
                      <Clock className="h-5 w-5" aria-hidden={true} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-baseline gap-2">
                            <Text className={`${DRAWER_LIST_ROW_TEXT_CLASS} font-medium truncate`}>{automation.name}</Text>
                            <Text variant="caption" className={["text-xs", statusTone].filter(Boolean).join(" ")}>
                              {statusLabel}
                            </Text>
                          </div>
                          <Text className={DRAWER_LIST_ROW_META_CLASS} tone="muted">
                            {mutedMetaParts.join(" · ")}
                          </Text>
                          {automation.lastError ? (
                            <Text variant="caption" className="mt-1 text-rose-600 dark:text-rose-400 line-clamp-2">
                              {automation.lastError}
                            </Text>
                          ) : lastRun ? (
                            <Text variant="caption" tone="muted" className="mt-1">
                              Last {lastRun}
                            </Text>
                          ) : null}
                        </div>
                        <MenuTrigger>
                          <IconButton
                            aria-label="Automation actions"
                            variant="ghost"
                            size="xs"
                            radius="full"
                            className="text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-900/60"
                          >
                            <MoreHoriz className="h-4 w-4" aria-hidden={true} />
                          </IconButton>
                          <StudioPopover placement="bottom end" offset={6} className="w-56 p-2">
                            <StudioMenu
                              aria-label="Automation actions"
                              onAction={(key) => {
                                const action = String(key);
                                if (action === "run") {
                                  void handleRunNow(automation);
                                } else if (action === "edit") {
                                  openEdit(automation);
                                } else if (action === "toggle") {
                                  void handleTogglePause(automation);
                                } else if (action === "thread") {
                                  if (automation.conversationId) {
                                    openConversationTab(automation.conversationId);
                                  }
                                } else if (action === "delete") {
                                  void handleDelete(automation);
                                }
                              }}
                            >
                              <StudioMenuItem id="run" data-testid={`automation-run-${automation.id}`}>
                                <MenuItemContent start={<Play className="h-4 w-4" aria-hidden={true} />}>
                                  Run now
                                </MenuItemContent>
                              </StudioMenuItem>
                              <StudioMenuItem id="edit">
                                <MenuItemContent start={<EditPencil className="h-4 w-4" aria-hidden={true} />}>
                                  Edit
                                </MenuItemContent>
                              </StudioMenuItem>
                              <StudioMenuItem id="toggle">
                                <MenuItemContent start={automation.status === "paused" ? <Play className="h-4 w-4" aria-hidden={true} /> : <Pause className="h-4 w-4" aria-hidden={true} />}>
                                  {automation.status === "paused" ? "Resume" : "Pause"}
                                </MenuItemContent>
                              </StudioMenuItem>
                              {automation.conversationId ? (
                                <>
                                  <StudioMenuSeparator />
                                  <StudioMenuItem id="thread">
                                    <MenuItemContent start={<Clock className="h-4 w-4" aria-hidden={true} />}>
                                      Open thread
                                    </MenuItemContent>
                                  </StudioMenuItem>
                                </>
                              ) : null}
                              <StudioMenuSeparator />
                              <StudioMenuItem
                                id="delete"
                                className="text-rose-600 dark:text-rose-400"
                              >
                                <MenuItemContent start={<Trash className="h-4 w-4" aria-hidden={true} />}>
                                  Delete
                                </MenuItemContent>
                              </StudioMenuItem>
                            </StudioMenu>
                          </StudioPopover>
                        </MenuTrigger>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <StudioDialogModal
        isOpen={editorOpen}
        onOpenChange={setEditorOpen}
        dialogAriaLabel="Automation editor"
        className="items-end p-0 sm:items-center sm:p-4"
        modalClassName="max-w-2xl overflow-hidden max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:max-w-none max-sm:rounded-none max-sm:border-x-0 max-sm:border-y-0 sm:max-h-[min(90dvh,48rem)]"
      >
        <div className="flex h-full max-h-[inherit] flex-col">
          <StudioDialogHeader
            title={draft.id ? "Edit automation" : "Create automation"}
            description="Runs in a private thread."
            onClose={() => setEditorOpen(false)}
            closeButtonDisabled={saving}
            closeLabel="Close automation editor"
            className="px-4 py-3"
          />

          <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Text variant="caption" tone="muted">
                    Name
                  </Text>
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="Daily bug scan"
                    data-testid="automation-name-input"
                  />
                </div>
                <div className="space-y-1">
                  <Text variant="caption" tone="muted">
                    Timezone
                  </Text>
                  <Input
                    value={draft.timezone}
                    onChange={(e) => setDraft((prev) => ({ ...prev, timezone: e.target.value }))}
                    placeholder="America/New_York"
                    data-testid="automation-timezone-input"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Text variant="caption" tone="muted">
                  Prompt
                </Text>
                <Textarea
                  value={draft.promptText}
                  onChange={(e) => setDraft((prev) => ({ ...prev, promptText: e.target.value }))}
                  rows={8}
                  placeholder="What should Instafy do on schedule?"
                  data-testid="automation-prompt-input"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <SegmentedControl<ControllerAutomationScheduleKind>
                  label="Schedule"
                  value={draft.scheduleKind}
                  onChange={(value) =>
                    setDraft((prev) => ({
                      ...prev,
                      scheduleKind: value,
                    }))
                  }
                  options={[
                    { value: "once", label: "Once" },
                    { value: "weekly", label: "Weekly" },
                    { value: "hourly", label: "Interval" },
                  ]}
                />

                <SegmentedControl<ControllerAutomationRuntimeMode>
                  label="Runtime"
                  value={draft.runtimeMode}
                  onChange={(value) => setDraft((prev) => ({ ...prev, runtimeMode: value }))}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "hosted", label: "Cloud" },
                    { value: "existing", label: "Existing" },
                  ]}
                />
              </div>

              {draft.scheduleKind === "once" ? (
                <div className="space-y-1">
                  <Text variant="caption" tone="muted">
                    Run at
                  </Text>
                  <Input
                    type="datetime-local"
                    value={draft.runAtLocal}
                    step={1}
                    onChange={(e) => setDraft((prev) => ({ ...prev, runAtLocal: e.target.value }))}
                    data-testid="automation-runat-input"
                  />
                </div>
              ) : draft.scheduleKind === "weekly" ? (
                <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
                  <div className="flex flex-wrap items-center gap-2">
                    {WEEK_DAYS.map((day) => {
                      const active = draft.byDay.includes(day.code);
                      return (
                        <Button
                          key={day.code}
                          variant={active ? "secondary" : "ghost"}
                          size="xs"
                          radius="full"
                          onPress={() => {
                            setDraft((prev) => {
                              const next = new Set(prev.byDay);
                              if (next.has(day.code)) {
                                next.delete(day.code);
                              } else {
                                next.add(day.code);
                              }
                              return { ...prev, byDay: Array.from(next) };
                            });
                          }}
                        >
                          {day.label}
                        </Button>
                      );
                    })}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Text variant="caption" tone="muted">
                        Hour (0-23)
                      </Text>
                      <Input
                        type="number"
                        min={0}
                        max={23}
                        value={draft.byHour}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, byHour: Number(e.target.value) }))
                        }
                        data-testid="automation-byhour-input"
                      />
                    </div>
                    <div className="space-y-1">
                      <Text variant="caption" tone="muted">
                        Minute (0-59)
                      </Text>
                      <Input
                        type="number"
                        min={0}
                        max={59}
                        value={draft.byMinute}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, byMinute: Number(e.target.value) }))
                        }
                        data-testid="automation-byminute-input"
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <Text variant="caption" tone="muted">
                    Interval hours
                  </Text>
                  <Input
                    type="number"
                    min={1}
                    value={draft.intervalHours}
                    onChange={(e) => setDraft((prev) => ({ ...prev, intervalHours: Number(e.target.value) }))}
                    data-testid="automation-interval-input"
                  />
                </div>
              )}

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Text variant="caption" tone="muted">
                    Runtime provider (optional)
                  </Text>
                  <Input
                    value={draft.runtimeProvider}
                    onChange={(e) => setDraft((prev) => ({ ...prev, runtimeProvider: e.target.value }))}
                    placeholder="instafy_cloud"
                    data-testid="automation-runtime-provider-input"
                  />
                </div>
                <div className="flex items-end">
                  <Toggle
                    isSelected={draft.enabled}
                    onChange={(value) => setDraft((prev) => ({ ...prev, enabled: value }))}
                    label="Enabled"
                    description={draft.enabled ? "Runs on schedule." : "Paused."}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
            <Button variant="ghost" size="sm" radius="xl" onPress={() => setEditorOpen(false)} isDisabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              radius="xl"
              onPress={persistDraft}
              isDisabled={saving || !activeProjectId}
              data-testid="automation-save-button"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </StudioDialogModal>
    </SettingsShell>
  );
}
