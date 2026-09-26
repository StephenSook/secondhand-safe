/** Two crossing tilted marquee bands, the three states as a chant. CSS only; paused under reduced motion. */
const A = "HELD until the camera has seen it ✦ CAPTURED when the label is clean ✦ REVERSED when it is recalled ✦ ";
const B = "Checked against CPSC and NHTSA recalls ✦ inclined sleepers ✦ crib bumpers ✦ drop-side cribs ✦ never just 'safe' ✦ ";

function Band({ text, className, reverse }: { text: string; className: string; reverse?: boolean }) {
  return (
    <div className={`py-4 border-y-[3px] border-ink overflow-hidden ${className}`}>
      <div className="marquee-track flex" style={reverse ? { animationDirection: "reverse" } : undefined}>
        {[0, 1].map((k) => (
          <span key={k} className="display text-[clamp(1.4rem,2.6vw,2.4rem)] whitespace-nowrap pr-8" aria-hidden={k === 1}>
            {text.repeat(3)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Ribbons() {
  return (
    <div className="relative h-[16rem] my-4 overflow-hidden" role="presentation">
      <Band text={A} className="absolute inset-x-[-5%] top-16 bg-amber -rotate-3" />
      <Band text={B} className="absolute inset-x-[-5%] top-24 bg-aqua rotate-2" reverse />
    </div>
  );
}
