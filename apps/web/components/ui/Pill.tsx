"use client";

/**
 * A small bordered status badge. Outline only — a filled badge would compete
 * with the figures beside it, and on this board colour means something.
 *
 * The caller supplies the colour pair, because what a status *means* is the
 * caller's business: "verified" is verdigris in the chaos bench and "captured"
 * is verdigris in an order list for the same reason, but neither knows that
 * about the other.
 */
export function Pill({
  children,
  className = "border-rule text-paper-faint",
  size = "sm",
  title,
}: {
  children: React.ReactNode;
  className?: string;
  size?: "sm" | "md";
  title?: string;
}) {
  const dims = size === "sm" ? "px-2 py-0.5 tracking-[0.12em]" : "px-2 py-1 tracking-[0.14em]";

  return (
    <span
      title={title}
      className={`figures shrink-0 border text-[10px] uppercase ${dims} ${className}`}
    >
      {children}
    </span>
  );
}
