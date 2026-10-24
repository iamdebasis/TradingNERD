/**
 * TradingView's market status icons (its release notes: "an orange sunrise icon for pre-market
 * and a blue moon icon for post-market"). The sunrise is traced from a TradingView screenshot:
 * a half sun on the horizon with five rays, about 14 × 9 px. The moon's shape is provisional
 * (docs/SPEC.md §11). Both draw in currentColor.
 */

export function SunriseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="10"
      viewBox="0 0 14 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M3.5 9.25a3.5 3.5 0 0 1 7 0Z" fill="currentColor" stroke="none" />
      <path d="M7 0.75v1.5M2.4 2.6l1 1M11.6 2.6l-1 1M0.75 7h1.5M11.75 7h1.5" />
    </svg>
  );
}

export function MoonIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M6.6 0.6a4.6 4.6 0 1 0 2.8 6.4A3.8 3.8 0 0 1 6.6 0.6Z" fill="currentColor" />
    </svg>
  );
}
