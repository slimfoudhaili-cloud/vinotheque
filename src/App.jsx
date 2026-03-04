// ─────────────────────────────────────────────────────────────────────────────
// CAVE À VIN — Version Supabase
// 
// SETUP :
// 1. npm create vite@latest cave-a-vin -- --template react
// 2. npm install @supabase/supabase-js
// 3. Créer un fichier .env à la racine :
//      VITE_SUPABASE_URL=https://xxxx.supabase.co
//      VITE_SUPABASE_ANON_KEY=eyJhbGci...
// 4. Exécuter supabase-schema.sql dans Supabase > SQL Editor
// 5. npm run dev
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── SUPABASE CLIENT ──────────────────────────────────────────────────────────
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const CURRENT_YEAR = new Date().getFullYear();

const COLOR_META = {
  rouge:     { label: "Rouge",     accent: "#c0392b", dot: "bg-red-500",    text: "text-red-400",    bg: "bg-red-900"    },
  blanc:     { label: "Blanc",     accent: "#d4a017", dot: "bg-amber-400",  text: "text-amber-300",  bg: "bg-amber-900"  },
  rosé:      { label: "Rosé",      accent: "#e91e8c", dot: "bg-pink-400",   text: "text-pink-300",   bg: "bg-pink-900"   },
  champagne: { label: "Champagne", accent: "#f0c040", dot: "bg-yellow-300", text: "text-yellow-300", bg: "bg-yellow-900" },
};

function getDrinkUrgency(wine) {
  const from = wine.apogee_from;
  const to   = wine.apogee_to;
  if (!from || !to) return { level: "wait", label: "Inconnu", score: 0 };
  if (CURRENT_YEAR > to)               return { level: "critical", label: "En déclin", score: 3 };
  if (CURRENT_YEAR >= from)            return { level: "now",      label: "À boire",   score: 2 };
  if (from - CURRENT_YEAR <= 2)        return { level: "soon",     label: "Bientôt",   score: 1 };
  return { level: "wait", label: "Attendre", score: 0 };
}

function fmt(p) {
  if (!p) return "—";
  return p >= 1000 ? `${(p / 1000).toFixed(1)}k€` : `${p}€`;
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function fetchWines(userId) {
  const { data, error } = await supabase
    .from("wines")
    .select("*")
    .eq("user_id", userId)
    .order("added_at", { ascending: false });
  if (error) throw error;
  return data;
}

async function insertWine(wine) {
  const { data, error } = await supabase.from("wines").insert([wine]).select().single();
  if (error) throw error;
  return data;
}

async function updateWineQty(id, quantity) {
  if (quantity <= 0) {
    const { error } = await supabase.from("wines").delete().eq("id", id);
    if (error) throw error;
    return null;
  }
  const { data, error } = await supabase.from("wines").update({ quantity }).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

async function deleteWineById(id) {
  const { error } = await supabase.from("wines").delete().eq("id", id);
  if (error) throw error;
}

async function logTasting(wine) {
  await supabase.from("wine_tastings").insert([{
    wine_id:    wine.id,
    user_id:    wine.user_id,
    wine_name:  wine.name,
    wine_year:  wine.year,
  }]);
}

// ─── PROXY ANTHROPIC (via Netlify Function) ──────────────────────────────────
async function callClaude(payload) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ─── SCAN ÉTIQUETTE via Claude Vision ────────────────────────────────────────
async function scanLabelWithClaude(base64Image, mediaType) {
  const data = await callClaude({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
        { type: "text", text: `Analyse cette étiquette de vin et extrais les informations.
Réponds UNIQUEMENT en JSON valide :
{
  "name": "<nom du domaine/château>",
  "appellation": "<appellation ou cru>",
  "year": <millésime entier ou null>,
  "region": "<région viticole>",
  "color": "<rouge|blanc|rosé|champagne>"
}
Si une information est absente ou illisible, mets null.` }
      ]
    }]
  });
  const text = (data.content?.[0]?.text || "{}").replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

// ─── PRICE ESTIMATION via Claude API ─────────────────────────────────────────
async function estimatePriceFromClaude(name, appellation, year) {
  const data = await callClaude({
    model: "claude-sonnet-4-20250514",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: `Estimation de prix marché actuel (€) pour : "${name}" ${appellation || ""} ${year || ""}.
Réponds UNIQUEMENT en JSON valide : {"price": <entier ou null>, "note": "<1 phrase>"}`
    }]
  });
  const text = (data.content?.[0]?.text || "{}").replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

// ─── COMPONENTS ──────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-stone-900 rounded-xl p-4 flex-1">
      <div className="text-stone-400 text-xs mb-1">{label}</div>
      <div className="text-white text-xl font-semibold">{value}</div>
      {sub && <div className="text-stone-500 text-xs mt-0.5">{sub}</div>}
    </div>
  );
}

function WineCard({ wine, onDrink, onDelete, onClick }) {
  const urgency = getDrinkUrgency(wine);
  const meta    = COLOR_META[wine.color] || COLOR_META.rouge;
  const urgencyBorder = {
    critical: "border-l-4 border-orange-500",
    now:      "border-l-4 border-emerald-500",
    soon:     "border-l-4 border-yellow-500",
    wait:     "border-l-4 border-stone-700",
  }[urgency.level];
  const urgencyBadge = {
    critical: "bg-orange-900 text-orange-300",
    now:      "bg-emerald-900 text-emerald-300",
    soon:     "bg-yellow-900 text-yellow-300",
    wait:     "bg-stone-800 text-stone-500",
  }[urgency.level];

  return (
    <div
      className={`bg-stone-900 rounded-xl p-4 mb-3 cursor-pointer active:scale-95 transition-transform ${urgencyBorder}`}
      onClick={() => onClick(wine)}
      style={{ WebkitTapHighlightColor: "transparent" }}
    >
      <div className="flex justify-between items-start mb-1">
        <div className="flex-1 pr-2">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`w-2 h-2 rounded-full ${meta.dot} flex-shrink-0`} />
            <span className="text-xs text-stone-400 uppercase tracking-wider">{wine.region} · {wine.year}</span>
          </div>
          <div className="text-white font-medium text-sm leading-tight">{wine.name}</div>
          <div className="text-stone-400 text-xs mt-0.5">{wine.appellation}</div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-white font-semibold text-sm">{fmt(wine.estimated_price)}</div>
          <div className="text-stone-500 text-xs">{wine.quantity} btl · {fmt((wine.estimated_price || 0) * wine.quantity)}</div>
        </div>
      </div>
      <div className="flex items-center justify-between mt-2">
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${urgencyBadge}`}>{urgency.label}</span>
        {wine.score && <span className="text-xs text-stone-400">★ {wine.score}/100</span>}
        <div className="flex gap-2" onClick={e => e.stopPropagation()}>
          <button onClick={() => onDrink(wine)} className="text-xs bg-stone-800 text-stone-300 px-2 py-1 rounded-lg">Boire</button>
          <button onClick={() => onDelete(wine)} className="text-xs bg-stone-800 text-red-400 px-2 py-1 rounded-lg">✕</button>
        </div>
      </div>
    </div>
  );
}

// ─── ADD WINE SHEET ───────────────────────────────────────────────────────────
function AddWineSheet({ userId, onClose, onAdded }) {
  const empty = { name: "", appellation: "", color: "rouge", year: "", quantity: "1", region: "", notes: "", apogeeFrom: "", apogeeTo: "" };
  const [form, setForm]         = useState(empty);
  const [priceEst, setPriceEst] = useState(null);
  const [loadingPrice, setLoadingPrice] = useState(false);
  const [loadingScan, setLoadingScan]   = useState(false);
  const [scanPreview, setScanPreview]   = useState(null);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState(null);
  const fileRef = useRef(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const IC  = "w-full bg-stone-800 text-white rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-amber-600";
  const LC  = "text-stone-400 text-xs mb-1 block";

  // ── Scan étiquette ──
  async function handleScan(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoadingScan(true);
    setError(null);
    try {
      // Preview
      const previewUrl = URL.createObjectURL(file);
      setScanPreview(previewUrl);
      // Convert to base64
      // Convert + resize to base64
const base64 = await new Promise((res, rej) => {
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    const MAX = 1200;
    let w = img.width, h = img.height;
    if (w > MAX) { h = (h * MAX) / w; w = MAX; }
    if (h > MAX) { w = (w * MAX) / h; h = MAX; }
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    res(canvas.toDataURL("image/jpeg", 0.8).split(",")[1]);
  };
  img.onerror = rej;
  img.src = URL.createObjectURL(file);
});
const mediaType = "image/jpeg";);
      const result = await scanLabelWithClaude(base64, mediaType);
      // Pré-remplir le formulaire
      if (result.name)        set("name",        result.name);
      if (result.appellation) set("appellation", result.appellation);
      if (result.year)        set("year",        String(result.year));
      if (result.region)      set("region",      result.region);
      if (result.color && COLOR_META[result.color]) set("color", result.color);
    } catch (e) {
      setError("Scan échoué — remplis manuellement");
    }
    setLoadingScan(false);
  }

  async function estimate() {
    if (!form.name) return;
    setLoadingPrice(true);
    try {
      const est = await estimatePriceFromClaude(form.name, form.appellation, form.year);
      setPriceEst(est);
    } catch { setPriceEst({ price: null, note: "Indisponible" }); }
    setLoadingPrice(false);
  }

  async function submit() {
    if (!form.name || !form.year || !form.color) return;
    setSaving(true);
    try {
      const yr = parseInt(form.year);
      const wine = {
        user_id:         userId,
        name:            form.name.trim(),
        appellation:     form.appellation.trim() || null,
        color:           form.color,
        year:            yr,
        quantity:        parseInt(form.quantity) || 1,
        region:          form.region.trim() || null,
        notes:           form.notes.trim() || null,
        estimated_price: priceEst?.price || null,
        apogee_from:     parseInt(form.apogeeFrom) || yr + 3,
        apogee_to:       parseInt(form.apogeeTo)   || yr + 15,
        score:           null,
      };
      const saved = await insertWine(wine);
      onAdded(saved);
      onClose();
    } catch (e) {
      setError("Erreur lors de l'enregistrement");
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-end" onClick={onClose}>
      <div className="bg-stone-950 rounded-t-2xl w-full max-h-[90vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-5">
          <h2 className="text-white font-semibold text-lg">Ajouter une bouteille</h2>
          <button onClick={onClose} className="text-stone-400 text-xl">✕</button>
        </div>

        {/* ── Scan étiquette ── */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handleScan}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={loadingScan}
          className="w-full bg-amber-700 text-white rounded-xl py-3 text-sm font-medium mb-4 flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {loadingScan ? "⏳ Analyse en cours…" : "📷 Scanner l'étiquette"}
        </button>

        {scanPreview && (
          <div className="mb-4 rounded-xl overflow-hidden border border-stone-700">
            <img src={scanPreview} alt="Étiquette" className="w-full max-h-40 object-contain bg-stone-900" />
            {loadingScan && <div className="text-center text-amber-400 text-xs py-2">Analyse par IA…</div>}
            {!loadingScan && form.name && <div className="text-center text-emerald-400 text-xs py-2">✓ Formulaire pré-rempli</div>}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className={LC}>Nom du vin *</label>
            <input className={IC} placeholder="Château Margaux" value={form.name} onChange={e => set("name", e.target.value)} />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className={LC}>Appellation</label>
              <input className={IC} placeholder="Margaux" value={form.appellation} onChange={e => set("appellation", e.target.value)} />
            </div>
            <div className="w-24">
              <label className={LC}>Millésime *</label>
              <input className={IC} placeholder="2018" value={form.year} onChange={e => set("year", e.target.value)} type="number" />
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className={LC}>Couleur *</label>
              <select className={IC} value={form.color} onChange={e => set("color", e.target.value)}>
                <option value="rouge">Rouge</option>
                <option value="blanc">Blanc</option>
                <option value="rosé">Rosé</option>
                <option value="champagne">Champagne</option>
              </select>
            </div>
            <div className="w-24">
              <label className={LC}>Quantité</label>
              <input className={IC} value={form.quantity} onChange={e => set("quantity", e.target.value)} type="number" min="1" />
            </div>
          </div>
          <div>
            <label className={LC}>Région</label>
            <input className={IC} placeholder="Bordeaux" value={form.region} onChange={e => set("region", e.target.value)} />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className={LC}>Apogée de</label>
              <input className={IC} placeholder="2028" value={form.apogeeFrom} onChange={e => set("apogeeFrom", e.target.value)} type="number" />
            </div>
            <div className="flex-1">
              <label className={LC}>Apogée à</label>
              <input className={IC} placeholder="2040" value={form.apogeeTo} onChange={e => set("apogeeTo", e.target.value)} type="number" />
            </div>
          </div>
          <div>
            <label className={LC}>Notes</label>
            <textarea className={IC} rows={2} value={form.notes} onChange={e => set("notes", e.target.value)} />
          </div>

          {/* Estimation prix */}
          <div className="bg-stone-800 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-stone-300 text-sm">Estimation de prix</span>
              <button
                onClick={estimate}
                disabled={loadingPrice || !form.name}
                className="text-xs bg-amber-700 text-white px-3 py-1.5 rounded-lg disabled:opacity-40"
              >{loadingPrice ? "…" : "Estimer"}</button>
            </div>
            {priceEst && (
              <div>
                <div className="text-white font-semibold">{priceEst.price ? `${priceEst.price} €` : "Non trouvé"}</div>
                <div className="text-stone-400 text-xs mt-0.5">{priceEst.note}</div>
              </div>
            )}
          </div>

          {error && <div className="text-red-400 text-xs text-center">{error}</div>}
        </div>

        <button
          onClick={submit}
          disabled={saving || !form.name || !form.year}
          className="w-full bg-amber-600 text-white rounded-xl py-3.5 text-sm font-semibold mt-5 disabled:opacity-40"
        >{saving ? "Enregistrement…" : "Ajouter à la cave"}</button>
      </div>
    </div>
  );
}

// ─── WINE DETAIL ──────────────────────────────────────────────────────────────
function WineDetail({ wine, onClose, onDrink, onDelete }) {
  const urgency = getDrinkUrgency(wine);
  const meta    = COLOR_META[wine.color] || COLOR_META.rouge;
  const RANGE_START = 2000, RANGE_END = 2060;

  return (
    <div className="fixed inset-0 bg-stone-950 z-50 overflow-y-auto">
      <div className="p-5">
        <button onClick={onClose} className="text-stone-400 mb-5 flex items-center gap-1 text-sm">← Retour</button>
        <div className="flex items-start gap-3 mb-6">
          <div className={`w-10 h-10 rounded-full ${meta.bg} flex items-center justify-center flex-shrink-0`}>
            <span className={`w-4 h-4 rounded-full ${meta.dot}`} />
          </div>
          <div>
            <h1 className="text-white text-xl font-semibold leading-tight">{wine.name}</h1>
            <div className="text-stone-400 text-sm">{wine.appellation} · {wine.year}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <StatCard label="Prix estimé"   value={fmt(wine.estimated_price)} sub="par bouteille" />
          <StatCard label="Valeur totale" value={fmt((wine.estimated_price || 0) * wine.quantity)} sub={`${wine.quantity} bouteilles`} />
          <StatCard label="Apogée"        value={`${wine.apogee_from || "?"}–${wine.apogee_to || "?"}`} sub={urgency.label} />
          {wine.score && <StatCard label="Score" value={`${wine.score}/100`} />}
        </div>

        {/* Timeline apogée */}
        {wine.apogee_from && wine.apogee_to && (
          <div className="bg-stone-900 rounded-xl p-4 mb-3">
            <div className="text-stone-400 text-xs mb-3">Fenêtre de dégustation</div>
            <div className="relative h-3 bg-stone-800 rounded-full overflow-hidden">
              <div
                className="absolute h-full rounded-full opacity-70"
                style={{
                  left:  `${Math.max(0, ((wine.apogee_from - RANGE_START) / (RANGE_END - RANGE_START)) * 100)}%`,
                  width: `${Math.min(100, ((wine.apogee_to - wine.apogee_from) / (RANGE_END - RANGE_START)) * 100)}%`,
                  backgroundColor: meta.accent,
                }}
              />
              <div
                className="absolute h-full w-0.5 bg-white"
                style={{ left: `${((CURRENT_YEAR - RANGE_START) / (RANGE_END - RANGE_START)) * 100}%` }}
              />
            </div>
            <div className="flex justify-between text-stone-500 text-xs mt-1">
              <span>{RANGE_START}</span><span>Auj.</span><span>{RANGE_END}</span>
            </div>
          </div>
        )}

        {wine.notes && (
          <div className="bg-stone-900 rounded-xl p-4 mb-3">
            <div className="text-stone-400 text-xs mb-1">Notes</div>
            <div className="text-stone-200 text-sm">{wine.notes}</div>
          </div>
        )}

        <div className="text-stone-600 text-xs mb-5">{wine.region} · Ajouté le {wine.added_at?.slice(0, 10)}</div>

        <div className="flex gap-3">
          <button
            onClick={() => { onDrink(wine); onClose(); }}
            className="flex-1 bg-emerald-800 text-white rounded-xl py-3.5 text-sm font-semibold"
          >Marquer comme bue</button>
          <button
            onClick={() => { onDelete(wine); onClose(); }}
            className="bg-stone-800 text-red-400 rounded-xl px-4 py-3.5 text-sm"
          >Supprimer</button>
        </div>
      </div>
    </div>
  );
}

// ─── AUTH SCREEN ──────────────────────────────────────────────────────────────
function AuthScreen({ onAuth }) {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode]         = useState("login"); // login | signup
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [msg, setMsg]           = useState(null);
  const IC = "w-full bg-stone-800 text-white rounded-lg px-3 py-3 text-sm outline-none focus:ring-1 focus:ring-amber-600 mb-3";

  async function submit() {
    setLoading(true); setError(null);
    try {
      if (mode === "login") {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        onAuth(data.user);
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMsg("Vérifiez votre email pour confirmer le compte.");
      }
    } catch (e) { setError(e.message); }
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-stone-950 flex flex-col justify-center px-8 max-w-md mx-auto" style={{ fontFamily: "'Georgia', serif" }}>
      <div className="text-center mb-10">
        <div className="text-5xl mb-3">🍷</div>
        <h1 className="text-white text-2xl font-semibold">Ma Cave</h1>
        <p className="text-stone-500 text-sm mt-1">Votre cave à vin personnelle</p>
      </div>
      <div className="flex bg-stone-900 rounded-xl p-1 mb-6">
        {[["login","Connexion"],["signup","Créer un compte"]].map(([m,l]) => (
          <button key={m} onClick={() => setMode(m)}
            className={`flex-1 py-2 text-sm rounded-lg transition-colors ${mode === m ? "bg-amber-600 text-white" : "text-stone-400"}`}
          >{l}</button>
        ))}
      </div>
      <input type="email"    className={IC} placeholder="Email"        value={email}    onChange={e => setEmail(e.target.value)} />
      <input type="password" className={IC} placeholder="Mot de passe" value={password} onChange={e => setPassword(e.target.value)} />
      {error && <div className="text-red-400 text-xs mb-3 text-center">{error}</div>}
      {msg   && <div className="text-emerald-400 text-xs mb-3 text-center">{msg}</div>}
      <button onClick={submit} disabled={loading || !email || !password}
        className="w-full bg-amber-600 text-white rounded-xl py-3.5 text-sm font-semibold disabled:opacity-40"
      >{loading ? "…" : mode === "login" ? "Se connecter" : "Créer le compte"}</button>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function CaveApp() {
  const [user,  setUser]  = useState(null);
  const [wines, setWines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view,  setView]  = useState("dashboard");
  const [groupBy, setGroupBy] = useState("color");
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");

  // Auth listener
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user || null);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setUser(session?.user || null);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Load wines when user is known
  useEffect(() => {
    if (!user) { setWines([]); return; }
    fetchWines(user.id).then(setWines).catch(console.error);
  }, [user]);

  async function handleDrink(wine) {
    await logTasting(wine);
    const updated = await updateWineQty(wine.id, wine.quantity - 1);
    setWines(ws => updated
      ? ws.map(w => w.id === wine.id ? updated : w)
      : ws.filter(w => w.id !== wine.id)
    );
  }

  async function handleDelete(wine) {
    await deleteWineById(wine.id);
    setWines(ws => ws.filter(w => w.id !== wine.id));
  }

  function handleAdded(wine) {
    setWines(ws => [wine, ...ws]);
  }

  // Stats
  const totalBottles = wines.reduce((s, w) => s + w.quantity, 0);
  const totalValue   = wines.reduce((s, w) => s + (w.estimated_price || 0) * w.quantity, 0);
  const todrink      = wines.filter(w => getDrinkUrgency(w).level !== "wait").length;

  const byColor = { rouge: 0, blanc: 0, rosé: 0, champagne: 0 };
  wines.forEach(w => { byColor[w.color] = (byColor[w.color] || 0) + w.quantity; });

  const priorityWines = [...wines]
    .map(w => ({ ...w, urgency: getDrinkUrgency(w) }))
    .filter(w => w.urgency.level !== "wait")
    .sort((a, b) => b.urgency.score - a.urgency.score);

  const filtered = wines.filter(w =>
    !search || w.name.toLowerCase().includes(search.toLowerCase()) ||
    (w.appellation || "").toLowerCase().includes(search.toLowerCase())
  );

  function groupWines(arr, by) {
    const g = {};
    arr.forEach(w => {
      let k;
      if (by === "color")  k = w.color;
      else if (by === "year")   k = Math.floor(w.year / 5) * 5 + "s";
      else if (by === "price")  k = !w.estimated_price ? "Non estimé" : w.estimated_price < 50 ? "< 50€" : w.estimated_price < 150 ? "50–150€" : w.estimated_price < 500 ? "150–500€" : "> 500€";
      else if (by === "region") k = w.region || "Autre";
      g[k] = g[k] || [];
      g[k].push(w);
    });
    return g;
  }

  if (loading) return (
    <div className="min-h-screen bg-stone-950 flex items-center justify-center">
      <div className="text-stone-500 text-sm">Chargement…</div>
    </div>
  );

  if (!user) return <AuthScreen onAuth={setUser} />;

  const NAV = [
    { id: "dashboard", label: "Cave",    icon: "🍷" },
    { id: "list",      label: "Liste",   icon: "📋" },
    { id: "priority",  label: "À boire", icon: "⏰" },
  ];

  return (
    <div className="min-h-screen bg-stone-950 text-white max-w-md mx-auto relative pb-24" style={{ fontFamily: "'Georgia', serif" }}>
      {/* Header */}
      <div className="px-5 pt-12 pb-5">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Ma Cave</h1>
            <p className="text-stone-400 text-sm">{totalBottles} bouteilles · {fmt(totalValue)}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => supabase.auth.signOut()} className="text-stone-500 text-xs px-2 py-1 rounded-lg bg-stone-900">⎋</button>
            <button onClick={() => setShowAdd(true)} className="bg-amber-600 text-white w-10 h-10 rounded-full flex items-center justify-center text-xl shadow-lg">+</button>
          </div>
        </div>
      </div>

      {/* ── DASHBOARD ── */}
      {view === "dashboard" && (
        <div className="px-5">
          <div className="flex gap-3 mb-5">
            <StatCard label="Bouteilles" value={totalBottles} sub={`${wines.length} références`} />
            <StatCard label="À boire"    value={todrink}       sub="maintenant/bientôt" />
          </div>

          <div className="bg-stone-900 rounded-2xl p-4 mb-5">
            <div className="text-stone-400 text-xs mb-3 uppercase tracking-wider">Répartition</div>
            <div className="flex items-end gap-2 h-16 mb-2">
              {Object.entries(byColor).map(([color, qty]) => {
                const pct = totalBottles > 0 ? (qty / totalBottles) * 100 : 0;
                return (
                  <div key={color} className="flex flex-col items-center gap-1 flex-1">
                    <div className="w-full rounded-t-sm" style={{ height: `${Math.max(pct * 0.56, 2)}px`, backgroundColor: COLOR_META[color]?.accent, opacity: 0.85 }} />
                    <span className="text-stone-500 text-xs">{qty}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-3 flex-wrap">
              {Object.entries(COLOR_META).map(([k, m]) => (
                <span key={k} className="flex items-center gap-1 text-xs text-stone-400">
                  <span className={`w-2 h-2 rounded-full ${m.dot}`} />{m.label}
                </span>
              ))}
            </div>
          </div>

          <div className="mb-2 flex items-center justify-between">
            <div className="text-stone-300 text-sm font-medium">À déboucher bientôt</div>
            <button onClick={() => setView("priority")} className="text-amber-500 text-xs">Tout voir</button>
          </div>
          {priorityWines.slice(0, 3).map(w => (
            <WineCard key={w.id} wine={w} onDrink={handleDrink} onDelete={handleDelete} onClick={setSelected} />
          ))}
          {priorityWines.length === 0 && (
            <div className="text-stone-500 text-sm text-center py-8">Aucune urgence 🎉</div>
          )}
        </div>
      )}

      {/* ── LISTE ── */}
      {view === "list" && (
        <div className="px-5">
          <input
            className="w-full bg-stone-900 text-white rounded-xl px-4 py-2.5 text-sm outline-none mb-3 placeholder-stone-500"
            placeholder="Rechercher…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
            {[["color","Couleur"],["year","Millésime"],["price","Prix"],["region","Région"]].map(([k,l]) => (
              <button key={k} onClick={() => setGroupBy(k)}
                className={`flex-shrink-0 text-xs px-3 py-1.5 rounded-full ${groupBy === k ? "bg-amber-600 text-white" : "bg-stone-800 text-stone-400"}`}
              >{l}</button>
            ))}
          </div>
          {Object.entries(groupWines(filtered, groupBy)).map(([group, ws]) => (
            <div key={group} className="mb-5">
              <div className="text-stone-400 text-xs uppercase tracking-wider mb-2 flex items-center gap-2">
                {groupBy === "color" && <span className={`w-2 h-2 rounded-full ${COLOR_META[group]?.dot}`} />}
                {groupBy === "color" ? COLOR_META[group]?.label : group}
                <span className="text-stone-600">({ws.reduce((s, w) => s + w.quantity, 0)} btl)</span>
              </div>
              {ws.map(w => <WineCard key={w.id} wine={w} onDrink={handleDrink} onDelete={handleDelete} onClick={setSelected} />)}
            </div>
          ))}
          {filtered.length === 0 && <div className="text-stone-500 text-center py-10">Aucun résultat</div>}
        </div>
      )}

      {/* ── PRIORITÉS ── */}
      {view === "priority" && (
        <div className="px-5">
          <div className="bg-stone-900 rounded-2xl p-4 mb-5">
            <div className="text-stone-300 text-sm font-medium mb-1">Recommandations</div>
            <div className="text-stone-500 text-xs">Classées par urgence selon la fenêtre d'apogée.</div>
          </div>
          {[
            { level: "critical", label: "🔴 En déclin — à boire maintenant" },
            { level: "now",      label: "🟢 Apogée — moment idéal" },
            { level: "soon",     label: "🟡 Bientôt prêt" },
          ].map(({ level, label }) => {
            const ws = priorityWines.filter(w => w.urgency.level === level);
            if (!ws.length) return null;
            return (
              <div key={level} className="mb-5">
                <div className="text-xs text-stone-400 mb-2 font-medium">{label}</div>
                {ws.map(w => <WineCard key={w.id} wine={w} onDrink={handleDrink} onDelete={handleDelete} onClick={setSelected} />)}
              </div>
            );
          })}
          {priorityWines.length === 0 && (
            <div className="text-stone-500 text-center py-10">Toutes vos bouteilles peuvent attendre ✓</div>
          )}
        </div>
      )}

      {/* Nav */}
      <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-stone-950 border-t border-stone-800 flex">
        {NAV.map(n => (
          <button key={n.id} onClick={() => setView(n.id)}
            className={`flex-1 py-4 flex flex-col items-center gap-0.5 text-xs ${view === n.id ? "text-amber-400" : "text-stone-500"}`}
          >
            <span className="text-lg">{n.icon}</span><span>{n.label}</span>
          </button>
        ))}
        <button onClick={() => setShowAdd(true)} className="flex-1 py-4 flex flex-col items-center gap-0.5 text-xs text-stone-500">
          <span className="text-lg">＋</span><span>Ajouter</span>
        </button>
      </nav>

      {showAdd && <AddWineSheet userId={user.id} onClose={() => setShowAdd(false)} onAdded={handleAdded} />}
      {selected && <WineDetail wine={selected} onClose={() => setSelected(null)} onDrink={handleDrink} onDelete={handleDelete} />}
    </div>
  );
}
