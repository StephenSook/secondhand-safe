/** Our mark: a shield holding a crib with a check. Drawn here in SVG so it scales and animates. */
export function Mark({ size = 48, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true">
      <path d="M32 3 55 11v19c0 15-10 26-23 31C19 56 9 45 9 30V11z" fill="var(--ink)" />
      <path d="M32 8 50 14.5V30c0 12-8 21-18 25.5C22 51 14 42 14 30V14.5z" fill="var(--amber)" />
      <g stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" fill="none">
        <path d="M21 25v17M43 25v17M21 29h22M21 40h22" />
        <path d="M26 29v11M31 29v11M36 29v11" strokeWidth="2" />
      </g>
      <circle cx="46" cy="44" r="9" fill="var(--green)" stroke="var(--ink)" strokeWidth="2.5" />
      <path d="m41.5 44 3 3 6-6.5" stroke="var(--paper)" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
