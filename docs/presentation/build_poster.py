"""Expo poster for the table (Letter landscape). Every number is read from docs/FACTS.json, never typed.

  ml/.venv/bin/python docs/presentation/build_poster.py      -> docs/presentation/poster.html
  (POSTER_PASSPORT_LIVE=1 / POSTER_DOMAIN_LIVE=1 add the Solana passport / lullabuy.tech once each is real)
  npm exec -- node docs/presentation/render_pdf.mjs          -> docs/presentation/poster.pdf
"""
import io
import json
import os

import qrcode
import qrcode.image.svg

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BASE = "https://lullabuy.tech"


def qr(url):
    img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=1)
    buf = io.BytesIO()
    img.save(buf)
    svg = buf.getvalue().decode()
    return svg[svg.index("<svg"):]


def main():
    f = json.load(open(os.path.join(ROOT, "docs", "FACTS.json")))
    c, r, rounds = f["classifier"], f["recallIndex"], f["scanRounds"]
    icon = open(os.path.join(ROOT, "src", "app", "icon.svg")).read()
    n = lambda x: f"{x:,}"
    # wired-or-cut: only claim what is live today (set these when the passport wallet is funded / the domain resolves)
    passport = os.environ.get("POSTER_PASSPORT_LIVE") == "1"
    domain = os.environ.get("POSTER_DOMAIN_LIVE") == "1"
    step4 = " A sale gets a <b>Solana</b> item passport." if passport else ""
    chip = "<span>Solana</span>" if passport else ""
    dom = '<span class="hand" style="margin-left:.1in">lullabuy.tech</span>' if domain else ""
    html = f"""<!doctype html><html><head><meta charset="utf-8"><title>Lullabuy poster</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Figtree:wght@500;700;800&family=Caveat:wght@700&display=swap" rel="stylesheet">
<style>
@page {{ size: 11in 8.5in; margin: 0 }}
* {{ box-sizing: border-box; margin: 0 }}
:root {{ --ink:#14163a; --amber:#ffb020; --paper:#fff8ec; --green:#1fa35b; --red:#e5484d; --visa:#1434cb; --sand:#f6e7cc }}
body {{ width: 11in; height: 8.5in; background: var(--amber); color: var(--ink); font-family: Figtree, sans-serif; padding: .32in; }}
.grid {{ display: grid; grid-template-columns: 1.25fr 1fr; gap: .22in; height: 100%; }}
.card {{ background: var(--paper); border: 3px solid var(--ink); border-radius: .28in; padding: .2in .24in; box-shadow: 5px 6px 0 var(--ink); }}
h1 {{ font-family: 'Bricolage Grotesque'; font-weight: 800; font-size: .62in; line-height: .95; letter-spacing: -.01em }}
h2 {{ font-family: 'Bricolage Grotesque'; font-weight: 800; font-size: .2in; margin-bottom: .06in }}
.hand {{ font-family: Caveat; font-size: .26in; transform: rotate(-2deg); display: inline-block }}
.brand {{ display: flex; align-items: center; gap: .1in; font-family: 'Bricolage Grotesque'; font-weight: 800; font-size: .3in }}
.brand svg {{ width: .46in; height: .46in }}
p, li {{ font-size: .125in; line-height: 1.35; font-weight: 600 }}
ol {{ padding-left: .2in; display: grid; gap: .05in }}
.stats {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: .1in }}
.stat {{ background: var(--sand); border: 2px solid var(--ink); border-radius: .14in; padding: .08in .1in }}
.stat b {{ font-family: 'Bricolage Grotesque'; font-size: .3in; display: block; line-height: 1 }}
.stat span {{ font-size: .1in; font-weight: 700 }}
.qrs {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: .12in; text-align: center }}
.qrs svg {{ width: 100%; height: auto; background: #fff; border: 2px solid var(--ink); border-radius: .08in; padding: .04in }}
.qrs b {{ font-size: .115in; display: block; margin-top: .03in }}
code {{ font-size: .098in; background: var(--ink); color: var(--paper); padding: .05in .08in; border-radius: .06in; display: block; word-break: break-all }}
.chips span {{ display: inline-block; border: 2px solid var(--ink); border-radius: 99px; padding: .02in .08in; margin: .02in; font-size: .1in; font-weight: 800; background: #fff }}
.col {{ display: grid; gap: .16in; align-content: start }}
.small {{ font-size: .095in; opacity: .75 }}
</style></head><body><div class="grid">
<div class="col">
  <div class="brand">{icon}<span>Lullabuy</span>{dom}</div>
  <h1>See the recall before your money moves.</h1>
  <p style="font-size:.15in">Buying a used crib or car seat from a stranger? <b>Lullabuy holds a Visa payment until a camera reads the item's label.</b>
  Recalled or banned: the hold is reversed. Clean: the seller is paid. Nobody takes the risk home.</p>
  <div class="card">
    <h2>Why</h2>
    <p>About 100 babies died in Fisher-Price Rock 'n Play sleepers, at least 8 after the recall (CPSC, Jan 2023).
    Consumer Reports found 50 of the first 65 Facebook Marketplace listings it reviewed were banned infant sleepers (2026).
    Marketplaces filter the text they can read. Nobody reads the label when the money changes hands.</p>
  </div>
  <div class="card">
    <h2>How it works</h2>
    <ol>
      <li><b>Find it.</b> Say what you need. <b>Gemini</b> searches {n(f['scanned'])} real listings; every result is pre-screened, red ones cannot be bought.</li>
      <li><b>Agree and hold.</b> Card typed into <b>Visa Acceptance Microform</b>; authorized with capture off. An AI agent buying for you signs with the <b>Trusted Agent Protocol</b>.</li>
      <li><b>Meet and scan.</b> One photo: barcode, <b>Gemini</b> reads the label, our model checks the product type on the phone.</li>
      <li><b>Capture or reverse</b> at Visa, spoken by <b>ElevenLabs</b>.{step4}</li>
    </ol>
  </div>
  <div class="chips"><span>Visa Acceptance</span><span>Microform</span><span>Trusted Agent Protocol</span><span>Gemini 3.5 Flash</span><span>CLIP + our trained head</span><span>CPSC + NHTSA</span><span>ElevenLabs</span><span>MCP</span>{chip}<span>Next.js on Vercel</span></div>
</div>
<div class="col">
  <div class="card">
    <h2>Measured, not claimed</h2>
    <div class="stats">
      <div class="stat"><b>{n(r['nurseryRecalls'])}</b><span>CPSC nursery recalls, plus {r['nhtsaChildSeatCampaigns']} NHTSA car seat campaigns</span></div>
      <div class="stat"><b>{n(r['withAnyIdentifier'])}</b><span>recalls with a model, batch or UPC on file (regex + Gemini)</span></div>
      <div class="stat"><b>{n(f['scanned'])}</b><span>real eBay and Craigslist listings scanned</span></div>
      <div class="stat"><b>{c['macroF1']:.2f}</b><span>macro-F1 on products it never saw, vs {c['zeroShotMacroF1']:.2f} off-the-shelf CLIP</span></div>
      <div class="stat"><b>{c['falseAlarmsOnOrdinary']} vs {c['falseAlarmsZeroShot']}</b><span>ordinary items wrongly flagged (of {c['ordinaryHeldOut']})</span></div>
      <div class="stat"><b>{rounds[0]['flags']}&rarr;{rounds[-1]['flags']}</b><span>scan flags after reviewing every one by hand</span></div>
    </div>
    <p class="small" style="margin-top:.06in">Every number here is recomputed by a script and served at /api/stats.</p>
  </div>
  <div class="card">
    <h2>Try it on your phone, no login</h2>
    <div class="qrs">
      <div>{qr(BASE + '/shop')}<b>Shop with the agent</b></div>
      <div>{qr(BASE + '/judge')}<b>Judges: 3 minutes</b></div>
      <div>{qr('https://github.com/StephenSook/secondhand-safe')}<b>The code</b></div>
    </div>
  </div>
  <div class="card">
    <h2>Check any model number yourself</h2>
    <code>curl "{BASE}/api/check?model=BHC001&amp;batch=202408"</code>
    <p class="small" style="margin-top:.05in">Also an MCP tool (recall_check at /api/mcp) for any AI shopping agent. Never says "safe": no match means no match as of the index date.</p>
  </div>
  <p class="hand" style="font-size:.2in">Stephen Sookra and Tylin · HackGT 13</p>
</div>
</div></body></html>"""
    open(os.path.join(HERE, "poster.html"), "w").write(html)
    print("wrote docs/presentation/poster.html")


if __name__ == "__main__":
    main()
