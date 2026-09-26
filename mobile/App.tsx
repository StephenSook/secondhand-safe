import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as ImagePicker from "expo-image-picker";
import * as Speech from "expo-speech";
import * as WebBrowser from "expo-web-browser";

/**
 * Lullabuy on iOS and Android. Every screen calls the live deployment's public API, the same one the web app
 * and the judges use: /api/shop (Gemini agent over real scanned listings), /api/label (Gemini reads the label
 * photo), /api/check (the recall index and legal rules) and /api/deals (the MongoDB Atlas deal board).
 */
const API = process.env.EXPO_PUBLIC_API_BASE ?? "https://secondhand-safe-web.vercel.app";

const C = { ink: "#14163a", paper: "#fff8ec", amber: "#ffb020", amberSoft: "#ffe7b0", green: "#1fa35b", greenSoft: "#cff1dc", red: "#e5484d", redSoft: "#ffd9d7", sand: "#f6e7cc", visa: "#1434cb" };
const TONE_BG: Record<string, string> = { red: C.redSoft, amber: C.amberSoft, clear: C.greenSoft };
const KIND_WORD: Record<string, string> = { RECALL_MATCH: "Recalled", BANNED_TYPE: "Banned product type", NO_MATCH: "No recall match", NEEDS_CHECK: "Needs a check", UNREADABLE: "Label unreadable" };
const KIND_BG: Record<string, string> = { RECALL_MATCH: C.red, BANNED_TYPE: C.red, NO_MATCH: C.green, NEEDS_CHECK: C.amber, UNREADABLE: C.sand };

type Tab = "shop" | "scan" | "board";

export default function App() {
  const [tab, setTab] = useState<Tab>("scan");
  return (
    <View style={s.root}>
      <StatusBar style="dark" />
      <View style={s.header}>
        <Text style={s.brand}>Lullabuy</Text>
        <Text style={s.tag}>The money waits until the camera has seen the item.</Text>
      </View>
      <View style={{ flex: 1 }}>{tab === "shop" ? <Shop /> : tab === "scan" ? <Scan /> : <Board />}</View>
      <View style={s.tabs}>
        {(["shop", "scan", "board"] as Tab[]).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && s.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}>
            <Text style={[s.tabText, tab === t && { color: C.paper }]}>{t === "shop" ? "Shop" : t === "scan" ? "Scan label" : "Deal board"}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/* ---------- Scan: photo -> Gemini label read -> recall check -> spoken verdict ---------- */
type Verdict = { kind: string; reason: string; asOf: string; recall?: { recallNumber: string; title: string; url: string } };

function Scan() {
  const [photo, setPhoto] = useState<string | null>(null);
  const [fields, setFields] = useState({ model: "", batch: "", date: "", upc: "" });
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);

  async function shoot(fromLibrary: boolean) {
    setErr(""); setVerdict(null);
    const perm = fromLibrary ? await ImagePicker.requestMediaLibraryPermissionsAsync() : await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { setErr("Camera or photo access was not allowed. Type the model number instead."); return; }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], base64: true, quality: 0.5 };
    const r = fromLibrary ? await ImagePicker.launchImageLibraryAsync(opts) : await ImagePicker.launchCameraAsync(opts);
    if (r.canceled || !r.assets[0]?.base64) return;
    const a = r.assets[0];
    setPhoto(a.uri);
    setBusy("Gemini is reading the label…");
    try {
      const resp = await fetch(`${API}/api/label`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageDataUrl: `data:${a.mimeType === "image/png" ? "image/png" : "image/jpeg"};base64,${a.base64}` }) });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error ?? `HTTP ${resp.status}`);
      const next = { model: j.model ?? "", batch: j.batch ?? "", date: j.date ?? "", upc: j.upc ?? "" };
      setFields(next);
      if (!j.readable) setErr("The label was hard to read. Check or type the fields, then run the check.");
      await check(next);
    } catch (e) {
      setErr(`Label reader: ${(e as Error).message}. Type the model number instead.`);
    } finally {
      setBusy("");
    }
  }

  async function check(f = fields) {
    setBusy("Checking CPSC and NHTSA recalls…"); setErr("");
    try {
      const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v.trim()) as [string, string][]);
      const resp = await fetch(`${API}/api/check?${q}`);
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error ?? `HTTP ${resp.status}`);
      setVerdict(j.verdict);
      Speech.stop();
      Speech.speak(`${KIND_WORD[j.verdict.kind] ?? j.verdict.kind}. ${j.verdict.reason}`, { rate: 0.95 });
    } catch (e) {
      setErr(`Check failed: ${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  }

  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.h1}>Scan the label</Text>
      <Text style={s.p}>One photo of the label. Gemini reads the model, batch and date; the recall check runs against the live index.</Text>
      <View style={s.row}>
        <Btn label="Take a photo" onPress={() => shoot(false)} bg={C.ink} />
        <Btn label="Choose a photo" onPress={() => shoot(true)} bg={C.visa} />
      </View>
      {photo && <Image source={{ uri: photo }} style={s.photo} accessibilityLabel="The label photo" />}
      {(["model", "batch", "date", "upc"] as const).map((k) => (
        <View key={k} style={s.field}>
          <Text style={s.label}>{k}</Text>
          <TextInput value={fields[k]} onChangeText={(v) => setFields({ ...fields, [k]: v })} style={s.input} autoCapitalize="characters"
            accessibilityLabel={k} placeholder={k === "model" ? "BHC001" : k === "batch" ? "202408" : k === "date" ? "2025-06" : "UPC digits"} />
        </View>
      ))}
      <Btn label="Check what the label says" onPress={() => check()} bg={C.green} />
      {busy ? <View style={s.row}><ActivityIndicator color={C.ink} /><Text style={s.p}> {busy}</Text></View> : null}
      {err ? <Text style={s.err}>{err}</Text> : null}
      {verdict && (
        <View style={[s.card, { backgroundColor: KIND_BG[verdict.kind] ?? C.sand }]} accessibilityLiveRegion="polite">
          <Text style={[s.verdict, { color: verdict.kind === "NEEDS_CHECK" || verdict.kind === "UNREADABLE" ? C.ink : C.paper }]}>{KIND_WORD[verdict.kind] ?? verdict.kind}</Text>
          <Text style={[s.p, { color: verdict.kind === "NEEDS_CHECK" || verdict.kind === "UNREADABLE" ? C.ink : C.paper }]}>{verdict.reason}</Text>
          {verdict.recall && <Pressable onPress={() => WebBrowser.openBrowserAsync(verdict.recall!.url)}><Text style={[s.link, { color: C.paper }]}>Open recall {verdict.recall.recallNumber}</Text></Pressable>}
          <Text style={[s.small, { color: verdict.kind === "NEEDS_CHECK" || verdict.kind === "UNREADABLE" ? C.ink : C.paper }]}>Index as of {verdict.asOf}. No match is not a safety guarantee.</Text>
        </View>
      )}
    </ScrollView>
  );
}

/* ---------- Shop: Gemini agent over real scanned listings, each pre-screened ---------- */
type ShopResult = { listing: { id: string; title: string; priceUsd: number | null; url: string; image: string | null; source: string }; screen: { tone: "red" | "amber" | "clear"; headline: string; reason: string } };

function Shop() {
  const [q, setQ] = useState("A bassinet for my newborn under $80, pickup in Atlanta");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<{ engine: string; reply: string; results: ShopResult[]; counts: { red: number; amber: number; clear: number } } | null>(null);

  async function run() {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`${API}/api/shop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setRes(j);
      Speech.stop();
      Speech.speak(`${j.reply} ${j.counts.red} blocked, ${j.counts.amber} need a check, ${j.counts.clear} passed the photo check.`, { rate: 0.95 });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.h1}>Shop with the agent</Text>
      <TextInput value={q} onChangeText={setQ} style={[s.input, { minHeight: 64 }]} multiline accessibilityLabel="What do you need?" />
      <Text style={s.small}>Tip: tap the microphone on your keyboard to say it.</Text>
      <Btn label={busy ? "Searching…" : "Find it"} onPress={run} bg={C.ink} disabled={busy} />
      {err ? <Text style={s.err}>{err}</Text> : null}
      {res && (
        <>
          <View style={[s.card, { backgroundColor: C.ink }]}>
            <Text style={[s.small, { color: C.paper, opacity: 0.7 }]}>{res.engine === "gemini" ? "GEMINI READ YOUR REQUEST" : "KEYWORD SEARCH (GEMINI UNREACHABLE)"}</Text>
            <Text style={[s.p, { color: C.paper, fontWeight: "700" }]}>{res.reply}</Text>
            <Text style={[s.small, { color: C.paper }]}>{res.counts.red} blocked · {res.counts.amber} need a check · {res.counts.clear} photo check passed</Text>
          </View>
          {res.results.map((r) => (
            <Pressable key={r.listing.id} onPress={() => WebBrowser.openBrowserAsync(r.listing.url)} style={[s.card, { backgroundColor: TONE_BG[r.screen.tone] }]}>
              <View style={s.row}>
                {r.listing.image ? <Image source={{ uri: r.listing.image }} style={s.thumb} /> : null}
                <View style={{ flex: 1 }}>
                  <Text style={s.chip}>{r.screen.tone === "red" ? "✕ " : r.screen.tone === "amber" ? "! " : "✓ "}{r.screen.headline}</Text>
                  <Text style={s.title} numberOfLines={2}>{r.listing.title}</Text>
                  <Text style={s.small}>${(r.listing.priceUsd ?? 0).toFixed(2)} · {r.listing.source === "ebay" ? "eBay" : "Craigslist"}</Text>
                </View>
              </View>
              <Text style={s.small}>{r.screen.reason}</Text>
            </Pressable>
          ))}
        </>
      )}
    </ScrollView>
  );
}

/* ---------- Board: the MongoDB Atlas deal board, live ---------- */
type Row = { dealId: string; listing: string; amountUsd: number; status: string };

function Board() {
  const [b, setB] = useState<{ recent: Row[]; byStatus: Record<string, { n: number; usd: number }> } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(`${API}/api/deals`);
        const j = await r.json();
        if (!live) return;
        if (!r.ok) { setErr(j.error ?? `HTTP ${r.status}`); return; }
        setErr(""); setB(j);
      } catch { if (live) setErr("Could not reach the deal board; retrying."); }
    };
    void load();
    const t = setInterval(load, 3000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const st = (k: string) => b?.byStatus[k] ?? { n: 0, usd: 0 };
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.h1}>Deal board</Text>
      {err ? <Text style={s.err}>{err}</Text> : null}
      {!b && !err ? <ActivityIndicator color={C.ink} /> : null}
      {b && (
        <>
          <View style={s.row}>
            {[["HELD", C.amber], ["REVERSED", C.red], ["CAPTURED", C.green]].map(([k, bg]) => (
              <View key={k} style={[s.stat, { backgroundColor: bg }]}>
                <Text style={s.statN}>${st(k).usd.toFixed(0)}</Text>
                <Text style={s.small}>{st(k).n} {k.toLowerCase()}</Text>
              </View>
            ))}
          </View>
          {b.recent.map((r) => (
            <Pressable key={r.dealId} onPress={() => WebBrowser.openBrowserAsync(`${API}/deal/${r.dealId}`)} style={s.dealRow}>
              <Text style={s.chip}>{r.status}</Text>
              <Text style={[s.title, { flex: 1 }]} numberOfLines={1}>{r.listing}</Text>
              <Text style={s.title}>${r.amountUsd.toFixed(2)}</Text>
            </Pressable>
          ))}
          <Text style={s.small}>Visa sandbox holds, recorded in MongoDB Atlas. Tap a deal for the seller's live view.</Text>
        </>
      )}
    </ScrollView>
  );
}

function Btn({ label, onPress, bg, disabled }: { label: string; onPress: () => void; bg: string; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }]}>
      <Text style={s.btnText}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.amber },
  header: { paddingTop: 60, paddingHorizontal: 20, paddingBottom: 12 },
  brand: { fontSize: 34, fontWeight: "900", color: C.ink },
  tag: { fontSize: 14, fontWeight: "600", color: C.ink },
  page: { padding: 16, gap: 12, backgroundColor: C.paper, borderTopLeftRadius: 28, borderTopRightRadius: 28, minHeight: "100%" },
  h1: { fontSize: 28, fontWeight: "900", color: C.ink },
  p: { fontSize: 15, fontWeight: "600", color: C.ink },
  small: { fontSize: 12, fontWeight: "600", color: C.ink },
  err: { fontSize: 14, fontWeight: "700", color: "#b4232a" },
  row: { flexDirection: "row", gap: 10, alignItems: "center", flexWrap: "wrap" },
  btn: { borderRadius: 999, borderWidth: 3, borderColor: C.ink, paddingVertical: 12, paddingHorizontal: 18, alignItems: "center" },
  btnText: { color: C.paper, fontWeight: "800", fontSize: 16 },
  photo: { width: "100%", height: 220, borderRadius: 18, borderWidth: 3, borderColor: C.ink, backgroundColor: "#fff" },
  field: { gap: 4 },
  label: { fontSize: 12, fontWeight: "800", color: C.ink, textTransform: "uppercase" },
  input: { borderWidth: 3, borderColor: C.ink, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 17, fontWeight: "600", color: C.ink, backgroundColor: "#fff" },
  card: { borderWidth: 3, borderColor: C.ink, borderRadius: 22, padding: 14, gap: 6 },
  verdict: { fontSize: 30, fontWeight: "900" },
  link: { fontWeight: "800", textDecorationLine: "underline" },
  thumb: { width: 72, height: 72, borderRadius: 12, borderWidth: 2, borderColor: C.ink, backgroundColor: "#fff" },
  chip: { fontSize: 12, fontWeight: "900", color: C.ink },
  title: { fontSize: 15, fontWeight: "800", color: C.ink },
  stat: { flex: 1, minWidth: 96, borderWidth: 3, borderColor: C.ink, borderRadius: 18, padding: 10 },
  statN: { fontSize: 24, fontWeight: "900", color: C.ink },
  dealRow: { flexDirection: "row", gap: 10, alignItems: "center", borderBottomWidth: 2, borderColor: "#14163a22", paddingVertical: 10 },
  tabs: { flexDirection: "row", gap: 8, padding: 12, paddingBottom: 30, backgroundColor: C.paper, borderTopWidth: 2, borderColor: "#14163a22" },
  tab: { flex: 1, borderWidth: 3, borderColor: C.ink, borderRadius: 999, paddingVertical: 10, alignItems: "center", backgroundColor: C.paper },
  tabOn: { backgroundColor: C.ink },
  tabText: { fontWeight: "800", color: C.ink },
});
