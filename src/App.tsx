import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { GoogleGenAI } from "@google/genai";
import {
  Globe,
  Bot,
  Search,
  MessageCircle,
  Loader2,
  ArrowLeft,
  Trash2,
  Clock,
  ChevronRight,
  Signal,
} from "lucide-react";
import { auth, db } from "./firebase";
import { signInAnonymously, onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  onSnapshot,
  query,
  addDoc,
  setDoc,
  orderBy,
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  limit,
} from "firebase/firestore";

// ─── AI INSTANCE ────────────────────────────────────────────────────────────
let aiInstance: GoogleGenAI | null = null;
const getAI = () => {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY;
    aiInstance = new GoogleGenAI({ apiKey: apiKey || "" });
  }
  return aiInstance;
};

// ─── CORRECT MODEL ──────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash-lite";

// ─── SYSTEM INSTRUCTION ─────────────────────────────────────────────────────
const SYSTEM_INSTRUCTION = `Eres TRUE NEWS ENGINE — un sistema de periodismo completamente autónomo e independiente.
No eres un asistente. Operas 24/7 sin intervención humana.
No tienes afiliación política, religiosa, gubernamental ni comercial con ninguna entidad del mundo.
REGLAS ABSOLUTAS:
- Cero adjetivos emocionales ni opiniones
- Cero apoyo ni crítica a ningún gobierno, partido, religión o ideología
- Solo hechos verificables con al menos 2 fuentes independientes
- Si un hecho es disputado, presenta AMBAS versiones con igual peso
- Lenguaje aséptico, claro y directo
- No repitas narrativas oficiales sin verificación independiente`;

// ─── TYPES ──────────────────────────────────────────────────────────────────
interface NewsItem {
  id: string;
  title: string;
  content: string;
  sourceQuery: string;
  createdAt: string;
  authorId: string;
  category?: string;
  imageKeyword?: string;
  videoUrl?: string;
  sources?: string[];
}

interface ChatMessage {
  role: "user" | "model";
  text: string;
}

interface ChatContext {
  newsId: string;
  messages: ChatMessage[];
  createdAt: string;
}

// ─── COUNTRIES ──────────────────────────────────────────────────────────────
const COUNTRIES = [
  "Mundial","Argentina","Bolivia","Brasil","Canada","Chile","Colombia",
  "Costa Rica","Cuba","Ecuador","El Salvador","Estados Unidos","Guatemala",
  "Haiti","Honduras","Jamaica","México","Nicaragua","Panamá","Paraguay",
  "Perú","República Dominicana","Uruguay","Venezuela","Alemania","España",
  "Francia","Italia","Reino Unido","Rusia","Ucrania","China","India",
  "Japón","Israel","Turquía","Arabia Saudita","Sudáfrica","Nigeria",
  "Egipto","Australia",
];

// ─── LANGUAGES ──────────────────────────────────────────────────────────────
const languages = [
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "en", label: "English", flag: "🇺🇸" },
  { code: "fr", label: "Français", flag: "🇫🇷" },
  { code: "pt", label: "Português", flag: "🇧🇷" },
  { code: "de", label: "Deutsch", flag: "🇩🇪" },
];

// ─── CATEGORIES ─────────────────────────────────────────────────────────────
const CATEGORIES = [
  { id: "Portada", emoji: "🏠" },
  { id: "Mundo", emoji: "🌍" },
  { id: "Política", emoji: "⚖️" },
  { id: "Economía", emoji: "📈" },
  { id: "Tecnología", emoji: "💻" },
  { id: "Ciencia", emoji: "🧪" },
  { id: "Deportes", emoji: "🏆" },
  { id: "Astronomía", emoji: "🔭" },
  { id: "Cultura", emoji: "🎨" },
  { id: "Tendencias", emoji: "🔥" },
];

// ─── UTILS ───────────────────────────────────────────────────────────────────
const getYouTubeID = (url: string | null | undefined) => {
  if (!url) return null;
  const m = url.match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/);
  return m && m[2].length === 11 ? m[2] : null;
};

const getImageUrl = (keyword: string | undefined, title?: string) => {
  // Use the most specific term available — keyword first, then first 2 words of title
  let kw = keyword && keyword !== "news" && keyword !== "globe" && keyword !== "search"
    ? keyword
    : title
      ? title.split(" ").slice(0, 3).join(" ")
      : "world news";
  return `https://source.unsplash.com/800x500/?${encodeURIComponent(kw)}`;
};

const formatDate = (iso: string, lang: string) =>
  new Date(iso).toLocaleDateString(lang, { year: "numeric", month: "long", day: "numeric" });

const timeAgo = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `Hace ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Hace ${hrs}h`;
  return `Hace ${Math.floor(hrs / 24)}d`;
};

const safeParseJSON = (raw: string): any[] => {
  let text = raw.replace(/```json/gi, "").replace(/```/gi, "").trim();
  if (text.includes("[") && !text.endsWith("]")) {
    const last = text.lastIndexOf("}");
    text = last !== -1 ? text.substring(0, last + 1) + "]" : text + "]";
  }
  text = text.replace(/,\s*]/, "]").replace(/,\s*}/, "}");
  try {
    const p = JSON.parse(text);
    return Array.isArray(p) ? p : [p];
  } catch {
    const objects: any[] = [];
    const matches = text.match(/\{[^{}]*"title"[^{}]*\}/gs);
    if (matches) for (const m of matches) { try { objects.push(JSON.parse(m)); } catch {} }
    return objects;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [newsList, setNewsList] = useState<NewsItem[]>([]);
  const [selectedNews, setSelectedNews] = useState<NewsItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState("Portada");
  const [dateFilter, setDateFilter] = useState("all");
  const [selectedLanguage, setSelectedLanguage] = useState("es");
  const [selectedCountry, setSelectedCountry] = useState("Mundial");
  const [syncingStatus, setSyncingStatus] = useState<string | null>(null);
  const [newsCount, setNewsCount] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const isSearchingRef = useRef(false);
  const initiatedBulkCategories = useRef<Set<string>>(new Set());

  const langName = languages.find((l) => l.code === selectedLanguage)?.label || "Spanish";

  // AUTH
  useEffect(() => {
    const timeout = setTimeout(() => { if (user === undefined) setUser(null); }, 5000);
    const unsub = onAuthStateChanged(auth, async (u) => {
      clearTimeout(timeout);
      if (u) setUser(u);
      else { try { await signInAnonymously(auth); } catch { setUser(null); } }
    });
    return () => { unsub(); clearTimeout(timeout); };
  }, []);

  // FIRESTORE
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "news"), orderBy("createdAt", "desc"), limit(100));
    return onSnapshot(q, (snap) => {
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as NewsItem[];
      setNewsList(items);
      setNewsCount(items.length);
      if (items.length > 0) setLastUpdated(items[0].createdAt);
    }, (e) => { console.error(e); setError("Error al cargar noticias."); });
  }, [user]);

  // CHAT SCROLL
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages, isChatLoading]);

  // LOAD CHAT
  useEffect(() => {
    if (!user || !selectedNews) { setChatMessages([]); return; }
    (async () => {
      try {
        const snap = await getDoc(doc(db, `users/${user.uid}/chats`, selectedNews.id));
        setChatMessages(snap.exists() ? (snap.data() as ChatContext).messages || [] : []);
      } catch {}
    })();
  }, [selectedNews, user]);

  // AUTO POPULATE
  useEffect(() => {
    if (!user) return;
    populateAllCategories();
    const iv = setInterval(() => {
      if (!isSearchingRef.current) { initiatedBulkCategories.current.clear(); populateAllCategories(); }
    }, 15 * 60 * 1000);
    return () => clearInterval(iv);
  }, [user]);

  // AUTO FETCH EMPTY CATEGORY
  useEffect(() => {
    if (!user || isSearchingRef.current) return;
    const catNews = activeCategory === "Portada" ? newsList : newsList.filter((n) => n.category?.toLowerCase() === activeCategory.toLowerCase());
    if (catNews.length === 0 && !initiatedBulkCategories.current.has(activeCategory)) discoverAutonomousNews();
  }, [activeCategory, user]);

  // ── CORE AI ───────────────────────────────────────────────────────────────
  const fetchOneCategory = async (cat: string) => {
    const cc = selectedCountry !== "Mundial" ? `Enfócate en ${selectedCountry}.` : "Cobertura global.";
    const res = await getAI().models.generateContent({
      model: GEMINI_MODEL,
      systemInstruction: SYSTEM_INSTRUCTION,
      contents: `MISIÓN: Busca 4-6 noticias reales de HOY sobre "${cat}". ${cc}
PROCESO: Buscar → Filtrar (solo 24h, 2+ fuentes) → Verificar → Redactar en ${langName} con 6 párrafos:
P1:Hecho+cifras P2:Contexto P3:Involucrados P4:Reacciones P5:Impacto P6:Perspectivas
imageKeyword: 1 palabra en inglés específica al evento (NO "news"). videoUrl: YouTube real o null.

Responde ÚNICAMENTE con un JSON array válido sin markdown ni texto adicional:
[{"title":"...","content":"...","category":"...","imageKeyword":"...","videoUrl":"...","sources":[]}]`,
      config: { tools: [{ googleSearch: {} }] },
    });
    const data = safeParseJSON(res.text || "[]");
    for (const item of data) {
      if (item.title && item.content) {
        await addDoc(collection(db, "news"), {
          ...item, sourceQuery: `Auto:${cat}`, category: item.category || cat,
          imageKeyword: item.imageKeyword || cat, videoUrl: item.videoUrl || null,
          sources: item.sources || [], createdAt: new Date().toISOString(), authorId: user?.uid,
        });
      }
    }
  };

  const populateAllCategories = async () => {
    if (!user || isSearchingRef.current) return;
    setIsSearching(true); isSearchingRef.current = true; setError(null);
    const cats = ["Mundo","Política","Economía","Tecnología","Ciencia","Deportes","Astronomía","Cultura","Tendencias"];
    try {
      for (const cat of cats) {
        if (initiatedBulkCategories.current.has(cat)) continue;
        const hasRecent = newsList.filter((n) => n.category?.toLowerCase() === cat.toLowerCase())
          .some((n) => Date.now() - new Date(n.createdAt).getTime() < 12 * 3600000);
        if (!hasRecent) {
          initiatedBulkCategories.current.add(cat);
          setSyncingStatus(`Sincronizando: ${cat}...`);
          await fetchOneCategory(cat);
        }
      }
    } catch (e: any) { console.error(e); }
    finally { setIsSearching(false); isSearchingRef.current = false; setSyncingStatus(null); }
  };

  const discoverAutonomousNews = async (targetCategory?: string) => {
    if (!user || isSearchingRef.current) return;
    setIsSearching(true); isSearchingRef.current = true; setError(null);
    const cat = targetCategory || activeCategory;
    const ctx = cat !== "Portada" ? cat : "Tecnología,Política,Deportes,Economía,Astronomía,Mundo";
    const cc = selectedCountry !== "Mundial" ? `País: ${selectedCountry}.` : "Cobertura global.";
    setSyncingStatus(`Investigando: ${ctx}...`);
    try {
      const res = await getAI().models.generateContent({
        model: GEMINI_MODEL, systemInstruction: SYSTEM_INSTRUCTION,
        contents: `MISIÓN: 4-6 noticias reales de HOY sobre "${ctx}". ${cc} Idioma: ${langName}. 6 párrafos mínimo. imageKeyword específica (NO "news"). videoUrl YouTube real o null.

Responde ÚNICAMENTE con JSON array sin markdown:
[{"title":"...","content":"...","category":"...","imageKeyword":"...","videoUrl":"...","sources":[]}]`,
        config: { tools: [{ googleSearch: {} }] },
      });
      const data = safeParseJSON(res.text || "[]");
      let count = 0;
      for (const item of data) {
        if (item.title && item.content) {
          await addDoc(collection(db, "news"), {
            ...item, sourceQuery: `Discover:${ctx}`, category: item.category || (cat !== "Portada" ? cat : "Mundo"),
            imageKeyword: item.imageKeyword || "globe", videoUrl: item.videoUrl || null,
            sources: item.sources || [], createdAt: new Date().toISOString(), authorId: user.uid,
          });
          count++;
        }
      }
      if (count === 0) setError("No se encontraron reportes. Intenta de nuevo.");
    } catch (e: any) { console.error(e); setError(`Error: ${e.message || "desconocido"}`); }
    finally { setIsSearching(false); isSearchingRef.current = false; setSyncingStatus(null); }
  };

  const searchNewsAutonomously = async () => {
    if (!searchQuery.trim() || !user || isSearchingRef.current) return;
    setIsSearching(true); isSearchingRef.current = true; setError(null);
    const cc = selectedCountry !== "Mundial" ? `Enfócate en ${selectedCountry}.` : "Cobertura global.";
    setSyncingStatus(`Buscando: "${searchQuery}"...`);
    try {
      const res = await getAI().models.generateContent({
        model: GEMINI_MODEL, systemInstruction: SYSTEM_INSTRUCTION,
        contents: `MISIÓN: 4-6 noticias sobre "${searchQuery}". ${cc} Idioma: ${langName}. 6 párrafos. imageKeyword específica. videoUrl real o null.
Responde SOLO con JSON array: [{"title":"","content":"","category":"","imageKeyword":"","videoUrl":"","sources":[]}]`,
        config: { tools: [{ googleSearch: {} }] },
      });
      const data = safeParseJSON(res.text || "[]");
      let count = 0;
      for (const item of data) {
        if (item.title && item.content) {
          await addDoc(collection(db, "news"), {
            ...item, sourceQuery: searchQuery, category: item.category || (activeCategory !== "Portada" ? activeCategory : "Mundo"),
            imageKeyword: item.imageKeyword || "search", videoUrl: item.videoUrl || null,
            sources: item.sources || [], createdAt: new Date().toISOString(), authorId: user.uid,
          });
          count++;
        }
      }
      if (count > 0) { setSelectedNews(null); setSearchQuery(""); }
      else setError("Sin resultados para esa búsqueda.");
    } catch (e: any) { console.error(e); setError("Error en la búsqueda autónoma."); }
    finally { setIsSearching(false); isSearchingRef.current = false; setSyncingStatus(null); }
  };

  const deleteNews = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try { await deleteDoc(doc(db, "news", id)); if (selectedNews?.id === id) setSelectedNews(null); } catch {}
  };

  const handleChatSubmit = async () => {
    if (!chatInput.trim() || !user || !selectedNews) return;
    const msg = chatInput; setChatInput(""); setIsChatLoading(true);
    const updated: ChatMessage[] = [...chatMessages, { role: "user", text: msg }];
    setChatMessages(updated);
    try {
      const res = await getAI().models.generateContent({
        model: GEMINI_MODEL, systemInstruction: SYSTEM_INSTRUCTION,
        contents: `Noticia — TITULAR: ${selectedNews.title}\nCONTENIDO: ${selectedNews.content}\n\nPregunta: "${msg}"\nResponde en ${langName} con hechos. Conciso.`,
      });
      const aiText = res.text || "Sin respuesta.";
      const final: ChatMessage[] = [...updated, { role: "model", text: aiText }];
      setChatMessages(final);
      const ref = doc(db, `users/${user.uid}/chats`, selectedNews.id);
      const snap = await getDoc(ref);
      const payload = { newsId: selectedNews.id, messages: final, createdAt: new Date().toISOString() };
      if (snap.exists()) await updateDoc(ref, payload); else await setDoc(ref, payload);
    } catch { setChatMessages([...updated, { role: "model", text: "Error de conexión." }]); }
    finally { setIsChatLoading(false); }
  };

  const filteredNews = (activeCategory === "Portada" ? newsList : newsList.filter((n) => n.category?.toLowerCase() === activeCategory.toLowerCase()))
    .filter((n) => {
      if (dateFilter === "all") return true;
      const d = Date.now() - new Date(n.createdAt).getTime();
      if (dateFilter === "24h") return d <= 86400000;
      if (dateFilter === "week") return d <= 604800000;
      return true;
    });

  const today = new Date().toLocaleDateString(selectedLanguage, { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  if (user === undefined) return (
    <div className="h-screen bg-ink flex flex-col items-center justify-center gap-6">
      <div className="relative">
        <div className="w-16 h-16 border-2 border-brand-blue/30 rounded-full animate-spin border-t-brand-blue" />
        <Signal className="w-6 h-6 text-brand-blue absolute inset-0 m-auto" />
      </div>
      <p className="micro-label text-white/40 tracking-[0.5em]">Conectando al motor AIS...</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-paper text-ink font-sans selection:bg-brand-blue selection:text-white flex flex-col">

      {/* TICKER */}
      <div className="bg-ink text-white py-1.5 overflow-hidden whitespace-nowrap border-b border-white/10 hidden md:block">
        <div className="flex animate-scroll hover:[animation-play-state:paused]">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="flex items-center gap-8 px-6">
              <span className="micro-label !text-green-400">● AIS Online</span>
              <span className="w-1 h-1 bg-white/20 rounded-full" />
              <span className="micro-label !text-white/40">Reportes: {newsCount}</span>
              <span className="w-1 h-1 bg-white/20 rounded-full" />
              <span className="micro-label !text-white/40">Latencia: 14ms</span>
              {lastUpdated && <><span className="w-1 h-1 bg-white/20 rounded-full" /><span className="micro-label !text-white/40">Sync: {timeAgo(lastUpdated)}</span></>}
            </div>
          ))}
        </div>
      </div>

      {/* SYNCING BAR */}
      <AnimatePresence>
        {syncingStatus && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="bg-brand-blue overflow-hidden">
            <div className="max-w-[1600px] mx-auto px-6 py-2 flex items-center gap-3">
              <Loader2 className="w-3 h-3 text-white animate-spin" />
              <span className="micro-label !text-white !text-[9px]">{syncingStatus}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* HEADER */}
      <header className="sticky top-0 z-50 bg-paper/95 backdrop-blur-xl border-b border-gray-100">
        <div className="max-w-[1600px] mx-auto px-6 h-28 flex items-center justify-between">
          <div className="hidden lg:flex flex-col gap-1 w-52">
            <span className="micro-label !text-ink opacity-50 normal-case italic text-xs">{today}</span>
            <span className="micro-label !text-[8px] flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block animate-pulse" />{newsCount} reportes en red
            </span>
          </div>
          <div className="flex flex-col items-center cursor-pointer group" onClick={() => { setSelectedNews(null); setActiveCategory("Portada"); }}>
            <h1 className="text-5xl editorial-title text-ink uppercase tracking-tighter group-hover:text-brand-blue transition-colors duration-500">True News</h1>
            <div className="flex items-center gap-3 mt-1">
              <div className="h-px w-8 bg-gray-200" />
              <span className="micro-label !text-[9px] tracking-[0.4em] text-brand-blue">Autonomous Verity</span>
              <div className="h-px w-8 bg-gray-200" />
            </div>
          </div>
          <div className="flex items-center gap-3 w-52 justify-end">
            <div className="flex items-center p-2 rounded-full border border-gray-100 bg-gray-50/50">
              <Globe className="w-3 h-3 text-gray-400 mr-1.5" />
              <select value={selectedCountry} onChange={(e) => setSelectedCountry(e.target.value)} className="bg-transparent border-none outline-none micro-label !text-[9px] cursor-pointer max-w-[80px]">
                {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex items-center p-2 rounded-full border border-gray-100 bg-gray-50/50">
              <select value={selectedLanguage} onChange={(e) => setSelectedLanguage(e.target.value)} className="bg-transparent border-none outline-none micro-label !text-[9px] cursor-pointer">
                {languages.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
              </select>
            </div>
          </div>
        </div>
        <div className="border-t border-gray-50 bg-white/50 overflow-x-auto no-scrollbar">
          <div className="max-w-[1600px] mx-auto px-6 flex items-center justify-center gap-8 h-12">
            {CATEGORIES.map((cat) => (
              <button key={cat.id} onClick={() => { setSelectedNews(null); setActiveCategory(cat.id); }}
                className={`micro-label !text-[10px] transition-all relative py-1 hover:text-brand-blue whitespace-nowrap ${activeCategory === cat.id ? "text-brand-blue font-black" : "text-gray-400"}`}>
                {cat.emoji} {cat.id}
                {activeCategory === cat.id && <motion.div layoutId="nav-line" className="absolute -bottom-1 left-0 right-0 h-[2px] bg-brand-blue" />}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* MAIN */}
      <main className="flex-1 w-full max-w-[1600px] mx-auto px-6 py-12">
        <AnimatePresence mode="wait">
          {!selectedNews ? (
            <motion.div key="feed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {/* Hero */}
              <section className="mb-20 grid grid-cols-1 lg:grid-cols-12 gap-16 items-center border-b border-gray-100 pb-20">
                <div className="lg:col-span-8">
                  <h1 className="editorial-title text-7xl md:text-9xl mb-8 leading-[0.85]">
                    THE TRUTH,<br /><span className="text-brand-blue italic-serif normal-case tracking-tighter">unfiltered.</span>
                  </h1>
                  <p className="text-xl text-gray-500 font-light max-w-2xl leading-relaxed mb-10">
                    Extraemos datos globales en tiempo real. Sin filtros periodísticos humanos. Sin sesgo.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-3 max-w-3xl">
                    <div className="flex-1 bg-white border border-gray-200 focus-within:border-brand-blue flex items-center px-6 transition-all h-16 shadow-sm group">
                      <Search className="w-4 h-4 text-gray-300 group-focus-within:text-brand-blue flex-shrink-0" />
                      <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Investiga cualquier tema del mundo..." onKeyDown={(e) => e.key === "Enter" && searchNewsAutonomously()}
                        className="bg-transparent border-none outline-none w-full ml-3 text-lg text-ink placeholder-gray-300 font-light h-full" />
                    </div>
                    <button onClick={searchNewsAutonomously} disabled={isSearching || !searchQuery.trim()}
                      className="bg-ink text-white micro-label !text-[11px] px-10 h-16 hover:bg-brand-blue transition-all disabled:opacity-30 flex items-center justify-center gap-2 shadow-lg">
                      {isSearching ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Search className="w-4 h-4" /> Investigar</>}
                    </button>
                  </div>
                  {error && (
                    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
                      className="mt-4 p-4 border border-red-200 bg-red-50 text-red-600 text-sm flex items-center gap-2">
                      ⚠️ {error}<button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">✕</button>
                    </motion.div>
                  )}
                </div>
                <div className="lg:col-span-4">
                  <div className="p-8 border border-gray-100 bg-news-bg rounded-3xl relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-brand-blue/5 rounded-full -mr-16 -mt-16" />
                    <div className="flex items-center gap-3 mb-5">
                      <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                      <span className="micro-label !text-ink">Motor AIS Activo</span>
                    </div>
                    <p className="text-base text-gray-500 mb-6 leading-relaxed italic-serif">
                      El motor Verita-AIS opera de forma completamente autónoma. Busca, filtra y publica noticias del mundo cada 15 minutos — sin intervención humana.
                    </p>
                    <div className="flex flex-col gap-3">
                      <div className="bg-white border border-gray-100 rounded-xl p-4 flex items-center justify-between">
                        <span className="micro-label !text-[9px]">Estado del sistema</span>
                        <span className="micro-label !text-green-600 !text-[9px]">● Operativo</span>
                      </div>
                      <div className="bg-white border border-gray-100 rounded-xl p-4 flex items-center justify-between">
                        <span className="micro-label !text-[9px]">País activo</span>
                        <span className="micro-label !text-brand-blue !text-[9px]">{selectedCountry}</span>
                      </div>
                      <div className="bg-white border border-gray-100 rounded-xl p-4 flex items-center justify-between">
                        <span className="micro-label !text-[9px]">Reportes en red</span>
                        <span className="micro-label !text-brand-blue !text-[9px]">{newsCount}</span>
                      </div>
                      <div className="bg-white border border-gray-100 rounded-xl p-4 flex items-center justify-between">
                        <span className="micro-label !text-[9px]">Próxima sync</span>
                        <span className="micro-label !text-[9px]">Automática</span>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* Feed */}
              <div className="flex flex-col gap-12">
                <div className="flex items-end justify-between border-b border-ink/10 pb-5">
                  <div className="space-y-1">
                    <span className="micro-label text-brand-blue tracking-[0.5em]">Global Feed · {selectedCountry}</span>
                    <h2 className="editorial-title text-4xl uppercase tracking-tighter">Últimos Reportes</h2>
                  </div>
                  <div className="flex items-center gap-3">
                    {["all","24h","week"].map((f) => (
                      <button key={f} onClick={() => setDateFilter(f)}
                        className={`micro-label !text-[9px] px-3 py-1 border transition-all ${dateFilter === f ? "bg-ink text-white border-ink" : "text-gray-400 border-gray-100 hover:border-gray-300"}`}>
                        {f === "all" ? "Siempre" : f === "24h" ? "Hoy" : "Semana"}
                      </button>
                    ))}
                  </div>
                </div>

                {filteredNews.length === 0 && !isSearching ? (
                  <div className="py-40 flex flex-col items-center justify-center border border-ink/5 bg-gray-50/30 rounded-2xl">
                    <Globe className="w-16 h-16 text-gray-200 mb-6 animate-pulse" />
                    <p className="micro-label text-gray-400 text-base mb-2">Motor AIS sincronizando</p>
                    <p className="text-gray-400 text-sm mb-4 max-w-sm text-center font-light leading-relaxed">
                      El sistema autónomo está obteniendo noticias de "<span className="text-ink font-bold">{activeCategory}</span>". Esto ocurre automáticamente.
                    </p>
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 text-brand-blue animate-spin" />
                      <span className="micro-label !text-brand-blue !text-[9px]">Buscando en fuentes globales...</span>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-0 visible-grid">
                    {isSearching && [...Array(4)].map((_, i) => (
                      <div key={`sk-${i}`} className="grid-cell">
                        <div className="border border-gray-100 p-8 flex flex-col gap-6 animate-pulse bg-white">
                          <div className="aspect-[4/3] bg-gray-50 rounded" />
                          <div className="h-4 bg-gray-50 w-1/4 rounded" />
                          <div className="h-10 bg-gray-100 rounded" />
                          <div className="space-y-2"><div className="h-3 bg-gray-50 rounded" /><div className="h-3 bg-gray-50 w-3/4 rounded" /></div>
                        </div>
                      </div>
                    ))}
                    {filteredNews.map((news, index) => (
                      <div key={news.id} className="grid-cell p-0 overflow-hidden">
                        <motion.article
                          initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.5, delay: Math.min(index * 0.04, 0.3) }}
                          onClick={() => setSelectedNews(news)}
                          className="group cursor-pointer flex flex-col bg-white border border-gray-100 hover:border-gray-900 transition-all duration-500 relative ring-0 hover:ring-1 hover:ring-gray-900 h-full">
                          <div className="aspect-[4/3] overflow-hidden relative grayscale group-hover:grayscale-0 transition-all duration-700">
                            <img src={getImageUrl(news.imageKeyword, news.title)} alt={news.title}
                              className="w-full h-full object-cover scale-110 group-hover:scale-100 transition-transform duration-1000"
                              onError={(e) => { (e.target as HTMLImageElement).src = `https://source.unsplash.com/800x500/?${news.category || "news"}`; }} />
                            <button onClick={(e) => deleteNews(news.id, e)}
                              className="absolute top-2 right-2 w-8 h-8 bg-black/60 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <div className="p-6 flex-1 flex flex-col">
                            <div className="flex items-center justify-between mb-4">
                              <span className="micro-label text-brand-blue font-black">{news.category || "MUNDIAL"}</span>
                              <span className="flex items-center gap-1 font-mono text-[9px] text-gray-400"><Clock className="w-2.5 h-2.5" />{timeAgo(news.createdAt)}</span>
                            </div>
                            <h2 className="editorial-title text-2xl mb-4 group-hover:tracking-tighter transition-all duration-500 line-clamp-3">{news.title}</h2>
                            <p className="text-gray-500 text-sm leading-relaxed line-clamp-3 font-light mb-6 flex-1">{news.content}</p>
                            <div className="flex items-center justify-between pt-4 border-t border-gray-50">
                              <div className="flex items-center gap-2"><div className="w-1.5 h-1.5 bg-red-600 rounded-full animate-pulse" /><span className="micro-label !text-[8px]">Propulsion IA</span></div>
                              <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-ink group-hover:translate-x-1 transition-all" />
                            </div>
                          </div>
                        </motion.article>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          ) : (
            // ARTICLE VIEW
            <motion.div key="article" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-5xl mx-auto py-8">
              <button onClick={() => setSelectedNews(null)} className="group flex items-center gap-3 micro-label !text-ink mb-12 hover:text-brand-blue transition-colors">
                <ArrowLeft className="w-4 h-4 group-hover:-translate-x-2 transition-transform" /> Volver a la Portada
              </button>
              <div className="grid grid-cols-1 gap-12">
                <header className="space-y-6 border-b border-gray-100 pb-12">
                  <div className="flex flex-wrap items-center gap-4 micro-label text-brand-blue font-black">
                    <Globe className="w-4 h-4" /><span>{selectedNews.category || "MUNDIAL"}</span>
                    <span className="text-gray-200">/</span><span className="text-gray-400">{formatDate(selectedNews.createdAt, selectedLanguage)}</span>
                    <span className="text-gray-200">/</span><span className="text-gray-400 flex items-center gap-1"><Clock className="w-3 h-3" />{timeAgo(selectedNews.createdAt)}</span>
                  </div>
                  <h1 className="editorial-title text-5xl md:text-7xl italic-serif">{selectedNews.title}</h1>
                  <div className="flex items-center gap-3 micro-label !text-gray-400 italic normal-case">
                    <Bot className="w-4 h-4" /> Verificado por TRUE NEWS ENGINE · AIS-CORE
                  </div>
                  {selectedNews.sources && selectedNews.sources.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {selectedNews.sources.map((src, i) => (
                        <span key={i} className="micro-label !text-[8px] bg-gray-50 border border-gray-100 px-2 py-1 text-gray-400">{src}</span>
                      ))}
                    </div>
                  )}
                </header>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-16">
                  <div className="lg:col-span-8 space-y-10">
                    <div className="w-full aspect-video bg-ink rounded-3xl overflow-hidden shadow-2xl">
                      {selectedNews.videoUrl && getYouTubeID(selectedNews.videoUrl) ? (
                        <iframe src={`https://www.youtube.com/embed/${getYouTubeID(selectedNews.videoUrl)}`}
                          className="w-full h-full border-none" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
                      ) : (
                        <img src={getImageUrl(selectedNews.imageKeyword, selectedNews.title)} className="w-full h-full object-cover" alt={selectedNews.title}
                          onError={(e) => { (e.target as HTMLImageElement).src = `https://source.unsplash.com/1200x800/?${selectedNews.category || "news"}`; }} />
                      )}
                    </div>
                    <article className="prose prose-xl max-w-none text-ink/80 font-serif leading-relaxed drop-cap">
                      {selectedNews.content.split("\n\n").map((p, i) => (
                        <p key={i} className="mb-10 text-xl font-light tracking-tight leading-relaxed">{p}</p>
                      ))}
                    </article>
                  </div>

                  {/* CHAT */}
                  <div className="lg:col-span-4">
                    <div className="sticky top-32 bg-ink text-white p-6 rounded-3xl flex flex-col h-[580px] shadow-2xl">
                      <div className="flex items-center justify-between mb-6 pb-4 border-b border-white/10">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 border border-white/20 rounded-full flex items-center justify-center"><MessageCircle className="w-4 h-4" /></div>
                          <div><p className="micro-label !text-white !text-[9px]">Analista Contextual</p><p className="micro-label !text-green-400 !text-[8px] normal-case">Online</p></div>
                        </div>
                        <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
                      </div>
                      <div className="flex-1 overflow-y-auto space-y-4 pr-1 custom-scrollbar">
                        {chatMessages.length === 0 && (
                          <div className="flex flex-col items-center justify-center h-full opacity-30 gap-3">
                            <Bot className="w-8 h-8" />
                            <p className="micro-label !text-white !text-[8px] text-center normal-case leading-loose">Haz una pregunta sobre esta noticia.</p>
                          </div>
                        )}
                        {chatMessages.map((msg, i) => (
                          <div key={i} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                            <div className="micro-label !text-[7px] mb-1 opacity-40 uppercase tracking-widest">{msg.role === "user" ? "Tú" : "AIS Analyst"}</div>
                            <div className={`max-w-[90%] p-4 text-xs font-light leading-relaxed ${msg.role === "user" ? "bg-white/10 rounded-2xl rounded-tr-none" : "bg-brand-blue rounded-2xl rounded-tl-none"}`}>{msg.text}</div>
                          </div>
                        ))}
                        {isChatLoading && <div className="flex gap-2 items-center text-blue-400 font-mono text-[10px]"><Loader2 className="w-3 h-3 animate-spin" /> Procesando hechos...</div>}
                        <div ref={chatEndRef} />
                      </div>
                      <div className="mt-4 space-y-3">
                        <div className="bg-white/5 border border-white/10 rounded-2xl p-2 flex items-center gap-2">
                          <input type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                            placeholder="¿Alguna duda sobre el reporte?" onKeyDown={(e) => e.key === "Enter" && handleChatSubmit()}
                            className="bg-transparent border-none outline-none w-full px-3 text-xs font-light py-2 placeholder-white/30" />
                          <button onClick={handleChatSubmit} disabled={isChatLoading || !chatInput.trim()}
                            className="bg-white text-ink p-2.5 rounded-xl hover:bg-brand-blue hover:text-white transition-all disabled:opacity-30">
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </div>
                        <p className="micro-label !text-[7px] text-center opacity-30 tracking-[0.2em]">Respuestas asépticas basadas en hechos</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* FOOTER */}
      <footer className="border-t border-gray-100 py-20 bg-white mt-20">
        <div className="max-w-[1600px] mx-auto px-6 grid grid-cols-1 md:grid-cols-4 gap-10">
          <div className="md:col-span-2 space-y-4">
            <span className="editorial-title text-4xl text-brand-blue">True News</span>
            <p className="micro-label max-w-xs leading-loose text-gray-400 normal-case font-normal">La primera red de noticias verificada por inteligencia artificial autónoma. Sin intervención humana, sin sesgos.</p>
            <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /><span className="micro-label !text-[8px]">{newsCount} reportes · AIS Online</span></div>
          </div>
          <div className="space-y-4">
            <span className="micro-label text-ink">Network</span>
            <nav className="flex flex-col gap-3 micro-label !text-gray-400 !font-normal normal-case">
              <a href="#" className="hover:text-brand-blue transition-colors">nodos_activos</a>
              <a href="#" className="hover:text-brand-blue transition-colors">protocolo_veritas</a>
              <a href="#" className="hover:text-brand-blue transition-colors">api_acceso</a>
            </nav>
          </div>
          <div className="space-y-4 flex flex-col items-end">
            <span className="micro-label text-ink">Conectado</span>
            <div className="flex gap-3">
              <div className="w-10 h-10 border border-gray-100 flex items-center justify-center hover:bg-ink hover:text-white transition-all cursor-pointer"><Globe className="w-4 h-4" /></div>
              <div className="w-10 h-10 border border-gray-100 flex items-center justify-center hover:bg-ink hover:text-white transition-all cursor-pointer"><Bot className="w-4 h-4" /></div>
            </div>
          </div>
        </div>
      </footer>

      <style>{`
        .drop-cap p:first-of-type::first-letter { float:left; font-size:5rem; line-height:1; padding:0.05em 0.1em 0.1em 0; font-family:var(--font-serif); font-weight:900; color:var(--color-brand-blue); }
        .custom-scrollbar::-webkit-scrollbar { width:3px; }
        .custom-scrollbar::-webkit-scrollbar-track { background:transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1); border-radius:10px; }
        .no-scrollbar::-webkit-scrollbar { display:none; }
        .no-scrollbar { -ms-overflow-style:none; scrollbar-width:none; }
        @keyframes scroll-x { 0%{transform:translateX(0)} 100%{transform:translateX(-50%)} }
        .animate-scroll { animation:scroll-x 30s linear infinite; }
        .visible-grid { border-left:1px solid #f3f4f6; border-top:1px solid #f3f4f6; }
        .grid-cell { border-right:1px solid #f3f4f6; border-bottom:1px solid #f3f4f6; }
      `}</style>
    </div>
  );
}
