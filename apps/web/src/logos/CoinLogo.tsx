import { CRYPTOCAP, type SymbolId } from '@tradingnerd/core';
import { useEffect, useState } from 'react';
import { CryptoCapBadge } from './CryptoCapBadge';
import { logoUrl, useLogos } from './LogoContext';

/**
 * A coin's round logo, or a letter avatar until (or unless) one loads. `base` is null while the
 * symbol is still being looked up, and for symbols the exchange doesn't list. CRYPTOCAP's
 * symbols of many coins (TOTAL, OTHERS.D) show CRYPTOCAP's badge.
 */
export function CoinLogo({
  symbol,
  base,
  letter,
  className,
}: {
  symbol: SymbolId;
  base: string | null;
  letter: string;
  className?: string | undefined;
}) {
  const { version } = useLogos();
  const src =
    base !== null && base !== CRYPTOCAP && version !== null ? logoUrl(symbol, base, version) : null;
  const [loaded, setLoaded] = useState<string | null>(null);

  useEffect(() => {
    if (loaded !== null && loaded !== src) setLoaded(null);
  }, [loaded, src]);

  const showing = src !== null && loaded === src;
  if (base === CRYPTOCAP && symbol.startsWith(`${CRYPTOCAP}:`)) {
    return (
      <span className={className} data-logo aria-hidden>
        <CryptoCapBadge />
      </span>
    );
  }
  return (
    <span className={className} data-logo={showing || undefined} aria-hidden>
      {!showing && letter}
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          hidden={!showing}
          onLoad={() => setLoaded(src)}
          onError={() => setLoaded(null)}
        />
      )}
    </span>
  );
}
