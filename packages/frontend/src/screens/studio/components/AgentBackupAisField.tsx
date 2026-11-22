import { useId, useLayoutEffect, useRef, useState } from "react";
import { MenuTrigger } from "react-aria-components";
import { NavArrowDown, NavArrowUp, Plus, Xmark } from "iconoir-react";
import { AGENT_BACKUP_AIS_MAX, type AgentBackupAi } from "@instafy/sdk/agents";
import { Button, IconButton } from "../../../components/Button";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { Text } from "../../../components/Text";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import type { AgentBackupItem } from "./agentBackupAis";

export interface AgentBackupAisFieldProps {
  /** The list, in order, each by its name. */
  rows: readonly AgentBackupItem[];
  /** What Add a backup offers: the person's other sign-ins, none already listed or the agent's own AI. */
  choices: readonly AgentBackupItem[];
  /** The whole list in its new order. */
  onChange: (next: AgentBackupAi[]) => void;
  disabled?: boolean;
  max?: number;
}

/** Where focus goes once the list changes under the press that changed it. */
type PendingFocus = { key: string; control: "up" | "down" | "remove" } | { key: null; control: "add" };

/**
 * The agent editor's **Backups** (docs/Settings-UI.md, Bot profiles): more of
 * the person's own sign-ins after the agent's AI, in order, up to 8. Each row
 * has Move up, Move down and Remove; Add a backup offers the rest by name.
 */
export function AgentBackupAisField({
  rows,
  choices,
  onChange,
  disabled = false,
  max = AGENT_BACKUP_AIS_MAX,
}: AgentBackupAisFieldProps) {
  const headingId = useId();
  const hintId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const controls = useRef(new Map<string, HTMLButtonElement | null>());
  const addRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);
  const atLimit = rows.length >= max;
  const entries = rows.map((row) => row.signIn);

  // A moved row keeps focus on the control that moved it, or on the other
  // arrow once it reaches an end; a removed row hands focus to the row that
  // took its place, else to Add a backup.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) {
      return;
    }
    pendingFocus.current = null;
    const index = pending.key === null ? -1 : rows.findIndex((row) => row.key === pending.key);
    const candidates: (HTMLButtonElement | null | undefined)[] =
      index < 0
        ? [addRef.current]
        : [
            controls.current.get(`${pending.key}:${pending.control}`),
            controls.current.get(`${pending.key}:${pending.control === "up" ? "down" : "up"}`),
            controls.current.get(`${pending.key}:remove`),
          ];
    const target = candidates.find((candidate) => candidate && !candidate.disabled && candidate.isConnected);
    target?.focus({ preventScroll: true });
  });

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= entries.length) {
      return;
    }
    const next = [...entries];
    const [moved] = next.splice(index, 1);
    if (!moved) {
      return;
    }
    next.splice(target, 0, moved);
    pendingFocus.current = { key: rows[index]?.key ?? "", control: delta < 0 ? "up" : "down" };
    onChange(next);
  };

  const remove = (index: number) => {
    const following = rows[index + 1] ?? rows[index - 1] ?? null;
    pendingFocus.current = following ? { key: following.key, control: "remove" } : { key: null, control: "add" };
    onChange(entries.filter((_, position) => position !== index));
  };

  const add = (key: string) => {
    const choice = choices.find((candidate) => candidate.key === key);
    setMenuOpen(false);
    if (!choice || atLimit) {
      return;
    }
    pendingFocus.current = { key: null, control: "add" };
    onChange([...entries, choice.signIn]);
  };

  const controlRef = (key: string, control: "up" | "down" | "remove") => (node: HTMLButtonElement | null) => {
    controls.current.set(`${key}:${control}`, node);
  };

  const note = atLimit
    ? `An agent can have up to ${max} backups.`
    : rows.length === 0 && choices.length === 0
      ? "Connect another AI in Connections to use it here."
      : null;

  return (
    <div className="space-y-2" role="group" aria-labelledby={headingId} aria-describedby={hintId} data-testid="agent-profile-backups">
      <div className="space-y-1">
        <Text as="h4" id={headingId} variant="fieldLabel" tone="secondary">
          Backups
        </Text>
        <Text as="p" id={hintId} variant="caption" tone="muted">
          Once this agent&apos;s AI reaches its plan&apos;s limit, its next turns use the first backup with room, and go
          back once the limit resets.
        </Text>
      </div>
      {rows.length > 0 ? (
        <ol
          className="divide-y divide-slate-200/70 overflow-hidden rounded-xl border border-slate-200/70 dark:divide-[color:var(--color-studio-dark-divider)] dark:border-[color:var(--color-studio-dark-divider)]"
          data-testid="agent-profile-backup-list"
        >
          {rows.map((row, index) => (
            <li
              key={row.key}
              className="flex min-w-0 items-center gap-2 py-1.5 pl-3 pr-1.5"
              data-testid={`agent-profile-backup-${index}`}
            >
              <Text as="span" variant="caption" tone="subtle" className="w-4 flex-none tabular-nums" aria-hidden="true">
                {index + 1}
              </Text>
              <div className="min-w-0 flex-1">
                <Text as="p" variant="bodyCompact" tone="primary" className="truncate" data-testid="agent-profile-backup-label">
                  {row.label}
                </Text>
                {row.description ? (
                  <Text as="p" variant="caption" tone="muted" className="truncate">
                    {row.description}
                  </Text>
                ) : null}
              </div>
              <div className="flex flex-none items-center">
                <IconButton
                  ref={controlRef(row.key, "up")}
                  variant="ghost"
                  size="sm"
                  radius="full"
                  aria-label={`Move ${row.label} up`}
                  isDisabled={disabled || index === 0}
                  onPress={() => move(index, -1)}
                  data-testid={`agent-profile-backup-up-${index}`}
                >
                  <NavArrowUp className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton
                  ref={controlRef(row.key, "down")}
                  variant="ghost"
                  size="sm"
                  radius="full"
                  aria-label={`Move ${row.label} down`}
                  isDisabled={disabled || index === rows.length - 1}
                  onPress={() => move(index, 1)}
                  data-testid={`agent-profile-backup-down-${index}`}
                >
                  <NavArrowDown className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton
                  ref={controlRef(row.key, "remove")}
                  variant="ghost"
                  size="sm"
                  radius="full"
                  aria-label={`Remove ${row.label}`}
                  isDisabled={disabled}
                  onPress={() => remove(index)}
                  data-testid={`agent-profile-backup-remove-${index}`}
                >
                  <Xmark className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <MenuTrigger isOpen={menuOpen} onOpenChange={setMenuOpen}>
          <Button
            ref={addRef}
            variant="ghost"
            size="sm"
            radius="xl"
            icon={<Plus className="h-4 w-4" aria-hidden="true" />}
            isDisabled={disabled || atLimit || choices.length === 0}
            data-testid="agent-profile-backup-add"
          >
            Add a backup
          </Button>
          <StudioPopover placement="bottom start" layout="menu" className="w-72" data-testid="agent-profile-backup-add-menu">
            <StudioMenu aria-label="Add a backup" onAction={(key) => add(String(key))}>
              {choices.map((choice) => (
                <StudioMenuItem key={choice.key} id={choice.key} textValue={choice.label}>
                  <MenuItemContent description={choice.description ?? undefined}>{choice.label}</MenuItemContent>
                </StudioMenuItem>
              ))}
            </StudioMenu>
          </StudioPopover>
        </MenuTrigger>
        {note ? (
          <Text as="p" variant="caption" tone="muted" data-testid="agent-profile-backup-note">
            {note}
          </Text>
        ) : null}
      </div>
    </div>
  );
}
