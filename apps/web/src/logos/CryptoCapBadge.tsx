/**
 * CRYPTOCAP's icon, for its market caps of many coins (TOTAL, OTHERS) and as its source's logo:
 * a C holding three bars, white on the accent blue, drawn after TradingView's (its blue
 * measured #2A62FF in the user's screenshot 21, the accent).
 */
export function CryptoCapBadge() {
  return (
    <svg viewBox="0 0 18 18" width="100%" height="100%" aria-hidden="true" focusable="false">
      <circle cx="9" cy="9" r="9" fill="#2962FF" />
      <g fill="none" stroke="#FFFFFF" strokeLinecap="round">
        <path d="M12.3 5.9A4.6 4.6 0 1 0 12.3 12.1" strokeWidth="1.4" />
        <path d="M7.4 7.3h3.8M6.9 9h5.5M7.4 10.7h3.8" strokeWidth="1.1" />
      </g>
    </svg>
  );
}
