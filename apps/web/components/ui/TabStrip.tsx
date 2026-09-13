"use client";

/**
 * The bordered segmented control used wherever this board offers two ways to
 * look at the same thing. Active is filled rather than outlined, so the choice
 * reads at a glance on a dark ground.
 *
 * Extracted at its third use. The first two (the theatre/chaos switch and the
 * scripted/Claude switch) were copies of each other.
 */

export interface Tab<T extends string> {
  id: T;
  label: string;
  /** Tooltip. Worth setting when a tab can be disabled, to say why. */
  title?: string;
  disabled?: boolean;
}

export function TabStrip<T extends string>({
  tabs,
  value,
  onChange,
  disabled = false,
  size = "md",
  className = "",
}: {
  tabs: readonly Tab<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Disables every tab. For "a run is in flight, do not switch views". */
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const pad = size === "sm" ? "px-2.5 py-1" : "px-3 py-1";

  return (
    <div className={`flex items-center gap-1 border border-rule p-0.5 ${className}`}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          disabled={disabled || (t.disabled ?? false)}
          title={t.title}
          aria-pressed={value === t.id}
          className={`${pad} font-mono text-[11px] uppercase tracking-[0.12em] transition-colors disabled:opacity-30 ${
            value === t.id ? "bg-rule text-paper" : "text-paper-faint hover:text-paper-dim"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
