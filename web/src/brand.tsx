// The Nusuh Books mark: a rounded "N" with the amber dot above its right stem, over the underline bar.
// Drawn as SVG so it stays sharp at any size and follows light and dark mode through the theme colours.

/** The mark on its own. `size` is the drawn width and height in pixels. */
export function NusuhMark({ size = 30, title }: { size?: number; title?: string }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 64 64" fill="none"
      role={title ? 'img' : 'presentation'} aria-hidden={title ? undefined : true} aria-label={title}>
      {title && <title>{title}</title>}
      {/* the underline bar, behind the letter */}
      <path d="M14 55h36" stroke="var(--brandbar)" strokeWidth="4.5" strokeLinecap="round" />
      {/* the N: left stem up, diagonal down, right stem up (stops short to leave room for the dot) */}
      <path d="M20 45V22l20 23V28" stroke="var(--teal)" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
      {/* the dot */}
      <circle cx="40" cy="14" r="5.5" fill="var(--amber)" />
    </svg>
  );
}

/** The mark with "Nusuh Books" beside it, for the top of the sidebar. */
export function BrandMark({ name, subtitle }: { name: string; subtitle?: string }) {
  return (
    <div className="brand">
      <NusuhMark size={34} />
      <span className="brand-words">
        <b>{name}</b>
        {subtitle && <span>{subtitle}</span>}
      </span>
    </div>
  );
}
