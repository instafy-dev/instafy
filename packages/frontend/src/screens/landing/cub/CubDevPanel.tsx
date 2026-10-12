import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "../../../theme/ThemeProvider";
import { getLandingLayoutOverride, setLandingLayoutOverride, subscribeLandingLayoutOverride } from "../landingDeckLayout";
import type { CubPublicState } from "./cubTypes";
import type { LandingCubController, LandingCubDevOptions } from "./landingCub";

// The owner's Cub playground on the landing. Dev builds only: LandingCub.tsx
// imports this module behind import.meta.env.DEV, so production builds never
// contain it. A floating "Cub" button opens a small panel of switches;
// ?cub-dev=1 opens it on load and ?cub-dev=0 hides the button.

type Dots = "shipped" | "crew" | "ink";
type TurnMode = "live" | "scrub" | "still";

const DOTS_ATTR = "data-cub-dev-dots";
// Overrides the header logo's crew rule (OctoMark colorway) for review. Lives
// only while the panel is mounted.
const DOTS_CSS = `
html[${DOTS_ATTR}="ink"] .octo-mark--crew { --octo-dot-1: currentColor; --octo-dot-2: currentColor; --octo-dot-3: currentColor; --octo-dot-4: currentColor; }
html[${DOTS_ATTR}="crew"] .octo-mark--crew { --octo-dot-1: var(--crew-1); --octo-dot-2: var(--crew-2); --octo-dot-3: var(--crew-3); --octo-dot-4: var(--crew-4); }
`;

const TURN_SECONDS = 11;

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span>
      <div role="group" aria-label={label} className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-white/15">
        {options.map(([key, text]) => (
          <button
            key={key}
            type="button"
            aria-pressed={value === key}
            onClick={() => onChange(key)}
            className={`rounded-md px-2 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-500 ${
              value === key
                ? "bg-brand-ink text-white dark:bg-slate-100 dark:text-slate-900"
                : "text-slate-600 hover:text-brand-ink dark:text-slate-300 dark:hover:text-white"
            }`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-between gap-3">{children}</div>;
}

// Stills render at a neutral sim time, well after the hello (whose happy
// squint would otherwise close his eyes in every still), like the prototype's
// ?still=1&t=30000 idle frame.
const STILL_SIM_T = 30;

export default function CubDevPanel({
  initiallyOpen,
  controller,
  generation,
  options,
  onOptionsChange,
  scrubTd,
  onScrubChange,
}: {
  initiallyOpen: boolean;
  controller: () => LandingCubController | null;
  /** Changes whenever a fresh engine is mounted, so live switches are applied again. */
  generation: number;
  options: LandingCubDevOptions;
  onOptionsChange: (next: LandingCubDevOptions) => void;
  scrubTd: number | null;
  onScrubChange: (td: number | null) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [motion, setMotion] = useState(true);
  const [overlay, setOverlay] = useState(false);
  const [dots, setDots] = useState<Dots>("shipped");
  const [turnMode, setTurnMode] = useState<TurnMode>(options.still ? "still" : scrubTd != null ? "scrub" : "live");
  const [td, setTd] = useState(options.still?.td ?? scrubTd ?? 3);
  const [state, setState] = useState<CubPublicState | null>(null);
  const { themeMode, setThemeMode } = useTheme();
  // The example's layout: the studio's own rule (side by side from a 1184px
  // viewport) or one view at every width, for review.
  const deckLayout = useSyncExternalStore(subscribeLandingLayoutOverride, getLandingLayoutOverride, () => null);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Live switches survive an engine remount.
  useEffect(() => {
    const handle = controller()?.handle;
    if (!handle) return;
    handle.setMotion(motion);
    handle.dev?.setOverlay(overlay);
  }, [controller, generation, motion, overlay]);

  useEffect(() => {
    const root = document.documentElement;
    const style = document.createElement("style");
    style.textContent = DOTS_CSS;
    document.head.appendChild(style);
    return () => {
      style.remove();
      root.removeAttribute(DOTS_ATTR);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (dots === "shipped") root.removeAttribute(DOTS_ATTR);
    else root.setAttribute(DOTS_ATTR, dots);
  }, [dots]);

  useEffect(() => {
    if (!open) return;
    const read = () => setState(controller()?.handle.getState() ?? null);
    read();
    const timer = setInterval(read, 500);
    return () => clearInterval(timer);
  }, [open, controller]);

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const setOption = (patch: Partial<LandingCubDevOptions>) => onOptionsChange({ ...options, ...patch });

  const chooseTurn = (mode: TurnMode) => {
    setTurnMode(mode);
    onScrubChange(mode === "scrub" ? td : null);
    setOption({ still: mode === "still" ? { t: STILL_SIM_T, td } : null });
  };

  const moveTd = (next: number) => {
    setTd(next);
    if (turnMode === "scrub") onScrubChange(next);
    // A still is a fresh deterministic frame; it re-renders on release.
  };

  const commitStill = () => {
    if (turnMode === "still") setOption({ still: { t: STILL_SIM_T, td } });
  };

  return createPortal(
    // Bottom left: Cub perches on the right, so the panel never hides him (on a
    // phone it is capped low enough to leave him in view).
    <div className="fixed bottom-4 left-4 z-[90] flex flex-col items-start gap-2 font-sans" data-testid="cub-dev">
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-label="Cub playground"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
          className="max-h-[40vh] w-[19rem] space-y-2.5 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-3.5 text-slate-800 shadow-card-lg md:max-h-none md:overflow-visible dark:border-white/10 dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-100"
        >
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-semibold">Cub playground</p>
            <p className="font-mono text-[10.5px] text-slate-500 dark:text-slate-400" aria-live="polite">
              {state ? `${state.status} · ${state.mode} · u ${state.u.toFixed(0)}` : "loading"}
            </p>
          </div>
          <Segmented
            label="Theme"
            value={themeMode}
            options={[
              ["light", "Light"],
              ["dark", "Dark"],
              ["system", "System"],
            ]}
            onChange={setThemeMode}
          />
          <Segmented label="Motion" value={motion ? "on" : "off"} options={[["on", "On"], ["off", "Off"]]} onChange={(v) => setMotion(v === "on")} />
          <Segmented
            label="Eyes"
            value={options.eyes === false ? "off" : "on"}
            options={[["on", "On"], ["off", "Off"]]}
            onChange={(v) => setOption({ eyes: v === "on" })}
          />
          <Segmented
            label="Click"
            value={options.clickInk === false ? "none" : "ink"}
            options={[["ink", "Ink"], ["none", "None"]]}
            onChange={(v) => setOption({ clickInk: v === "ink" })}
          />
          <Segmented
            label="Splash"
            value={options.splash ?? "apart"}
            options={[["apart", "Four splats"], ["together", "One burst"]]}
            onChange={(v) => setOption({ splash: v })}
          />
          <Segmented
            label="Logo dots"
            value={dots}
            options={[["shipped", "Shipped"], ["crew", "Crew"], ["ink", "Ink"]]}
            onChange={setDots}
          />
          <Segmented
            label="Example"
            value={deckLayout === "single" ? "single" : "auto"}
            options={[["auto", "Side by side"], ["single", "One view"]]}
            onChange={(v) => setLandingLayoutOverride(v === "single" ? "single" : null)}
          />
          <Segmented label="Overlay" value={overlay ? "on" : "off"} options={[["on", "On"], ["off", "Off"]]} onChange={(v) => setOverlay(v === "on")} />
          <Segmented
            label="Renderer"
            value={options.noGl ? "fallback" : "webgl"}
            options={[["webgl", "WebGL"], ["fallback", "Fallback"]]}
            onChange={(v) => setOption({ noGl: v === "fallback" })}
          />
          <Segmented
            label="Turn"
            value={turnMode}
            options={[["live", "Live"], ["scrub", "Scrub"], ["still", "Still"]]}
            onChange={chooseTurn}
          />
          {turnMode !== "live" ? (
            <Row>
              <label htmlFor={`${panelId}-td`} className="text-xs font-medium text-slate-600 dark:text-slate-300">
                Turn time
              </label>
              <input
                id={`${panelId}-td`}
                type="range"
                min={0}
                max={TURN_SECONDS}
                step={0.05}
                value={td}
                onChange={(event) => moveTd(Number(event.target.value))}
                onPointerUp={commitStill}
                onKeyUp={commitStill}
                className="w-32 accent-primary-600"
              />
              <span className="w-10 text-right font-mono text-[11px] tabular-nums">{td.toFixed(2)}</span>
            </Row>
          ) : null}
          <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
            Scrub and Still move Cub only; the example keeps its own turn.
          </p>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => controller()?.handle.dev?.replayHello()}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium hover:border-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-500 dark:border-white/15 dark:hover:border-white/30"
            >
              Replay hello
            </button>
            <button
              type="button"
              onClick={() => controller()?.handle.boop()}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium hover:border-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-500 dark:border-white/15 dark:hover:border-white/30"
            >
              Boop
            </button>
          </div>
        </div>
      ) : null}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        className="rounded-full border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-brand-ink shadow-card-lg hover:border-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 dark:border-white/15 dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-100"
      >
        Cub
      </button>
    </div>,
    document.body,
  );
}
