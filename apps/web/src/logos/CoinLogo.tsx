import type { SymbolId } from '@tradingnerd/core';
import { useEffect, useState } from 'react';
import { logoUrl, useLogos } from './LogoContext';

/**
 * A coin's round logo, or a letter avatar until (or unless) one loads. `base` is null while the
 * symbol is still being looked up, and for symbols the exchange doesn't list.
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
  const src = base !== null && version !== null ? logoUrl(symbol, base, version) : null;
  const [loaded, setLoaded] = useState<string | null>(null);

  useEffect(() => {
    if (loaded !== null && loaded !== src) setLoaded(null);
  }, [loaded, src]);

  const showing = src !== null && loaded === src;
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
