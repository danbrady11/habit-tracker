import { useState, useEffect } from "react";
import { db } from "./firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

// ── Constants ────────────────────────────────────────────────────────────────
const USER_ID = "dan";
const AZ_OFFSET = -7; // Arizona never observes DST (UTC-7)

// Grindstone workouts — only one of each per week
const GRINDSTONE_TYPES = [
  { id: "lower",       label: "Lower",       points: 100 },
  { id: "upper",       label: "Upper",       points: 100 },
  { id: "conditioning",label: "Conditioning",points: 50  },
  { id: "optional1",   label: "Optional One",points: 50  },
  { id: "optional2",   label: "Optional Two",points: 50  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function getAZDate(date = new Date()) {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const az  = new Date(utc + AZ_OFFSET * 3600000);
  return az.toISOString().split("T")[0];
}

function getAZNow() {
  return new Date(new Date().getTime() + (AZ_OFFSET - (-new Date().getTimezoneOffset() / 60)) * 0);
}

function getTodayStr() { return getAZDate(); }

function getWeekStart(dateStr) {
  // Week runs Sun→Sat, tallied Sat 10pm AZ
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay(); // 0=Sun
  const sun = new Date(d);
  sun.setDate(d.getDate() - day);
  return sun.toISOString().split("T")[0];
}

function getWeekDates(weekStart) {
  const dates = [];
  const start = new Date(weekStart + "T12:00:00");
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    dates.push(d.toISOString().split("T")[0]);
  }
  return dates;
}

function fmtDate(str) {
  return new Date(str + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function fmtShort(str) {
  return new Date(str + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Scoring ──────────────────────────────────────────────────────────────────
function calcDailyScore(entry, drinkStreak) {
  let score = 0;
  const breakdown = [];

  // Sober
  if (entry.sober) {
    score += 100;
    breakdown.push({ label: "Sober day", pts: 100 });
  } else {
    const base = drinkStreak === 0 ? -250 : drinkStreak === 1 ? -500 : -1000;
    const perDrink = drinkStreak === 0 ? -25 : drinkStreak === 1 ? -50 : -100;
    const drinks = entry.drinks || 0;
    const penalty = base + (drinks * perDrink);
    score += penalty;
    breakdown.push({ label: `Drinking (${drinks} drinks, day ${drinkStreak + 1} consecutive)`, pts: penalty });
  }

  // Meals
  if (entry.breakfast) { score += 25; breakdown.push({ label: "Breakfast on plan", pts: 25 }); }
  if (entry.lunch)     { score += 25; breakdown.push({ label: "Lunch on plan",     pts: 25 }); }
  if (entry.snacks)    { score += 25; breakdown.push({ label: "Snacks on plan",    pts: 25 }); }
  if (entry.supps)     { score += 25; breakdown.push({ label: "Supplements taken", pts: 25 }); }

  // Training
  const grindDone = (entry.grindstone || []);
  for (const g of GRINDSTONE_TYPES) {
    if (grindDone.includes(g.id)) {
      score += g.points;
      breakdown.push({ label: `Grindstone — ${g.label}`, pts: g.points });
    }
  }
  if (entry.towers) { score += 25; breakdown.push({ label: "Towers", pts: 25 }); }

  // Walking
  const miles = parseFloat(entry.miles) || 0;
  if (miles > 0) {
    const pts = Math.round(miles * 10);
    score += pts;
    breakdown.push({ label: `Walking (${miles} mi)`, pts });
  }

  // Negatives
  if (entry.poorSleep) { score -= 150; breakdown.push({ label: "Sleep <6 hours", pts: -150 }); }
  if (entry.junkFood)  { score -= 100; breakdown.push({ label: "Junk food / off plan", pts: -100 }); }

  return { score, breakdown };
}

function calcWeeklyPenalty(weekEntries) {
  let penalty = 0;
  const breakdown = [];

  // Count grindstone sessions (each type once)
  const grindDone = new Set();
  for (const e of weekEntries) {
    for (const g of (e.grindstone || [])) grindDone.add(g);
  }
  const grindCount = grindDone.size;
  const grindPenalty = grindCount >= 4 ? 0 : grindCount === 3 ? -100 : grindCount === 2 ? -200 : grindCount === 1 ? -300 : -400;
  if (grindPenalty < 0) {
    penalty += grindPenalty;
    breakdown.push({ label: `Grindstone (${grindCount}/4 sessions)`, pts: grindPenalty });
  }

  // Count tower days
  const towerDays = weekEntries.filter(e => e.towers).length;
  const towerPenalty = towerDays >= 3 ? 0 : towerDays === 2 ? -50 : towerDays === 1 ? -100 : -150;
  if (towerPenalty < 0) {
    penalty += towerPenalty;
    breakdown.push({ label: `Towers (${towerDays}/3 days)`, pts: towerPenalty });
  }

  return { penalty, breakdown, grindCount, towerDays, grindDone };
}

// ── Firebase ─────────────────────────────────────────────────────────────────
async function loadData() {
  try {
    const snap = await getDoc(doc(db, "habits", USER_ID));
    return snap.exists() ? snap.data() : { entries: {}, weeklyPenalties: {} };
  } catch(e) { console.error(e); return { entries: {}, weeklyPenalties: {} }; }
}

async function saveData(data) {
  try {
    await setDoc(doc(db, "habits", USER_ID), data, { merge: true });
  } catch(e) { console.error(e); }
}

// ── Component ────────────────────────────────────────────────────────────────
const TABS = ["today", "trend", "weekly", "history"];

const EMPTY_ENTRY = {
  sober: null, drinks: 0,
  breakfast: false, lunch: false, snacks: false, supps: false,
  grindstone: [], towers: false,
  miles: "", poorSleep: false, junkFood: false,
};

export default function App() {
  const [data,      setData]      = useState({ entries: {}, weeklyPenalties: {} });
  const [loaded,    setLoaded]    = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [saved,     setSaved]     = useState(false);
  const [activeTab, setActiveTab] = useState("today");
  const [todayStr]                = useState(getTodayStr());
  const [form,      setForm]      = useState(EMPTY_ENTRY);

  // Load on mount
  useEffect(() => {
    loadData().then(d => {
      setData(d);
      const existing = d.entries?.[todayStr];
      if (existing) setForm({ ...EMPTY_ENTRY, ...existing });
      setLoaded(true);
    });
  }, []);

  // Build cumulative score series
  const allDates = Object.keys(data.entries || {}).sort();
  let cumulativeScore = 0;
  let drinkStreak = 0;
  const series = [];

  for (const date of allDates) {
    const entry = data.entries[date];
    const { score } = calcDailyScore(entry, drinkStreak);
    drinkStreak = entry.sober ? 0 : drinkStreak + 1;
    cumulativeScore += score;

    // Add weekly penalty on Saturdays
    const wp = data.weeklyPenalties?.[date];
    if (wp) cumulativeScore += wp;

    series.push({ date, score, cumulative: cumulativeScore, sober: entry.sober });
  }

  const todayEntry    = data.entries?.[todayStr] || {};
  const latestScore   = series.length ? series[series.length - 1].cumulative : 0;
  const todayInSeries = series.find(s => s.date === todayStr);
  const todayScore    = todayInSeries ? todayInSeries.score : 0;

  // Week context
  const weekStart  = getWeekStart(todayStr);
  const weekDates  = getWeekDates(weekStart);
  const weekEntries = weekDates.map(d => data.entries?.[d]).filter(Boolean);
  const { grindCount, towerDays, grindDone } = calcWeeklyPenalty(weekEntries);

  async function handleSave() {
    setSaving(true);
    const updated = {
      ...data,
      entries: { ...data.entries, [todayStr]: { ...form } }
    };
    setData(updated);
    await saveData(updated);
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function applyWeeklyPenalty() {
    const { penalty } = calcWeeklyPenalty(weekEntries);
    if (penalty === 0) return;
    const updated = {
      ...data,
      weeklyPenalties: { ...data.weeklyPenalties, [todayStr]: penalty }
    };
    setData(updated);
    await saveData(updated);
  }

  function toggleGrindstone(id) {
    const current = form.grindstone || [];
    // Check if already done this week (different day)
    const alreadyThisWeek = weekDates
      .filter(d => d !== todayStr)
      .some(d => (data.entries?.[d]?.grindstone || []).includes(id));
    if (alreadyThisWeek) return; // can't log twice in a week
    setForm(f => ({
      ...f,
      grindstone: current.includes(id) ? current.filter(x => x !== id) : [...current, id]
    }));
  }

  // Trend chart
  const chartData = series.slice(-14); // last 14 days
  const chartVals = chartData.map(s => s.cumulative);
  const chartMin  = Math.min(...chartVals, 0) - 50;
  const chartMax  = Math.max(...chartVals, 100) + 50;
  const W = 320, H = 140;
  const PAD = { top: 10, right: 10, bottom: 24, left: 50 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;
  function xS(i) { return (i / Math.max(chartData.length - 1, 1)) * cW; }
  function yS(v) { return cH - ((v - chartMin) / (chartMax - chartMin)) * cH; }
  const linePath = chartData.map((s, i) => `${i === 0 ? "M" : "L"}${xS(i).toFixed(1)},${yS(s.cumulative).toFixed(1)}`).join(" ");
  const areaPath = linePath + ` L${xS(chartData.length - 1).toFixed(1)},${cH} L0,${cH} Z`;
  const trendColor = latestScore >= 0 ? "#2d6a4f" : "#c1121f";

  // Score preview
  const previewStreak = todayEntry.sober === false ? drinkStreak : 0;
  const { score: previewScore, breakdown: previewBreakdown } = calcDailyScore(form, previewStreak);

  if (!loaded) return (
    <div style={{ minHeight:"100vh", background:"#f8f6f2", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"Georgia, serif", color:"#999", fontSize:14 }}>
      Loading...
    </div>
  );

  return (
    <div style={{ minHeight:"100vh", background:"#f8f6f2", color:"#1a1a1a", fontFamily:"Georgia, serif", maxWidth:480, margin:"0 auto", paddingBottom:80 }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        input { background: transparent; border: none; outline: none; color: #1a1a1a; font-family: Georgia, serif; }
        .tab { flex:1; padding:12px 0; background:transparent; border:none; border-bottom:2px solid transparent; cursor:pointer; font-family:Georgia,serif; font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#aaa; transition:all 0.2s; }
        .tab.active { color:#1a1a1a; border-bottom-color:#1a1a1a; }
        .check-btn { flex:1; padding:11px 4px; border:1px solid #ddd; background:#fff; cursor:pointer; font-family:Georgia,serif; font-size:11px; letter-spacing:1px; color:#aaa; transition:all 0.15s; }
        .check-btn.active { border-color:#1a1a1a; color:#1a1a1a; background:#f0ede8; }
        .check-btn.green.active { border-color:#2d6a4f; color:#2d6a4f; background:#f0f7f4; }
        .check-btn.red.active { border-color:#c1121f; color:#c1121f; background:#fdf0f0; }
        .save-btn { width:100%; padding:15px; background:#1a1a1a; color:#f8f6f2; border:none; cursor:pointer; font-family:Georgia,serif; font-size:12px; letter-spacing:3px; text-transform:uppercase; }
        .save-btn:disabled { background:#ccc; cursor:not-allowed; }
        .field { border-bottom:1px solid #ebe8e3; padding:12px 0; display:flex; justify-content:space-between; align-items:center; }
        .section-title { font-size:10px; letter-spacing:3px; text-transform:uppercase; color:#aaa; margin:20px 0 10px; }
        .card { background:#fff; border:1px solid #ebe8e3; padding:14px; margin-bottom:10px; }
        .grind-btn { padding:8px 10px; border:1px solid #ddd; background:#fff; cursor:pointer; font-family:Georgia,serif; font-size:10px; letter-spacing:1px; color:#aaa; transition:all 0.15s; flex:1; text-align:center; }
        .grind-btn.active { border-color:#2d6a4f; color:#2d6a4f; background:#f0f7f4; }
        .grind-btn.week-done { border-color:#ddd; background:#f8f6f2; color:#ccc; cursor:not-allowed; }
        .pos { color: #2d6a4f; }
        .neg { color: #c1121f; }
      `}</style>

      {/* Header */}
      <div style={{ background:"#fff", borderBottom:"1px solid #ebe8e3", padding:"48px 20px 20px" }}>
        <div style={{ fontSize:10, letterSpacing:4, color:"#aaa", textTransform:"uppercase", marginBottom:6 }}>
          Daily Habit Score
        </div>
        <div style={{ display:"flex", alignItems:"baseline", gap:12, marginBottom:12 }}>
          <span style={{ fontSize:52, fontWeight:400, lineHeight:1, color: latestScore >= 0 ? "#2d6a4f" : "#c1121f" }}>
            {latestScore > 0 ? "+" : ""}{latestScore.toLocaleString()}
          </span>
          <div style={{ fontSize:12, color:"#aaa" }}>
            {todayScore > 0 ? "+" : ""}{todayScore} today
          </div>
        </div>

        {/* Week progress */}
        <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
          <div style={{ background:"#f0ede8", padding:"5px 10px", fontSize:10, letterSpacing:1 }}>
            <span style={{ color:"#aaa" }}>GRINDSTONE </span>
            <span style={{ color: grindCount >= 4 ? "#2d6a4f" : "#c1121f" }}>{grindCount}/4</span>
          </div>
          <div style={{ background:"#f0ede8", padding:"5px 10px", fontSize:10, letterSpacing:1 }}>
            <span style={{ color:"#aaa" }}>TOWERS </span>
            <span style={{ color: towerDays >= 3 ? "#2d6a4f" : "#c1121f" }}>{towerDays}/3</span>
          </div>
          <div style={{ background:"#f0ede8", padding:"5px 10px", fontSize:10, letterSpacing:1 }}>
            <span style={{ color:"#aaa" }}>WEEK OF </span>
            <span style={{ color:"#1a1a1a" }}>{fmtShort(weekStart)}</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:"flex", background:"#fff", borderBottom:"1px solid #ebe8e3" }}>
        {TABS.map(t => (
          <button key={t} className={`tab ${activeTab===t?"active":""}`} onClick={() => setActiveTab(t)}>{t}</button>
        ))}
      </div>

      {/* ── TODAY ── */}
      {activeTab === "today" && (
        <div style={{ padding:"20px" }}>
          <div style={{ fontSize:11, color:"#aaa", letterSpacing:2, marginBottom:20 }}>{fmtDate(todayStr)}</div>

          {/* Alcohol */}
          <div className="section-title">Alcohol</div>
          <div className="card">
            <div style={{ display:"flex", gap:6, marginBottom: form.sober === false ? 12 : 0 }}>
              <button className={`check-btn green ${form.sober===true?"active":""}`} onClick={() => setForm(f=>({...f,sober:true,drinks:0}))}>✓ Sober</button>
              <button className={`check-btn red ${form.sober===false?"active":""}`} onClick={() => setForm(f=>({...f,sober:false}))}>✗ Drank</button>
            </div>
            {form.sober === false && (
              <div className="field" style={{ borderTop:"1px solid #ebe8e3", marginTop:12, paddingTop:12 }}>
                <span style={{ fontSize:12, color:"#aaa", letterSpacing:1 }}>NUMBER OF DRINKS</span>
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                  <button onClick={() => setForm(f=>({...f,drinks:Math.max(0,(f.drinks||0)-1)}))} style={{ width:28,height:28,border:"1px solid #ddd",background:"#fff",cursor:"pointer",fontSize:16,color:"#666" }}>−</button>
                  <span style={{ fontSize:20, minWidth:24, textAlign:"center" }}>{form.drinks||0}</span>
                  <button onClick={() => setForm(f=>({...f,drinks:(f.drinks||0)+1}))} style={{ width:28,height:28,border:"1px solid #ddd",background:"#fff",cursor:"pointer",fontSize:16,color:"#666" }}>+</button>
                </div>
              </div>
            )}
          </div>

          {/* Nutrition */}
          <div className="section-title">Nutrition</div>
          <div className="card">
            {[
              { key:"breakfast", label:"Breakfast on plan" },
              { key:"lunch",     label:"Lunch on plan" },
              { key:"snacks",    label:"Snacks on plan" },
              { key:"supps",     label:"Daily supplements" },
            ].map(f => (
              <div key={f.key} className="field" style={{ borderBottom: f.key === "supps" ? "none" : undefined }}>
                <span style={{ fontSize:13 }}>{f.label}</span>
                <div style={{ display:"flex", gap:6 }}>
                  <button className={`check-btn green ${form[f.key]===true?"active":""}`} style={{ padding:"6px 14px" }} onClick={() => setForm(p=>({...p,[f.key]:true}))}>✓</button>
                  <button className={`check-btn red ${form[f.key]===false?"active":""}`} style={{ padding:"6px 14px" }} onClick={() => setForm(p=>({...p,[f.key]:false}))}>✗</button>
                </div>
              </div>
            ))}
          </div>

          {/* Grindstone */}
          <div className="section-title">Grindstone — Select today's workout</div>
          <div className="card">
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              {GRINDSTONE_TYPES.map(g => {
                const alreadyThisWeek = weekDates.filter(d => d !== todayStr).some(d => (data.entries?.[d]?.grindstone||[]).includes(g.id));
                const selected = (form.grindstone||[]).includes(g.id);
                return (
                  <button
                    key={g.id}
                    className={`grind-btn ${selected?"active":""} ${alreadyThisWeek?"week-done":""}`}
                    onClick={() => toggleGrindstone(g.id)}
                    title={alreadyThisWeek ? "Already logged this week" : ""}
                  >
                    {g.label}<br/>
                    <span style={{ fontSize:9, opacity:0.7 }}>{alreadyThisWeek ? "✓ done" : `+${g.points}`}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Towers & walking */}
          <div className="section-title">Cardio</div>
          <div className="card">
            <div className="field">
              <span style={{ fontSize:13 }}>Towers completed</span>
              <div style={{ display:"flex", gap:6 }}>
                <button className={`check-btn green ${form.towers===true?"active":""}`} style={{ padding:"6px 14px" }} onClick={() => setForm(f=>({...f,towers:true}))}>✓</button>
                <button className={`check-btn red ${form.towers===false?"active":""}`} style={{ padding:"6px 14px" }} onClick={() => setForm(f=>({...f,towers:false}))}>✗</button>
              </div>
            </div>
            <div className="field" style={{ borderBottom:"none" }}>
              <span style={{ fontSize:13 }}>Miles walked</span>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                <input type="number" step="0.1" min="0" placeholder="0" value={form.miles} onChange={e=>setForm(f=>({...f,miles:e.target.value}))} style={{ width:50, textAlign:"right", fontSize:18 }}/>
                <span style={{ fontSize:12, color:"#aaa" }}>mi</span>
              </div>
            </div>
          </div>

          {/* Penalties */}
          <div className="section-title">Penalties</div>
          <div className="card">
            {[
              { key:"poorSleep", label:"Sleep <6 hours", pts:-150 },
              { key:"junkFood",  label:"Junk food / off-plan day", pts:-100 },
            ].map(f => (
              <div key={f.key} className="field" style={{ borderBottom: f.key === "junkFood" ? "none" : undefined }}>
                <div>
                  <div style={{ fontSize:13 }}>{f.label}</div>
                  <div style={{ fontSize:10, color:"#c1121f" }}>{f.pts} pts</div>
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  <button className={`check-btn red ${form[f.key]===true?"active":""}`} style={{ padding:"6px 14px" }} onClick={() => setForm(p=>({...p,[f.key]:!form[f.key]}))}>
                    {form[f.key] ? "✓ Yes" : "No"}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Score preview */}
          <div style={{ background:"#f0ede8", border:"1px solid #ddd", padding:"14px", marginBottom:20 }}>
            <div style={{ fontSize:10, letterSpacing:3, color:"#aaa", textTransform:"uppercase", marginBottom:10 }}>Score Preview</div>
            {previewBreakdown.map((b, i) => (
              <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:4, color: b.pts >= 0 ? "#2d6a4f" : "#c1121f" }}>
                <span>{b.label}</span>
                <span>{b.pts > 0 ? "+" : ""}{b.pts}</span>
              </div>
            ))}
            <div style={{ borderTop:"1px solid #ddd", marginTop:10, paddingTop:10, display:"flex", justifyContent:"space-between", fontSize:14, fontWeight:500 }}>
              <span>Today's score</span>
              <span style={{ color: previewScore >= 0 ? "#2d6a4f" : "#c1121f" }}>{previewScore > 0 ? "+" : ""}{previewScore}</span>
            </div>
          </div>

          <button className="save-btn" onClick={handleSave} disabled={saving || form.sober === null}>
            {saving ? "Saving..." : saved ? "✓ Saved" : "Save Today"}
          </button>
        </div>
      )}

      {/* ── TREND ── */}
      {activeTab === "trend" && (
        <div style={{ padding:"20px" }}>
          <div className="section-title">Cumulative Score — Last 14 Days</div>

          {chartData.length < 2 ? (
            <div style={{ textAlign:"center", color:"#aaa", padding:"40px 0", fontSize:13 }}>Log at least 2 days to see trend</div>
          ) : (
            <div className="card" style={{ padding:"16px 8px 8px" }}>
              <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow:"visible" }}>
                <defs>
                  <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={trendColor} stopOpacity="0.15"/>
                    <stop offset="100%" stopColor={trendColor} stopOpacity="0.01"/>
                  </linearGradient>
                </defs>
                <g transform={`translate(${PAD.left},${PAD.top})`}>
                  {/* Zero line */}
                  {chartMin < 0 && chartMax > 0 && (
                    <line x1={0} y1={yS(0)} x2={cW} y2={yS(0)} stroke="#ddd" strokeWidth={1} strokeDasharray="4 4"/>
                  )}
                  {/* Grid */}
                  {[-1, -0.5, 0, 0.5, 1].map(p => {
                    const v = chartMin + p * 0.5 * (chartMax - chartMin) + (chartMax - chartMin) * 0.25;
                    if (v < chartMin || v > chartMax) return null;
                    return (
                      <g key={p}>
                        <line x1={0} y1={yS(v)} x2={cW} y2={yS(v)} stroke="#f0ede8" strokeWidth={1}/>
                        <text x={-6} y={yS(v)+4} fill="#aaa" fontSize={8} textAnchor="end">{Math.round(v)}</text>
                      </g>
                    );
                  })}
                  <path d={areaPath} fill="url(#grad)"/>
                  <path d={linePath} fill="none" stroke={trendColor} strokeWidth={2}/>
                  {chartData.map((s, i) => (
                    <g key={i}>
                      <circle cx={xS(i)} cy={yS(s.cumulative)} r={3} fill={s.sober ? "#2d6a4f" : "#c1121f"} stroke="#fff" strokeWidth={1}/>
                      {i % 3 === 0 && (
                        <text x={xS(i)} y={cH+16} fill="#aaa" fontSize={7} textAnchor="middle">{fmtShort(s.date)}</text>
                      )}
                    </g>
                  ))}
                </g>
              </svg>
              <div style={{ display:"flex", gap:16, padding:"4px 12px", fontSize:10, color:"#aaa" }}>
                <span>● Sober day</span>
                <span style={{ color:"#c1121f" }}>● Drinking day</span>
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="section-title">All Time Stats</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            {[
              { label:"Total score",    val: `${latestScore > 0 ? "+" : ""}${latestScore}`, color: latestScore >= 0 ? "#2d6a4f" : "#c1121f" },
              { label:"Days logged",    val: allDates.length, color:"#1a1a1a" },
              { label:"Sober days",     val: allDates.filter(d => data.entries[d]?.sober).length, color:"#2d6a4f" },
              { label:"Drinking days",  val: allDates.filter(d => data.entries[d]?.sober === false).length, color:"#c1121f" },
              { label:"Best day",       val: series.length ? `+${Math.max(...series.map(s=>s.score))}` : "—", color:"#2d6a4f" },
              { label:"Worst day",      val: series.length ? Math.min(...series.map(s=>s.score)) : "—", color:"#c1121f" },
            ].map((s, i) => (
              <div key={i} className="card" style={{ padding:"12px 14px" }}>
                <div style={{ fontSize:9, letterSpacing:2, color:"#aaa", textTransform:"uppercase", marginBottom:6 }}>{s.label}</div>
                <div style={{ fontSize:24, color:s.color, fontWeight:400 }}>{s.val}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── WEEKLY ── */}
      {activeTab === "weekly" && (
        <div style={{ padding:"20px" }}>
          <div className="section-title">Week of {fmtShort(weekStart)}</div>

          {/* Grindstone progress */}
          <div className="card">
            <div style={{ fontSize:10, letterSpacing:2, color:"#aaa", textTransform:"uppercase", marginBottom:12 }}>Grindstone Sessions</div>
            <div style={{ display:"flex", gap:6, marginBottom:12 }}>
              {GRINDSTONE_TYPES.map(g => (
                <div key={g.id} style={{
                  flex:1, padding:"8px 4px", textAlign:"center",
                  border:`1px solid ${grindDone.has(g.id) ? "#2d6a4f" : "#ddd"}`,
                  background: grindDone.has(g.id) ? "#f0f7f4" : "#fff",
                  fontSize:9, color: grindDone.has(g.id) ? "#2d6a4f" : "#aaa"
                }}>
                  {g.label.split(" ")[0]}<br/>
                  {grindDone.has(g.id) ? "✓" : "—"}
                </div>
              ))}
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:12 }}>
              <span style={{ color:"#aaa" }}>{grindCount} of 4 sessions</span>
              <span style={{ color: grindCount >= 4 ? "#2d6a4f" : "#c1121f" }}>
                {grindCount >= 4 ? "On track ✓" : `${calcWeeklyPenalty(weekEntries).breakdown.find(b=>b.label.includes("Grindstone"))?.pts || 0} pts at week end`}
              </span>
            </div>
          </div>

          {/* Towers progress */}
          <div className="card">
            <div style={{ fontSize:10, letterSpacing:2, color:"#aaa", textTransform:"uppercase", marginBottom:12 }}>Towers Days</div>
            <div style={{ display:"flex", gap:6, marginBottom:12 }}>
              {weekDates.map((d, i) => {
                const e = data.entries?.[d];
                const hasTowers = e?.towers;
                const dayName = new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday:"short" });
                return (
                  <div key={i} style={{
                    flex:1, padding:"8px 4px", textAlign:"center",
                    border:`1px solid ${hasTowers ? "#2d6a4f" : "#ddd"}`,
                    background: hasTowers ? "#f0f7f4" : d > todayStr ? "#f8f6f2" : "#fff",
                    fontSize:9, color: hasTowers ? "#2d6a4f" : "#aaa"
                  }}>
                    {dayName}<br/>
                    {hasTowers ? "✓" : d > todayStr ? "·" : "—"}
                  </div>
                );
              })}
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:12 }}>
              <span style={{ color:"#aaa" }}>{towerDays} of 3 days</span>
              <span style={{ color: towerDays >= 3 ? "#2d6a4f" : "#c1121f" }}>
                {towerDays >= 3 ? "On track ✓" : `${calcWeeklyPenalty(weekEntries).breakdown.find(b=>b.label.includes("Towers"))?.pts || 0} pts at week end`}
              </span>
            </div>
          </div>

          {/* Daily breakdown this week */}
          <div className="section-title">Daily Breakdown</div>
          {weekDates.map(d => {
            const e = data.entries?.[d];
            if (!e || d > todayStr) return null;
            const { score } = calcDailyScore(e, 0);
            return (
              <div key={d} className="card" style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 14px" }}>
                <div>
                  <div style={{ fontSize:12 }}>{fmtShort(d)}</div>
                  <div style={{ fontSize:10, color: e.sober ? "#2d6a4f" : "#c1121f", marginTop:2 }}>{e.sober ? "✓ Sober" : `✗ Drank (${e.drinks})`}</div>
                </div>
                <div style={{ fontSize:22, color: score >= 0 ? "#2d6a4f" : "#c1121f" }}>
                  {score > 0 ? "+" : ""}{score}
                </div>
              </div>
            );
          })}

          {/* Apply weekly penalty */}
          <div style={{ marginTop:16, fontSize:11, color:"#aaa", textAlign:"center", lineHeight:1.6 }}>
            Weekly training penalties apply Saturday at 10pm Arizona time
          </div>
        </div>
      )}

      {/* ── HISTORY ── */}
      {activeTab === "history" && (
        <div style={{ padding:"20px" }}>
          <div className="section-title">All Entries</div>
          {[...allDates].reverse().map(date => {
            const e = data.entries[date];
            const { score, breakdown } = calcDailyScore(e, 0);
            const wp = data.weeklyPenalties?.[date];
            return (
              <div key={date} className="card" style={{ marginBottom:8 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                  <div>
                    <div style={{ fontSize:13 }}>{fmtDate(date)}</div>
                    <div style={{ fontSize:10, color: e.sober ? "#2d6a4f" : "#c1121f", marginTop:2 }}>
                      {e.sober ? "✓ Sober" : `✗ ${e.drinks} drinks`}
                    </div>
                  </div>
                  <div style={{ fontSize:24, color: score >= 0 ? "#2d6a4f" : "#c1121f" }}>
                    {score > 0 ? "+" : ""}{score}
                  </div>
                </div>
                {breakdown.map((b, i) => (
                  <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:10, color: b.pts >= 0 ? "#2d6a4f" : "#c1121f", marginBottom:2, opacity:0.8 }}>
                    <span>{b.label}</span>
                    <span>{b.pts > 0 ? "+" : ""}{b.pts}</span>
                  </div>
                ))}
                {wp && (
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#c1121f", marginTop:4, paddingTop:4, borderTop:"1px solid #ebe8e3" }}>
                    <span>Weekly training penalty</span>
                    <span>{wp}</span>
                  </div>
                )}
              </div>
            );
          })}
          {allDates.length === 0 && (
            <div style={{ textAlign:"center", color:"#aaa", padding:"40px 0", fontSize:13 }}>No entries yet</div>
          )}
        </div>
      )}
    </div>
  );
}
