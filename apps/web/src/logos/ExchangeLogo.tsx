import { type CSSProperties, useEffect, useState } from 'react';
import { exchangeLogoUrl, useLogos } from './LogoContext';

/** An exchange's round logo, or the first letter of its name until (or unless) one loads. */
export function ExchangeLogo({
  exchange,
  name,
  className,
  style,
}: {
  /** "BINANCE" */
  exchange: string;
  /** "Binance" */
  name: string;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}) {
  const { version } = useLogos();
  const src = version !== null ? exchangeLogoUrl(exchange, version) : null;
  const [loaded, setLoaded] = useState<string | null>(null);

  useEffect(() => {
    if (loaded !== null && loaded !== src) setLoaded(null);
  }, [loaded, src]);

  const showing = src !== null && loaded === src;
  return (
    <span className={className} style={style} data-logo={showing || undefined} aria-hidden>
      {!showing && name.charAt(0)}
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
