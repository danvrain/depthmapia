"use client";

/**
 * A row of mutually exclusive options. Replaces the native selects, whose
 * labels were truncated in a narrow panel and could not show what each
 * option does.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid gap-1 rounded-md border border-[var(--color-edge)] bg-white/[0.02] p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map(([key, text]) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(key)}
            className={[
              "truncate rounded-[4px] px-2 py-1.5 text-[13px] transition-colors duration-200",
              active
                ? "bg-[var(--color-brand)] font-medium text-black shadow-[0_0_20px_rgb(68_228_220/0.25)]"
                : "text-white/55 hover:bg-white/[0.06] hover:text-white/90",
              disabled ? "cursor-not-allowed" : "",
            ].join(" ")}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}
