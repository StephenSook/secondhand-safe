# Aardvark Book Club: motion and design reference for SecondHand Safe

Source: https://www.aardvarkbookclub.com/ (Webflow). Studied 2026-09-26 from two inputs:

1. The owner's saved page, `/Users/stephensookra/dev/Multi-App AI Agent Hackathon/frontend gt hacks` (33,328 lines). The site's custom motion code (the Slater script `slater.app/18601/54937.js`) is inlined at lines 27780 to 33314. Lines 33318 onward are the owner's own notes, not site code.
2. The live site, driven with Playwright at 1440x900 and 390x844, plus the two live stylesheets (`aardvark-book-club.webflow.shared.168a29904.min.css` and `slater.app/18601/54934.css`) fetched for tokens.

Rule for us: reuse TECHNIQUES only. Their photos, 3D book and box renders, frame sequences, illustrations, logo, mask shapes and the three commercial fonts are theirs. Everything below is either a technique description, a parameter value (numbers are not ownable), or our own adaptation.

Correction to the brief: `initScroll`, `READY_CLASS` and `FONTS_LOADED_CLASS` exist only inside a commented-out legacy block (lines 33276 to 33312). They do not run. The live preloader is a Barba.js `once` transition (`runPageOnceAnimation`, line 28392). The matching CSS gate `html:not(.is-ready.fonts-loaded)` in `slater.css` is also commented out.

---

## 1. Stack actually used

Verified from `document.scripts` on the live page and the saved HTML.

| Library | Version | Role |
|---|---|---|
| GSAP core | 3.15.0 (`gsap.version`) | every tween and timeline |
| ScrollTrigger | 3.15 | scroll reveals, scrubbed parallax, sequence scrub |
| SplitText | 3.15 | word and character splits for headline, handwriting and button text |
| CustomEase | 3.15 | three named eases (below) |
| DrawSVGPlugin | 3.15 | the preloader and page-transition stroke wipe |
| InertiaPlugin | 3.15 | momentum hover (velocity-driven throw and settle) |
| Lenis | 1.3.17 | smooth scroll, `lerp: 0.2, autoRaf: true, anchors: true` |
| Barba.js core + prefetch | 2.10.3 / 2.2.0 | page transitions, `sync: true`, prefetch `timeout: 2500` |
| Smooothy | 0.0.35 | draggable book sliders (subclassed as `ParallaxSlider`, `CenterSlider`) |
| MiniSearch | 7.1.2 | site search |
| jQuery | 3.5.1 | Webflow runtime only |

Setup lines worth copying verbatim in spirit (line 27780 onward):

```js
gsap.registerPlugin(ScrollTrigger, SplitText, CustomEase, InertiaPlugin, DrawSVGPlugin);
history.scrollRestoration = "manual";
CustomEase.create("osmo", "0.625, 0.05, 0, 1");
CustomEase.create("path-ease", "0.78, 0.18, 0.18, 1");
CustomEase.create("energy", "M0,0 C0.32,0.72 0,1 1,1");
gsap.defaults({ ease: "osmo", duration: 0.6 });   // staggerDefault 0.05
lenis.on("scroll", ScrollTrigger.update);
```

Architecture pattern: every effect is a `data-*` attribute plus an `initX()` function, registered in two phases. `initBeforeEnterFunctions` (background animation, hero sequence, buttons) runs before the reveal; `initAfterEnterFunctions` (callout, handwriting, footer parallax, sliders, badge, benefits, momentum hover, box sequence, plop-in, emoji rain, tagline curve, and more) runs after. Each guards itself with `has("[data-x]")`. This is the cleanest thing to steal: it maps directly to React hooks or a small `useGsapEffect("[data-x]", init)` registry.

Accessibility discipline they apply everywhere: `gsap.matchMedia()` with `(prefers-reduced-motion: no-preference)`, hover effects gated on `(hover: hover) and (pointer: fine)`, focus-visible triggers the same button animation as hover, and the scrubbed image sequences fall back to a single static frame under reduced motion.

## 2. Fonts

Measured with `getComputedStyle` and `document.fonts` on the live page.

| Role | Family | Weight | Live size at 1440 | Notes |
|---|---|---|---|---|
| Display h1/h2 | Champ | 700 (ExtraBold, woff) | h1 120px / line-height 96px (0.8) / tracking -1.2px; h2 78px / 62.4px | ultra-heavy rounded grotesque |
| Body, UI, buttons | Degular | 500/600/700 | p 18px / 21.6px / -0.36px, weight 600; button 15px weight 700 | body default weight is 600, which is part of the chunky feel |
| Handwritten asides | Hello Organichand Webfont | 400 | 24px / 24px / -0.48px, color #3b308f | used for small tilted annotations |

All three are commercial. Do not self-host their files. Free stand-ins to evaluate (my suggestion, not verified against their metrics): display, Bricolage Grotesque 800 or Rubik 900 with tight tracking and line-height 0.8; body, Figtree or Onest at 600; handwriting, Caveat, Gochi Hand or Nanum Pen Script.

Type scale is fluid. `--size-font = calc(clamp(992px, 100vw, 3840px) / (1920 / 16))`, set on `body`, and every size is in `em` from there (`--font-size-heading-xxl: 10em`, `-l: 6.5em`, `-m: 5em`, `-s: 2.5em`, `-xs: 1.875em`; paragraph `2em / 1.75em / 1.5em / 1.25em / 1.125em`; handwritten `2.5em / 2em`). Breakpoints swap the "ideal" container (834, 550, 402) and a few sizes, so the whole layout scales like a poster.

## 3. Color system

From the Webflow `:root` (hex exact):

- Brand: violet `#3b308f` (preloader and footer background, handwriting color), magenta `#ff008c` (primary CTA), yellow `#ffd24a` (hero), pale yellow `#faed8f` (nav pills), orange `#f9a220`.
- Loud accents: bright pink `#fd48f2`, cyan `#1ce8ed`, periwinkle `#9982de`, green `#2de124`, wine `#670a2e`, olive `#857521`.
- Soft section backgrounds: soft pink `#ffdbfd`, soft blue `#ddfcfc`, pale blue `#a4f6f8`, soft orange `#fddaa6`, soft periwinkle `#d7cdf1`, soft wine `#f0e6ea`, soft grey `#f2f2f2`.
- Text is pure `#000`; `initCheckContrast` flips text to black or white by luminance `(0.299r + 0.587g + 0.114b)/255 > 0.5`.

Pattern: each section is a full-bleed saturated block with rounded corners, so scrolling reads as a stack of colored cards (hero yellow, books white, flow soft pink, box pale cyan, genre bright pink, benefits pale yellow, footer violet).

## 4. Spacing, radius, shape

- 12-column grid, `--grid-margin: 1.5em`, gutter 0 (5 columns, 1em gutter at tablet).
- Radii: `2em` most common (buttons and cards), `1em`, `1.5em`, `0.5em` (alt button), `50%` pills. Section shapes come from `clip-path: inset(0 round 0 0 10em 10em)` and `inset(0 round 2.5em)`, so section bottoms have huge 10em curves.
- Nav pills: 3.5em tall, radius 2em. Alt button: split into a text block and a separate square icon block, radius 0.5em.
- Everything slightly rotated: cards, badges and book covers sit at 1.5 to 4 degrees, randomized per item.

## 5. Easing and duration vocabulary

GSAP (JS):

| Name | Definition | Used for |
|---|---|---|
| `osmo` (global default) | cubic-bezier 0.625, 0.05, 0, 1 | default for every tween, 0.6s |
| `energy` | M0,0 C0.32,0.72 0,1 1,1 | paragraphs, buttons, header drop, CTA slide |
| `path-ease` | 0.78, 0.18, 0.18, 1 | reserved for paths |
| `elastic.out(1, 0.72)` / `(1, 0.75)` | built-in | the signature: words, chars, cards, logo pop |
| `elastic.out(1, 0.4)` | built-in | button character bounce |
| `circ.out` | built-in | clip-path ellipse reveal, stroke thickening |
| `expo.out` | built-in | hero sequence scale-in |
| `sine.inOut` | built-in | 3s breathing background |

CSS (`slater.css` `:root`):

```css
--ease-smooth: cubic-bezier(0.32, 0.72, 0, 1);
--ease-soft-overshoot: cubic-bezier(0.59, 1, 0.88, 1.01);
--ease-bounce: cubic-bezier(0.34, 1.57, 0.64, 1);
--button-ease-bounce: cubic-bezier(0.34, 2.27, 0.64, 1);
--ease-soft-bounce: cubic-bezier(0.34, 1.17, 0.64, 1);
--ease-click: cubic-bezier(0.4, 0, 0.2, 1);
--pop-up-ease-overshoot: cubic-bezier(.17, .67, .3, 1.3);
--ease-elastic-out: linear(0, 0.5737 7.6%, 0.8382 11.87%, 0.9463 14.19%, 1.0292 16.54%, 1.0886 18.97%, 1.1258 21.53%, 1.137 22.97%, 1.1424 24.48%, 1.1423 26.1%, 1.1366 27.86%, 1.1165 31.01%, 1.0507 38.62%, 1.0219 42.57%, 0.9995 46.99%, 0.9872 51.63%, 0.9842 58.77%, 1.0011 81.26%, 1);
```

Durations cluster at 0.15s (press/squash), 0.35s (small UI), 0.6s (default), 0.75 to 0.95s (elastic reveals), 1.1 to 1.25s (preloader path and clip reveal). Staggers: 0.088 words, 0.016 chars (0.011 in the box sequence), 0.072 benefit pills.

The feel in one sentence: nothing slides in linearly; things arrive squashed, rotated and small, then overshoot on an elastic into place.

---

## 6. Technique catalogue

Effort: S = under 1 hour, M = 1 to 3 hours, L = half a day or more.

### 1. Preloader: fat stroke wipe with elastic logo pop (M)

What it does (observed in slow motion, `slowmo-preload-*.png`): the screen starts solid violet with the logo tiny. The logo pops in on an elastic, holds, then spins out. Meanwhile a single enormous stroked SVG path (the whole violet field is one path with `stroke-width: 70%`) "undraws" along its length, so the violet retreats as a wiggly ribbon and the page underneath is revealed through it. Then the header drops in and the hero cascades.

How (`runPageOnceAnimation`, line 28392; markup line 68):
- `[data-transition-wrap]` holds an `svg viewBox="0 0 1080 1080" preserveAspectRatio="none"` with one `path` using `stroke="currentColor" stroke-width="70%" stroke-linecap="round"`.
- `tl.set(path, { drawSVG: '0% 100%' })`, then `tl.to(path, { keyframes: { "95%": { strokeWidth: "8%", ease: "circ.out" }, "100%": { drawSVG: '100% 100%' } }, duration: 1.25, delay: 0.65 }, "start")`.
- Logo: from `{ scale: 0, rotate: -64, autoAlpha: 0 }` to `{ scale: 1, rotate: 0 }` 0.65s `elastic.out(1,0.72)`, then out to `{ scale: 0, rotate: 64 }` 0.6s `elastic.in(1,0.72)` with delay 0.5.
- Header `yPercent: -100 -> 0`, 0.5s `energy` at `start+=1.1`.
- Page-to-page (`runPageLeaveAnimation`) plays the same path in reverse (`drawSVG '0% 0%' -> '0% 100%'`, stroke grows to 70%) to cover the old page.

SecondHand Safe adaptation: the preloader IS the product. Start solid amber (HELD). Our mark (a simple shield or a crib outline with a checkmark we draw ourselves) pops in, then a barcode-scanner line sweeps across it, then the amber ribbon undraws to reveal the hero. Optional second beat: the ribbon's final sliver flashes green for 120ms before disappearing, a wink at CAPTURED. Keep total under 2s and skip entirely under reduced motion.

### 2. Headline word reveal: squashed, skewed, elastic (S)

How (line 28478 and 28763): `SplitText(title, { type: "words" })`, each word set to `{ transformOrigin: "top left", yPercent: -10, xPercent: 40, scaleY: 0.1, scaleX: 0.85, rotate: 8, opacity: 0 }`, then keyframes `10%: { opacity: 1 }`, `100%: { all zero, ease: "elastic.out(1,0.72)" }`, duration 0.875, stagger 0.088, delay 0.25, at `start+=1.1`. Paragraph and button follow with `y: "-0.75em" -> 0`, 0.35s `energy`, delays 0.45 and 0.525.

Adaptation: hero line "The money doesn't move until the camera has seen the item." Split by words; give "money" and "camera" a highlighter underline that draws on after the words land.

### 3. Handwritten character reveal (S)

What: small handwritten annotations write themselves one character at a time, each char tumbling in from a slight rotation.

How (`initHandwrittenTextInview`, line 32897): trigger `top 95%`; `SplitText(el, { type: "words, chars" })`; chars from `{ opacity: 0, rotate: 22, x: "-0.25em", y: "0.5em" }` to zero, `elastic.out(1, 0.75)`, duration 0.75, stagger 0.016. Words set `display: inline-block` so wraps do not break mid-word. Note: this is a character stagger on a handwriting FONT, not an SVG stroke draw. The actual stroke draw on the site is the preloader path (technique 1).

Adaptation: margin notes that sound like a careful parent: "held, not paid", "we read the label, not the listing", "checked against CPSC", "no inclined sleepers, ever". Color them in our ink color, tilt -4 to 6 degrees, place them beside each step of the story.

### 4. Hero clip-path ellipse reveal (S)

How (line 28473, 28755): desktop only (`min-width: 992px`). Hero background from `clipPath: "ellipse(20% 0% at 100% 100%)"` to `"ellipse(150% 130% at 100% 100%)"`, 1.1s `circ.out`, delay 0.2. The color blooms out of the bottom-right corner.

Adaptation: hero amber background blooms from the bottom right where the phone camera mock sits, as if the scan is lighting the page.

### 5. Breathing background blobs (S)

What: the big organic layered shapes behind each section slowly swell and relax.

How (`initBackgroundAnimation`, line 32746): each `[data-background-animation]` is an inline SVG of filled paths. GSAP tweens `attr: { "stroke-width": 0 -> 60 }` (35 for the small variant) and `rotate: 0 -> 2`, 3s `sine.inOut`, then back, `repeat: -1`. Because the stroke is the same color as the fill, animating stroke-width makes the blob grow and shrink. ScrollTrigger plays it only while on screen (`onEnter`/`onLeave` pause). Separate desktop and mobile SVGs (`is--desktop` / `is--mobile`).

Adaptation: seaside market theme. Draw 2 to 3 layered wave shapes of our own (sand, shallow water, deeper water) in tints of the section color. Hero uses amber tints; the CAPTURED section uses green tints; the REVERSED section uses red tints. Cheap and it makes every section feel alive.

### 6. Scroll-scrubbed image sequence on canvas (L)

What: the gift box rotates and opens as you scroll ("Think inside the box"). Handwritten text writes in at 30% progress, reverses at 60%, and the final title, text and store buttons pop at 81%.

How (`initBoxSequence`, line 30878): a `<canvas>` with `data-frames="120" data-digits="3" data-filetype="webp"` and desktop and mobile frame URLs. Frames load binary-search style (first, last, then midpoints) with `fetch` plus `createImageBitmap`, drawn "cover" at devicePixelRatio. `ScrollTrigger({ scrub: true, start: "top 85%", end: "bottom 80%" })` maps progress to a frame index, falling back to the nearest loaded frame. Text timelines play with `timeScale(1.5)` forward and `timeScale(3.5)` reverse at progress thresholds 0.3, 0.6, 0.81. The hero uses a sibling (`initHeroSequence`) that loops 120 frames at 24fps while in view instead of scrubbing.

Adaptation: this is the centerpiece of our How It Works. Render a short sequence of our own: a phone camera frames a car-seat label, a scan line passes, the label crops to a card, then a stamp lands. Scrub it with scroll. Thresholds: 0 to 0.3 "HELD" amber chip visible; 0.3 to 0.6 handwritten note "reading the label..."; 0.81 the verdict chip pops. Cheaper fallback (M instead of L): skip the frame sequence and scrub SVG layers (phone, label, scan line) with a pinned ScrollTrigger timeline.

### 7. Fanned card deck with hover focus (M)

What (`desk-callout-rest.png`, `desk-callout-hover-card3.png`): the four "How it works" step cards sit fanned with random tilt. Cards fly up from below on scroll. Hovering a region straightens that card, scales it to 1.075, and pushes neighbors' contents sideways.

How (`initCallout`, line 32793): initial random `xPercent/yPercent ±5`, `rotation ±7.5`. Entrance `yPercent: "+=150"`, 1.05s `elastic.out(1, 0.75)`, stagger 0.088, trigger `top 85%`, `once: true`. Mousemove divides the container width into N portions; the active card animates to `{ x/y 0, rotation 0, scale 1.075 }` 0.85s elastic, and other cards' inner content shifts `xPercent: 45 / (index - i)`. Mouseleave re-randomizes tilt (`rotation ±10`).

Adaptation: four step cards, one per state color. 1 Agree and hold (amber), 2 Meet and scan (neutral ink), 3 Check recalls and banned types (ink with small data icons), 4 Capture or reverse (split green/red). Hover straightens the card like picking it up to read.

### 8. Button hover: character squash plus body squash-and-stretch (S)

What (`desk-button-hover-120ms.png`): on hover each letter squashes down and tilts, then springs back; the pill squashes, the text block and the arrow block tilt in opposite directions.

How:
- JS (`initButton`, `initButtonAlt`, lines 33043 and 32940): SplitText chars, keyframes `20%: { yPercent: 55, scaleY: 0.3, rotate: 17, ease: "power2.in" }`, `100%: { 0, 1, 0, ease: "elastic.out(1,0.4)" }`, duration 0.725, stagger `amount: 0.225`. Restart on mouseenter and on `:focus-visible`; on leave snap back in 0.2s.
- CSS trick for the body: on hover set `scale: 0.955 0.925` (fast, 0.15s soft-overshoot) AND `transform: scale(1.0471204188, 1.0810810811)` (0.35s with 0.15s delay, bounce `cubic-bezier(0.34, 2.27, 0.64, 1)`). The two multiply to exactly 1, so the button squashes then bounces back to normal size. The alt button's text wrap does `translate 0.25em 0.125em; rotate 4deg` and the icon wrap `translate -0.5em 0.25em; rotate -18deg`, each cancelled by an opposite delayed transform. `:active` uses `scale: 0.955 0.925`.

Adaptation: all CTAs ("Try the live check", "See a reversal", "Judges: start here"). Primary button in Visa-adjacent deep blue or our ink; the arrow block carries the state color of what the button leads to.

### 9. Footer parallax reveal (S)

How (`initFooterParallax`, line 33146): desktop only (`min-width: 991px`). ScrollTrigger on the footer, `start: "clamp(top bottom)"`, `end: "clamp(top top)"`, `scrub: 0.2`. Top and bottom rows from `y: "-12.5em"` to 0; a visual from `{ scale: 0.9, xPercent: -35, y: "17.5em", rotate: 30 }` to identity; an overlay fades 0.55 to 0. The footer seems to slide out from under the section above while an object swings into place.

Adaptation: violet-equivalent deep navy footer. The swinging visual is our own illustrated stroller or car seat with a green "CAPTURED" tag swinging on a string. Footer copy: team, data sources (CPSC, NHTSA), repo link.

### 10. Curved scrolling tagline on an SVG path (S)

How (`initTaglineCurve`, line 31956): text on a `<textPath>` along a curved `<path>`; font size recomputed from SVG scale; `startOffset` tweened to a negative percentage with `scrub: 0.5`, `start: '-40% bottom'`, `end: '60% top'`. Also seen as the arc "Why Aardvark?" over the benefits badge.

Adaptation: an arc of text over the classifier section, "inclined sleepers · crib bumpers · drop-side cribs · recalled car seats ·", sliding along the curve as you scroll.

### 11. Promo ribbons (tilted marquee bands) (S)

What (`desk-scroll-13.png`): two tilted full-width bands (pink and cyan) with a repeated promo line crossing each other.

How: markup is two rotated strips with repeated text; I did not find a dedicated JS marquee function among the registered inits, so these appear to be CSS-driven or static rotated bands. I did not confirm whether they move.

Adaptation: two crossing bands, amber and green: "HELD until the camera has seen it · CAPTURED when clean · REVERSED when recalled ·". Animate with a CSS `translateX` loop; pause under reduced motion.

### 12. Pop-in stickers and badges (S)

How: `initPlopIn` (scale 0, rotate -20, `y: -4em` to scale 1, rotate 11, 0.7s `elastic.out(1, 0.72)`, trigger `top 80%`); `initGift` (rotate 30 scale 0 to rotate -21 scale 1, 0.95s); `initBenefits` (pills from random `rotate ±33`, scale 0, stagger 0.072, trigger `top 25%`); `initBadge` (two stacked items drop from `y -2em` and `-6em` with slight counter-rotations).

Adaptation: verdict stamps. RECALL_MATCH, BANNED_TYPE, NO_MATCH, UNREADABLE, NEEDS_CHECK as rubber-stamp pills that plop in with elastic rotation. Use benefits-style stagger for the "what we check" pill cloud (UPC lookup, label OCR, CPSC recalls, NHTSA car seat recalls, banned-type classifier, Visa hold).

### 13. Momentum hover with inertia (M)

How (`initMomentumBasedHover`, line 32090): track pointer velocity per RAF; on mouseenter compute torque from offset and velocity; `gsap.to(target, { inertia: { x: { velocity: clamp(velX*25), end: 0 }, y: {...}, rotation: { velocity: clamp(torque*15, ±60), end: 0 }, resistance: 160 } })`. Items get flicked by the cursor and spring home. Desktop fine pointer only.

Adaptation: the grid of banned product silhouettes in the classifier section. Flicking them feels playful without trivializing; keep the rotation clamp lower (±30) for a calmer tone.

### 14. Drag sliders with wobble (M)

How (`ParallaxSlider` extends Smooothy, line 27809): each item gets a random rotation 1.5 to 3 degrees and yOffset 3 to 9 percent, alternating sign; on update, `strength = sin(clamp(norm, -2, 2) * 1.2)` applied to translateY and rotate, so cards bob as they pass center. Drag vs click is disambiguated with a 5px threshold. `CenterSlider` scales edges to 0.85 and lifts them -15%.

Adaptation: "Real recalls we check against" slider: cards for actual recall entries (product type, recall date, hazard, source link), each with the product's generic silhouette in our art. Only include records we actually query.

### 15. Page transitions (M, optional)

Barba with `sync: true`, the same stroke path covering and uncovering. For a hackathon single-page site, skip Barba and reuse the stroke wipe only between the landing page and the live demo route (Next.js route change or a manual overlay).

### 16. Header behavior (S)

`initDetectScrollingDirection` sets `data-scrolling-started="true"` after 50px via `lenis.on('scroll')`, and CSS hides the header title and sub. Active nav pill grows two small ears (masked pseudo-elements, `transform: rotate(-36deg) scale(0)` to `scale(1)` with `ease-bounce`, plus an infinite "ear twitch" keyframe). Mobile collapses to a single "Menu" pill.

Adaptation: pill nav (How it works, Live check, Classifier, Judges). The active pill shows a small status dot in the current state color instead of ears.

### 17. Cursor effects

None found. There is no custom cursor function in the code and none visible. Do not add one; it is not part of their feel.

---

## 7. Proposed SecondHand Safe landing page

Palette mapping (ours, not theirs): HELD amber `#FFB020`-ish, CAPTURED green `#1FA35B`-ish, REVERSED red `#E5484D`-ish, ink `#14163A`, paper `#FFF8EC` (seaside sand), soft section tints of each. Final hexes are ours to pick; check contrast with the `initCheckContrast` luminance rule or a real WCAG check.

1. **Preloader** (technique 1). Amber field, our mark pops, scan line, amber ribbon undraws. 1.9s max, reduced motion skips.
2. **Hero** (techniques 2, 3, 4, 5, 8). Amber background blooming from the bottom right. H1: "The money doesn't move until the camera has seen the item." Handwritten aside: "Visa hold, not a promise." Right side: our own phone mock showing a live state chip that cycles HELD to CAPTURED on a loop (hero sequence technique, frames or Lottie-like SVG). Primary CTA "Try a live check", secondary "Judges start here".
3. **Problem stats** (techniques 12, 11). Pale red tint section. Big numbers pop in as stamps. Only use figures we can source and cite on the page (for example CPSC recall counts for the product categories we cover, and the inclined-sleeper and crib-bumper bans under the Safe Sleep for Babies Act). Put the source name under each number. Then the crossing ribbons band.
4. **How it works, scroll story** (techniques 6, 7, 3). Pinned section. Scrub sequence: listing agreed, card authorized and HELD (amber chip), pickup, camera frames the label, barcode read, check runs, verdict. Two endings shown side by side at the end: CAPTURED (green, NO_MATCH) and REVERSED (red, RECALL_MATCH). Below it, the four fanned step cards for readers who skip the scroll.
5. **Live recall check widget** (technique 8, 12). A real input: type or scan a UPC, or pick a sample. Result lands as a stamp with the verdict word, the matched recall record and its source link. Never shows "safe"; NO_MATCH copy says what was checked. UNREADABLE and NEEDS_CHECK get neutral ink styling and a handwritten hint on what to do next.
6. **Classifier results** (techniques 10, 13, 14). Curved text arc of banned types. Flickable grid of banned-type silhouettes (our own drawings). Then the measured numbers from our real eval run (accuracy per class, confusion matrix) as cards; if a number is not measured yet, do not show it.
7. **Judge CTA** (technique 8, 12). Numbered 3-minute itinerary with deep links, a sample reversal and a sample capture, the Visa sandbox transaction IDs, repo link. Badge-style drop-in.
8. **Footer** (technique 9). Deep ink footer slides out from under; our stroller-with-green-tag visual swings in. Data sources credited.

Mobile notes (from `phone-*.png` and the code):
- They disable the heavier effects under 992px: hero clip reveal, hero frame loop, footer parallax. Copy that split.
- The box sequence uses separate mobile frames (`data-mobile-src`) and a larger canvas parallax offset (-50 vs -25). For us, use a portrait crop of the scan sequence or the SVG fallback.
- Nav collapses to one "Menu" pill top right; background SVGs swap to dedicated `is--mobile` shapes.
- Hover effects are gated on `(hover: hover) and (pointer: fine)`, so on phones the fanned cards just sit tilted; make sure all information is readable without hover.
- Section radius shrinks and the grid becomes 5 columns with 1em gutters; our state chips must stay at least 44px tall for touch.

## 8. Image and illustration prompts (our own art direction)

Their direction in words: flat saturated fields, big organic blob layers in 2 to 3 tints of one hue, glossy 3D-rendered hero objects floating at steep angles with soft shadows, thick-line black ink illustrations of people on bright cards, and small hand-lettered notes. Adapted prompts (for kie.ai / Nano Banana or similar; review every output before use):

1. "Glossy 3D render of a modern infant car seat floating at a 25 degree tilt, soft studio lighting, clean shadow, isolated on transparent background, product-photo style, no logos, no text."
2. "Glossy 3D render of a wooden crib seen from a three-quarter angle, slightly rotated as if falling, isolated on transparent background, warm light, no brand marks."
3. "Flat vector seaside market background, three layered wavy shapes in sand, shallow aqua and deep teal, bold organic curves, no text, no people, 1920x1080."
4. "Thick black ink line illustration of a parent holding a phone up to a baby stroller label, simple shapes, expressive, on a flat amber background, style of editorial spot illustration, no text."
5. "Thick black ink line illustration of two people shaking hands next to a folded stroller at a seaside market stall, awning and bunting, flat bright background, no text."
6. "Set of simple flat silhouettes: inclined infant sleeper, crib bumper pad, drop-side crib, each as a single-color icon with rounded corners, consistent line weight, transparent background."
7. "Rubber stamp textures in red, green and amber, blank rectangle stamps with rough ink edges, transparent background, for overlaying our own verdict text."
8. "Illustrated shield mark combined with a small crib outline and a check mark, two-color, bold geometric, suitable as a small logo, flat vector."
9. "Close-up of a product label with a barcode on the side of a car seat, photographic, shallow depth of field, label text blurred and unreadable, neutral colors." (use only as a background texture; real demo evidence must be our actual captures)

Generated imagery is decoration. The demo's evidence must be real screen captures of real scans and real Visa sandbox results.

## 9. Screenshots saved

All under `/private/tmp/claude-501/-Users-stephensookra/58d1b74a-2a50-4e69-9e94-a24c9544f9ad/scratchpad/design-ref/`. Real-time preloader captures are imprecise because each screenshot took about 60 to 700ms; the slow-motion set (GSAP global timeScale 0.2) is the accurate one.

- `desk-preload-0000ms.png` to `desk-preload-2500ms.png` (5 files): real-time preloader, labelled by target time; actual capture times were 615, 1384, 1446, 1563, 2549ms. They show the violet field with the logo growing.
- `slowmo-preload-00.png` to `slowmo-preload-13.png`: preloader at 0.2x speed. 00 violet with tiny logo; 01 to 02 logo popped; 03 yellow page starts showing at the corners; 04 to 05 the violet stroke ribbon unwinding across the page; 06 headline words mid-elastic ("Unbox stories / worth") and book fading in; 07 to 13 settled hero.
- `_contact-slowmo.png`: contact sheet of the 14 slow-motion frames.
- `desk-hero.png`: settled hero at 1440x900.
- `desk-scroll-00.png` to `desk-scroll-17.png`: full page at 720px steps (scrollY 0 to 11773). 00 hero; 01 hero bottom and "Our Sept books"; 02 book slider; 03 "How it works" fanned cards; 04 to 07 scroll-scrubbed box sequence opening, ending with "Think inside the box"; 08 to 09 genre list on bright pink; 10 "Why Aardvark?" arc with tilted benefit pills; 11 FAQ; 12 gift section; 13 crossing promo ribbons and "Members' Choice Winners"; 14 to 15 winners slider; 16 exclusive book card; 17 violet footer.
- `_contact-desk-scroll-0.png`, `_contact-desk-scroll-1.png`: contact sheets of the desktop scroll set.
- `desk-button-hover-120ms.png`: primary button 120ms into hover, letters squashed and tilted, blocks rotated.
- `desk-button-hover-settled.png`: same button after the hover animation settles.
- `desk-callout-rest.png`: "How it works" cards at rest.
- `desk-callout-hover-card3.png`: cursor over the third region, card 3 straightened and scaled, siblings shifted.
- `phone-00-hero.png`, `phone-01.png` to `phone-07.png`: 390x844 hero and scroll stops at 12, 25, 40, 55, 70, 85, 100 percent (books slider, how it works, box sequence, genre list, gift, winners, footer).
- `_contact-phone.png`: phone contact sheet.
- `wf.css`, `slater.css`: fetched stylesheets used for the token values above (not images).

## 10. Things I could not verify

- Whether the promo ribbons (technique 11) move; I only have stills and found no dedicated JS for them.
- `canvas-matter` class names on the benefit labels hint at a Matter.js physics version, but no Matter.js script loads and the live section animates with `initBenefits`, so I treat physics as not in use.
- Exact frame counts of the hero loop beyond the attributes (`data-frames="120"`, `data-fps="24"`).
