import { useId } from "react";
import { ORG_ACCENTS, normalizeOrgAccent, type OrgAccent } from "../../../org/orgAccent";
import "../../../components/OrgIdentity.css";

export function TeamAccentPicker({ value, onChange, disabled = false }: {
  value?: string | null;
  onChange: (color: OrgAccent) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return <fieldset disabled={disabled} className="min-w-0 space-y-2" data-testid="team-accent-picker">
    <legend className="text-sm font-medium text-slate-900 dark:text-slate-100">Team color</legend>
    <div className="flex flex-wrap gap-1">
      {ORG_ACCENTS.map(color => {
        const label = color === "slate" ? "Neutral" : color[0].toUpperCase() + color.slice(1);
        return <label key={color} title={label} data-org-accent={color}
          className={`org-accent-choice relative flex h-11 w-11 items-center justify-center ${disabled ? "opacity-60" : "cursor-pointer"}`}>
          <input type="radio" className="sr-only" name={name} value={color} aria-label={label}
            checked={(normalizeOrgAccent(value) ?? "slate") === color} onChange={() => onChange(color)} />
          <span aria-hidden="true" className="org-accent-swatch h-5 w-5 rounded-full" />
        </label>;
      })}
    </div>
    <p className="text-xs text-slate-500 dark:text-slate-400">Shared with your team. Adapts to light and dark mode.</p>
  </fieldset>;
}
