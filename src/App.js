import { useState, useEffect, useRef } from "react"; 
import { db } from "./firebase"; 
import { doc, getDoc, setDoc } from "firebase/firestore"; 
// ── Constants ──────────────────────────────────────────────────────────────── const USER_ID = "dan"; 
const AZ_OFFSET = -7; 
const GRINDSTONE_TYPES = [ 
 { id: "lower", label: "Lower", points: 100 },  { id: "upper", label: "Upper", points: 100 },  { id: "conditioning", label: "Conditioning", points: 50 },  { id: "optional1", label: "Optional One", points: 50 },  { id: "optional2", label: "Optional Two", points: 50 }, ]; 
// ── Helpers ────────────────────────────────────────────────────────────────── function getAZDate(date = new Date()) { 
 const utc = date.getTime() + date.getTimezoneOffset() * 60000;  const az = new Date(utc + AZ_OFFSET * 3600000); 
 return az.toISOString().split("T")[0]; 
} 
function getTodayStr() { return getAZDate(); } 
function getWeekStart(dateStr) { 
 const d = new Date(dateStr + "T12:00:00"); 
 const sun = new Date(d); 
 sun.setDate(d.getDate() - d.getDay()); 
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
 return new Date(str + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: } 
function fmtShort(str) { 
 return new Date(str + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "num} 
function addDays(dateStr, n) { 
 const d = new Date(dateStr + "T12:00:00"); 
 d.setDate(d.getDate() + n); 
 return d.toISOString().split("T")[0]; 
} 
// ── Scoring ────────────────────────────────────────────────────────────────── function calcDailyScore(entry, drinkStreak) { 
 if (!entry) return { score: 0, breakdown: [] }; 
 let score = 0; 
 const breakdown = []; 
 if (entry.sober) { 
 score += 100; 
 breakdown.push({ label: "Sober day", pts: 100 }); 
 } else if (entry.sober === false) { 
 const base = drinkStreak === 0 ? -250 : drinkStreak === 1 ? -500 : -1000;  const perDrink = drinkStreak === 0 ? -25 : drinkStreak === 1 ? -50 : -100;  const drinks = entry.drinks || 0; 
 const penalty = base + drinks * perDrink; 
 score += penalty; 
 breakdown.push({ label: `Drinking (${drinks} drinks, day ${drinkStreak + 1} consecutive)` } 
 if (entry.breakfast === true) { score += 25; breakdown.push({ label: "Breakfast on plan", if (entry.breakfast === false) { score -= 25; breakdown.push({ label: "Breakfast missed", if (entry.lunch === true) { score += 25; breakdown.push({ label: "Lunch on plan",  if (entry.lunch === false) { score -= 25; breakdown.push({ label: "Lunch missed",  if (entry.snacks === true) { score += 25; breakdown.push({ label: "Snacks on plan",  if (entry.snacks === false) { score -= 25; breakdown.push({ label: "Snacks missed",  if (entry.supps === true) { score += 25; breakdown.push({ label: "Daily supplements", if (entry.supps === false) { score -= 25; breakdown.push({ label: "Supplements missed
 for (const g of GRINDSTONE_TYPES) { 
 if ((entry.grindstone || []).includes(g.id)) { 
 score += g.points; 
 breakdown.push({ label: `Grindstone — ${g.label}`, pts: g.points });  } 
 }
 if (entry.towers) { score += 25; breakdown.push({ label: "Towers", pts: 25 }); } 
 const miles = parseFloat(entry.miles) || 0; 
 if (miles > 0) { 
 const pts = Math.round(miles * 10); 
 score += pts; 
 breakdown.push({ label: `Walking (${miles} mi)`, pts }); 
 } 
 if (entry.poorSleep) { score -= 150; breakdown.push({ label: "Sleep <6 hours", pt if (entry.junkFood) { score -= 100; breakdown.push({ label: "Junk food / off-plan day", p
 return { score, breakdown }; 
} 
function calcWeeklyPenalty(weekEntries) { 
 const grindDone = new Set(); 
 for (const e of weekEntries) for (const g of (e?.grindstone || [])) grindDone.add(g);  const grindCount = grindDone.size; 
 const towerDays = weekEntries.filter(e => e?.towers).length; 
 const grindPenalty = grindCount >= 4 ? 0 : grindCount === 3 ? -100 : grindCount === 2 ? -2 const towerPenalty = towerDays >= 3 ? 0 : towerDays === 2 ? -50 : towerDays === 1 ? -1 const breakdown = []; 
 if (grindPenalty < 0) breakdown.push({ label: `Grindstone (${grindCount}/4 sessions)`, pts: if (towerPenalty < 0) breakdown.push({ label: `Towers (${towerDays}/3 days)`, pts: return { penalty: grindPenalty + towerPenalty, breakdown, grindCount, towerDays, grindDone} 
function buildSeries(entries, weeklyPenalties) { 
 const allDates = Object.keys(entries).sort(); 
 let cumulative = 0; 
 let drinkStreak = 0; 
 const series = []; 
 for (const date of allDates) { 
 const entry = entries[date]; 
 const streakForToday = drinkStreak; 
 const { score } = calcDailyScore(entry, streakForToday); 
 drinkStreak = entry?.sober ? 0 : drinkStreak + 1; 
 cumulative += score; 
 const wp = weeklyPenalties?.[date] || 0; 
 cumulative += wp; 
 series.push({ date, score, cumulative, sober: entry?.sober, wp, drinkStreak: streakForTo } 
 return series; 
}
// ── Firebase ───────────────────────────────────────────────────────────────── async function loadData() { 
 try { 
 const snap = await getDoc(doc(db, "habits", USER_ID)); 
 return snap.exists() ? snap.data() : { entries: {}, weeklyPenalties: {} };  } catch(e) { console.error(e); return { entries: {}, weeklyPenalties: {} }; } } 
async function saveData(data) { 
 try { await setDoc(doc(db, "habits", USER_ID), data, { merge: true }); }  catch(e) { console.error(e); } 
} 
// ── Empty form ──────────────────────────────────────────────────────────────── const EMPTY_ENTRY = { 
 sober: null, drinks: 0, 
 breakfast: null, lunch: null, snacks: null, supps: null, 
 grindstone: [], towers: null, 
 miles: "", poorSleep: false, junkFood: false, 
}; 
// ── Line chart component ────────────────────────────────────────────────────── function LineChart({ series, range }) { 
 const svgRef = useRef(null); 
 const [hov, setHov] = useState(null); 
 const data = range === "all" ? series : series.slice(-range); 
 if (data.length < 2) return ( 
 <div style={{ textAlign:"center", color:"#aaa", padding:"40px 0", fontSize:13 }}>Log at  ); 
 const W = 320, H = 160; 
 const PAD = { top:16, right:12, bottom:28, left:52 }; 
 const cW = W - PAD.left - PAD.right; 
 const cH = H - PAD.top - PAD.bottom; 
 const vals = data.map(s => s.cumulative); 
 const yMin = Math.min(...vals) - 50; 
 const yMax = Math.max(...vals) + 50; 
 function xS(i) { return (i / Math.max(data.length - 1, 1)) * cW; } 
 function yS(v) { return cH - ((v - yMin) / (yMax - yMin)) * cH; } 
 const linePath = data.map((s,i) => `${i===0?"M":"L"}${xS(i).toFixed(1)},${yS(s.cumulative). const areaPath = linePath + ` L${xS(data.length-1).toFixed(1)},${cH} L0,${cH} Z`; 
 const isUp = data[data.length-1].cumulative >= data[0].cumulative;
 const lineClr = isUp ? "#2d6a4f" : "#c1121f"; 
 const yTicks = []; 
 const range_ = yMax - yMin; 
 const step = range_ > 2000 ? 500 : range_ > 1000 ? 200 : range_ > 500 ? 100 : 50;  for (let v = Math.ceil(yMin/step)*step; v <= yMax; v += step) yTicks.push(v); 
 function handleMove(e) { 
 const rect = svgRef.current.getBoundingClientRect(); 
 const x = (e.clientX - rect.left - PAD.left) / (rect.width * cW / W);  const idx = Math.round((x / cW) * (data.length - 1)); 
 if (idx >= 0 && idx < data.length) setHov(data[Math.min(Math.max(idx,0),data.length-1)]);  } 
 return ( 
 <div> 
 <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`} 
 onMouseMove={handleMove} onTouchMove={e => { 
 const t = e.touches[0]; 
 handleMove({ clientX: t.clientX, clientY: t.clientY }); 
 }} 
 onMouseLeave={() => setHov(null)} onTouchEnd={() => setHov(null)}  style={{ overflow:"visible", cursor:"crosshair", display:"block" }}>  <defs> 
 <linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"> 
 <stop offset="0%" stopColor={lineClr} stopOpacity="0.15"/>  <stop offset="100%" stopColor={lineClr} stopOpacity="0.01"/>  </linearGradient> 
 </defs> 
 <g transform={`translate(${PAD.left},${PAD.top})`}> 
 {yTicks.map(v => ( 
 <g key={v}> 
 <line x1={0} y1={yS(v)} x2={cW} y2={yS(v)} stroke="#ebe8e3" strokeWidth={1}/>  <text x={-6} y={yS(v)+4} fill="#bbb" fontSize={8} textAnchor="end">{v}</text>  </g> 
 ))} 
 {yMin < 0 && yMax > 0 && ( 
 <line x1={0} y1={yS(0)} x2={cW} y2={yS(0)} stroke="#ccc" strokeWidth={1} strokeD )} 
 <path d={areaPath} fill="url(#lg)"/> 
 <path d={linePath} fill="none" stroke={lineClr} strokeWidth={2}/>  {data.map((s, i) => { 
 if (data.length > 20 && i % 3 !== 0) return null; 
 return ( 
 <circle key={i} cx={xS(i)} cy={yS(s.cumulative)} r={3} 
 fill={s.sober ? "#2d6a4f" : "#c1121f"} stroke="#fff" strokeWidth={1.5}/>  );
 })} 
 {hov && (() => { 
 const idx = data.indexOf(hov); 
 return ( 
 <g> 
 <line x1={xS(idx)} y1={0} x2={xS(idx)} y2={cH} stroke="#999" strokeWidth={1} <circle cx={xS(idx)} cy={yS(hov.cumulative)} r={5} fill={lineClr} stroke="#f </g> 
 ); 
 })()} 
 {data.filter((_,i) => i % Math.ceil(data.length/5) === 0 || i === data.length-1).m const i = data.indexOf(s); 
 return <text key={i} x={xS(i)} y={cH+16} fill="#bbb" fontSize={7} textAnchor="mi })} 
 </g> 
 </svg> 
 {hov && ( 
 <div style={{ display:"flex", gap:16, padding:"8px 12px", fontSize:10, color:"#aaa", <span style={{ color:"#1a1a1a" }}>{fmtDate(hov.date)}</span>  <span style={{ color: hov.score >= 0 ? "#2d6a4f" : "#c1121f" }}>{hov.score > 0 ? " <span style={{ color: hov.cumulative >= 0 ? "#2d6a4f" : "#c1121f", fontWeight:500 } </div> 
 )} 
 </div> 
 ); 
} 
// ── Log form (reusable for today + past dates) ──────────────────────────────── function EntryForm({ dateStr, initialEntry, weekData, todayStr, onSave, onCancel, drinkStrea const [form, setForm] = useState({ ...EMPTY_ENTRY, ...(initialEntry || {}) });  const [saving, setSaving] = useState(false); 
 const [saved, setSaved] = useState(false); 
 const isPast = dateStr < todayStr; 
 // Which grindstone types are already done in this week on OTHER days  const weekStart = getWeekStart(dateStr); 
 const weekDates = getWeekDates(weekStart); 
 const doneElsewhere = new Set( 
 weekDates.filter(d => d !== dateStr).flatMap(d => weekData[d]?.grindstone || [])  ); 
 function toggleGrindstone(id) { 
 if (doneElsewhere.has(id)) return; 
 const curr = form.grindstone || []; 
 setForm(f => ({ ...f, grindstone: curr.includes(id) ? curr.filter(x=>x!==id) : [...curr, }
 const { score: previewScore, breakdown } = calcDailyScore(form, drinkStreak || 0); 
 async function handleSave() { 
 setSaving(true); 
 await onSave(dateStr, form); 
 setSaving(false); setSaved(true); 
 setTimeout(() => setSaved(false), 1500); 
 } 
 return ( 
 <div> 
 <div style={{ fontSize:11, color:"#aaa", letterSpacing:2, marginBottom:16 }}>  {fmtDate(dateStr)}{isPast ? " (editing past)" : ""} 
 </div> 
 {/* Alcohol */} 
 <div style={sectionTitle}>Alcohol</div> 
 <div style={card}> 
 <div style={{ fontSize:10, color:"#aaa", marginBottom:8 }}>Sober: +100 pts &nbsp;|&n <div style={{ display:"flex", gap:6, marginBottom: form.sober === false ? 12 : 0 }}>  <button style={checkBtn(form.sober===true,"green")} onClick={() => setForm(f=>({... <button style={checkBtn(form.sober===false,"red")} onClick={() => setForm(f=>({... </div> 
 {form.sober === false && ( 
 <div style={{ ...fieldStyle, borderTop:"1px solid #ebe8e3", marginTop:12, paddingT <span style={{ fontSize:12, color:"#aaa", letterSpacing:1 }}>NUMBER OF DRINKS</s <div style={{ display:"flex", alignItems:"center", gap:12 }}>  <button onClick={() => setForm(f=>({...f,drinks:Math.max(0,(f.drinks||0)-1)}))} <span style={{ fontSize:20, minWidth:24, textAlign:"center" }}>{form.drinks||0} <button onClick={() => setForm(f=>({...f,drinks:(f.drinks||0)+1}))} style={cou </div> 
 </div> 
 )} 
 </div> 
 {/* Nutrition */} 
 <div style={sectionTitle}>Nutrition</div> 
 <div style={card}> 
 {[ 
 { key:"breakfast", label:"Breakfast on plan", pts:25 }, 
 { key:"lunch", label:"Lunch on plan", pts:25 }, 
 { key:"snacks", label:"Snacks on plan", pts:25 }, 
 { key:"supps", label:"Daily supplements", pts:25 }, 
 ].map((f,i,arr) => ( 
 <div key={f.key} style={{ ...fieldStyle, borderBottom: i===arr.length-1?"none":und <div> 
 <div style={{ fontSize:13 }}>{f.label}</div>
 <div style={{ fontSize:10, color:"#aaa" }}>+{f.pts} / -{f.pts} pts</div>  </div> 
 <div style={{ display:"flex", gap:6 }}> 
 <button style={smallCheck(form[f.key]===true,"green")} onClick={() => setForm( <button style={smallCheck(form[f.key]===false,"red")} onClick={() => setForm( </div> 
 </div> 
 ))} 
 </div> 
 {/* Grindstone */} 
 <div style={sectionTitle}>Grindstone</div> 
 <div style={card}> 
 <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}> 
 {GRINDSTONE_TYPES.map(g => { 
 const locked = doneElsewhere.has(g.id); 
 const selected = (form.grindstone||[]).includes(g.id); 
 return ( 
 <button key={g.id} onClick={() => toggleGrindstone(g.id)}  style={{ 
 flex:1, minWidth:60, padding:"8px 4px", textAlign:"center",  border:`1px solid ${selected?"#2d6a4f":locked?"#eee":"#ddd"}`,  background: selected?"#f0f7f4":locked?"#f8f6f2":"#fff",  cursor: locked?"not-allowed":"pointer", 
 fontSize:9, color: selected?"#2d6a4f":locked?"#ccc":"#aaa",  fontFamily:"Georgia,serif", 
 }}> 
 {g.label}<br/> 
 <span style={{ fontSize:8 }}>{locked?"✓ done":selected?`+${g.points}`:g.poin </button> 
 ); 
 })} 
 </div> 
 </div> 
 {/* Cardio */} 
 <div style={sectionTitle}>Cardio</div> 
 <div style={card}> 
 <div style={fieldStyle}> 
 <div> 
 <div style={{ fontSize:13 }}>Towers completed</div> 
 <div style={{ fontSize:10, color:"#aaa" }}>+25 pts</div> 
 </div> 
 <div style={{ display:"flex", gap:6 }}> 
 <button style={smallCheck(form.towers===true,"green")} onClick={() => setForm(f <button style={smallCheck(form.towers===false,"red")} onClick={() => setForm(f </div>
 </div> 
 <div style={{ ...fieldStyle, borderBottom:"none" }}> 
 <div> 
 <div style={{ fontSize:13 }}>Miles walked</div> 
 <div style={{ fontSize:10, color:"#aaa" }}>+10 pts/mile</div>  </div> 
 <div style={{ display:"flex", alignItems:"center", gap:6 }}>  <input type="number" step="0.1" min="0" placeholder="0" value={form.miles}  onChange={e=>setForm(f=>({...f,miles:e.target.value}))} 
 style={{ width:50, textAlign:"right", fontSize:18, background:"transparent", b <span style={{ fontSize:12, color:"#aaa" }}>mi</span> 
 </div> 
 </div> 
 </div> 
 {/* Penalties */} 
 <div style={sectionTitle}>Penalties</div> 
 <div style={card}> 
 {[ 
 { key:"poorSleep", label:"Sleep <6 hours", pts:-150 },  { key:"junkFood", label:"Junk food / off-plan", pts:-100 },  ].map((f,i,arr) => ( 
 <div key={f.key} style={{ ...fieldStyle, borderBottom: i===arr.length-1?"none":und <div> 
 <div style={{ fontSize:13 }}>{f.label}</div> 
 <div style={{ fontSize:10, color:"#c1121f" }}>{f.pts} pts</div>  </div> 
 <button style={smallCheck(form[f.key]===true,"red")} onClick={() => setForm(p=>({ {form[f.key]?"✓":"No"} 
 </button> 
 </div> 
 ))} 
 </div> 
 {/* Preview */} 
 <div style={{ background:"#f0ede8", border:"1px solid #ddd", padding:"14px", marginBot <div style={{ fontSize:10, letterSpacing:3, color:"#aaa", textTransform:"uppercase", {breakdown.map((b,i) => ( 
 <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, <span>{b.label}</span><span>{b.pts>0?"+":""}{b.pts}</span>  </div> 
 ))} 
 <div style={{ borderTop:"1px solid #ddd", marginTop:10, paddingTop:10, display:"flex <span>Day score</span> 
 <span style={{ color:previewScore>=0?"#2d6a4f":"#c1121f" }}>{previewScore>0?"+":""} </div> 
 </div>
 <div style={{ display:"flex", gap:8 }}> 
 {onCancel && ( 
 <button onClick={onCancel} style={{ flex:1, padding:14, background:"#fff", border: Cancel 
 </button> 
 )} 
 <button onClick={handleSave} disabled={saving} 
 style={{ flex:2, padding:14, background:saving?"#ccc":"#1a1a1a", color:"#f8f6f2",  {saving?"Saving…":saved?"✓ Saved":isPast?"Update Entry":"Save"}  </button> 
 </div> 
 </div> 
 ); 
} 
// ── Shared styles ───────────────────────────────────────────────────────────── const sectionTitle = { fontSize:10, letterSpacing:3, textTransform:"uppercase", color:"#aaa",const card = { background:"#fff", border:"1px solid #ebe8e3", padding:"14px", marginconst fieldStyle = { borderBottom:"1px solid #ebe8e3", padding:"12px 0", display:"flex", jconst counterBtn = { width:28, height:28, border:"1px solid #ddd", background:"#fff", curs
function checkBtn(active, color) { 
 const colors = { green:{ border:"#2d6a4f", text:"#2d6a4f", bg:"#f0f7f4" }, red:{ border:"# const c = colors[color]; 
 return { 
 flex:1, padding:"11px 4px", border:`1px solid ${active?c.border:"#ddd"}`,  background: active?c.bg:"#fff", cursor:"pointer", fontFamily:"Georgia,serif",  fontSize:11, letterSpacing:1, color: active?c.text:"#aaa", transition:"all 0.15s",  }; 
} 
function smallCheck(active, color) { 
 const colors = { green:{ border:"#2d6a4f", text:"#2d6a4f", bg:"#f0f7f4" }, red:{ border:"# const c = colors[color]; 
 return { 
 padding:"6px 14px", border:`1px solid ${active?c.border:"#ddd"}`, 
 background: active?c.bg:"#fff", cursor:"pointer", fontFamily:"Georgia,serif",  fontSize:11, color: active?c.text:"#aaa", 
 }; 
} 
// ── Main App ────────────────────────────────────────────────────────────────── const TABS = ["today","trend","weekly","history"]; 
export default function App() { 
 const [data, setData] = useState({ entries:{}, weeklyPenalties:{} });
 const [loaded, setLoaded] = useState(false); 
 const [activeTab, setActiveTab] = useState("today"); 
 const [chartRange, setChartRange]= useState(30); 
 const [editDate, setEditDate] = useState(null); // null = not editing past  const todayStr = getTodayStr(); 
 useEffect(() => { 
 loadData().then(d => { setData(d); setLoaded(true); }); 
 }, []); 
 const series = buildSeries(data.entries || {}, data.weeklyPenalties || {});  const allDates = Object.keys(data.entries || {}).sort(); 
 const latestScore = series.length ? series[series.length-1].cumulative : 0;  const todayInSeries = series.find(s => s.date === todayStr); 
 const todayScore = todayInSeries?.score || 0; 
 const weekStart = getWeekStart(todayStr); 
 const weekDates = getWeekDates(weekStart); 
 const weekEntries = weekDates.map(d => data.entries?.[d]).filter(Boolean);  const { grindCount, towerDays, grindDone } = calcWeeklyPenalty(weekEntries); 
 async function handleSaveEntry(dateStr, form) { 
 const updated = { ...data, entries: { ...data.entries, [dateStr]: { ...form } } };  setData(updated); 
 await saveData(updated); 
 } 
 async function handleDeleteEntry(dateStr) { 
 const { [dateStr]: _, ...remaining } = data.entries; 
 const updated = { ...data, entries: remaining }; 
 setData(updated); 
 await saveData(updated); 
 } 
 if (!loaded) return ( 
 <div style={{ minHeight:"100vh", background:"#f8f6f2", display:"flex", alignItems:"cente Loading... 
 </div> 
 ); 
 return ( 
 <div style={{ minHeight:"100vh", background:"#f8f6f2", color:"#1a1a1a", fontFamily:"Geor
 {/* Header */} 
 <div style={{ background:"#fff", borderBottom:"1px solid #ebe8e3", padding:"48px 20px  <div style={{ fontSize:10, letterSpacing:4, color:"#aaa", textTransform:"uppercase",
 <div style={{ display:"flex", alignItems:"baseline", gap:12, marginBottom:12 }}>  <span style={{ fontSize:52, fontWeight:400, lineHeight:1, color: latestScore>=0?"# {latestScore>0?"+":""}{latestScore.toLocaleString()} 
 </span> 
 <div style={{ fontSize:12, color:"#aaa" }}>{todayScore>0?"+":""}{todayScore} today </div> 
 <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}> 
 {[ 
 { label:"GRINDSTONE", val:`${grindCount}/4`, ok: grindCount>=4 },  { label:"TOWERS", val:`${towerDays}/3`, ok: towerDays>=3 },  { label:"WEEK OF", val:fmtShort(weekStart), ok:true }, 
 ].map((s,i) => ( 
 <div key={i} style={{ background:"#f0ede8", padding:"5px 10px", fontSize:10, let <span style={{ color:"#aaa" }}>{s.label} </span> 
 <span style={{ color: s.ok?"#2d6a4f":"#c1121f" }}>{s.val}</span>  </div> 
 ))} 
 </div> 
 </div> 
 {/* Tabs */} 
 <div style={{ display:"flex", background:"#fff", borderBottom:"1px solid #ebe8e3" }}>  {TABS.map(t => ( 
 <button key={t} onClick={() => { setActiveTab(t); setEditDate(null); }}  style={{ flex:1, padding:"12px 0", background:"transparent", border:"none", bord {t} 
 </button> 
 ))} 
 </div> 
 {/* ── TODAY ── */} 
 {activeTab === "today" && ( 
 <div style={{ padding:"20px" }}> 
 <EntryForm 
 dateStr={todayStr} 
 initialEntry={data.entries?.[todayStr]} 
 weekData={data.entries || {}} 
 todayStr={todayStr} 
 onSave={handleSaveEntry} 
 drinkStreak={(() => { 
 const s = series.find(s => s.date === todayStr); 
 if (s) return s.drinkStreak; 
 // Not yet saved today — look at yesterday 
 const allDates = Object.keys(data.entries || {}).sort();  const lastDate = allDates[allDates.length - 1]; 
 if (!lastDate) return 0; 
 const lastSeries = series.find(s => s.date === lastDate);
 if (!lastSeries) return 0; 
 return data.entries[lastDate]?.sober ? 0 : lastSeries.drinkStreak + 1;  })()} 
 /> 
 </div> 
 )} 
 {/* ── TREND ── */} 
 {activeTab === "trend" && ( 
 <div style={{ padding:"20px" }}> 
 <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", <div style={sectionTitle}>Cumulative Score</div> 
 <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}> 
 {[{label:"2W",days:14},{label:"4W",days:28},{label:"6W",days:42},{label:"12W", <button key={r.label} onClick={() => setChartRange(r.days)}  style={{ padding:"4px 10px", border:`1px solid ${chartRange===r.days?"#1a1 {r.label} 
 </button> 
 ))} 
 </div> 
 </div> 
 <div style={{ ...card, padding:"16px 8px 8px" }}> 
 <LineChart series={series} range={chartRange}/> 
 </div> 
 {/* All time stats */} 
 <div style={sectionTitle}>All Time</div> 
 <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>  {[ 
 { label:"Total score", val:`${latestScore>0?"+":""}${latestScore}`,  { label:"Days logged", val:allDates.length, 
 { label:"Sober days", val:allDates.filter(d=>data.entries[d]?.sober).length, { label:"Drinking days", val:allDates.filter(d=>data.entries[d]?.sober===false) { label:"Best day", val:series.length?`+${Math.max(...series.map(s=>s.sco { label:"Worst day", val:series.length?`${Math.min(...series.map(s=>s.scor ].map((s,i) => ( 
 <div key={i} style={{ ...card, padding:"12px 14px" }}> 
 <div style={{ fontSize:9, letterSpacing:2, color:"#aaa", textTransform:"uppe <div style={{ fontSize:24, color:s.color }}>{s.val}</div>  </div> 
 ))} 
 </div> 
 </div> 
 )} 
 {/* ── WEEKLY ── */}
 {activeTab === "weekly" && ( 
 <div style={{ padding:"20px" }}> 
 <div style={sectionTitle}>Week of {fmtShort(weekStart)}</div> 
 <div style={card}> 
 <div style={{ fontSize:10, letterSpacing:2, color:"#aaa", textTransform:"upperca <div style={{ display:"flex", gap:5, marginBottom:12 }}> 
 {GRINDSTONE_TYPES.map(g => ( 
 <div key={g.id} style={{ flex:1, padding:"8px 4px", textAlign:"center", bord {g.label.split(" ")[0]}<br/>{grindDone.has(g.id)?"✓":"—"}  </div> 
 ))} 
 </div> 
 <div style={{ display:"flex", justifyContent:"space-between", fontSize:12 }}>  <span style={{ color:"#aaa" }}>{grindCount} of 5 sessions</span>  <span style={{ color: grindCount>=5?"#2d6a4f": grindCount>=4?"#2d6a4f":"#c1121 {grindCount>=5?"Bonus +200 ": grindCount>=4?"On track ✓":"Penalty pending"  </span> 
 </div> 
 </div> 
 <div style={card}> 
 <div style={{ fontSize:10, letterSpacing:2, color:"#aaa", textTransform:"upperca <div style={{ display:"flex", gap:5, marginBottom:12 }}> 
 {weekDates.map((d,i) => { 
 const hasTowers = data.entries?.[d]?.towers; 
 const dayName = new Date(d+"T12:00:00").toLocaleDateString("en-US",{weekda return ( 
 <div key={i} style={{ flex:1, padding:"8px 4px", textAlign:"center", borde {dayName}<br/>{hasTowers?"✓":d>todayStr?"·":"—"} 
 </div> 
 ); 
 })} 
 </div> 
 <div style={{ display:"flex", justifyContent:"space-between", fontSize:12 }}>  <span style={{ color:"#aaa" }}>{towerDays} of 4 days</span>  <span style={{ color: towerDays>=4?"#2d6a4f": towerDays>=3?"#2d6a4f":"#c1121f" {towerDays>=4?"Bonus +100 ": towerDays>=3?"On track ✓":"Penalty pending"}  </span> 
 </div> 
 </div> 
 <div style={sectionTitle}>Daily Breakdown</div> 
 {weekDates.filter(d => d <= todayStr && data.entries?.[d]).map(d => {  const e = data.entries[d]; 
 const s = series.find(s => s.date === d); 
 const { score } = calcDailyScore(e, s?.drinkStreak || 0);
 return ( 
 <div key={d} style={{ ...card, display:"flex", justifyContent:"space-between", <div> 
 <div style={{ fontSize:12 }}>{fmtShort(d)}</div> 
 <div style={{ fontSize:10, color:e.sober?"#2d6a4f":"#c1121f", marginTop:2 } </div> 
 <div style={{ fontSize:22, color:score>=0?"#2d6a4f":"#c1121f" }}>{score>0?"+ </div> 
 ); 
 })} 
 </div> 
 )} 
 {/* ── HISTORY ── */} 
 {activeTab === "history" && ( 
 <div style={{ padding:"20px" }}> 
 {/* Edit past date picker */} 
 {editDate ? ( 
 <div> 
 <EntryForm 
 dateStr={editDate} 
 initialEntry={data.entries?.[editDate]} 
 weekData={data.entries || {}} 
 todayStr={todayStr} 
 onSave={async (d, f) => { await handleSaveEntry(d, f); setEditDate(null); }}  onCancel={() => setEditDate(null)} 
 drinkStreak={series.find(s => s.date === editDate)?.drinkStreak || 0}  /> 
 </div> 
 ) : ( 
 <> 
 <div style={{ display:"flex", justifyContent:"space-between", alignItems:"cent <div style={{ ...sectionTitle, margin:0 }}>All Entries</div>  <div style={{ fontSize:11, color:"#aaa" }}>Tap to edit</div>  </div> 
 {/* Quick date picker for missing days */} 
 <div style={{ ...card, marginBottom:16 }}> 
 <div style={{ fontSize:10, letterSpacing:2, color:"#aaa", textTransform:"upp <div style={{ display:"flex", gap:8 }}> 
 <input type="date" max={todayStr} 
 style={{ flex:1, padding:"8px 10px", border:"1px solid #ddd", background: onChange={e => { if (e.target.value) setEditDate(e.target.value); }}  /> 
 </div> 
 </div>
 {[...allDates].reverse().map(date => { 
 const e = data.entries[date]; 
 const s = series.find(s => s.date === date); 
 const { score, breakdown } = calcDailyScore(e, s?.drinkStreak || 0);  const wp = data.weeklyPenalties?.[date]; 
 return ( 
 <div key={date} style={{ ...card, marginBottom:8 }}>  <div style={{ display:"flex", justifyContent:"space-between", alignItems: <div onClick={() => setEditDate(date)} style={{ flex:1, cursor:"pointe <div style={{ fontSize:13 }}>{fmtDate(date)}</div>  <div style={{ fontSize:10, color:e.sober?"#2d6a4f":"#c1121f", margin </div> 
 <div style={{ display:"flex", alignItems:"center", gap:10 }}>  <span style={{ fontSize:24, color:score>=0?"#2d6a4f":"#c1121f" }}>{s <span onClick={() => setEditDate(date)} style={{ fontSize:11, color: <button 
 onClick={e => { 
 e.stopPropagation(); 
 if (window.confirm(`Delete entry for ${fmtDate(date)}?`)) handle }} 
 style={{ background:"none", border:"none", cursor:"pointer", fontS title="Delete entry"> 
  
 </button> 
 </div> 
 </div> 
 {breakdown.map((b,i) => ( 
 <div key={i} style={{ display:"flex", justifyContent:"space-between",  <span>{b.label}</span><span>{b.pts>0?"+":""}{b.pts}</span>  </div> 
 ))} 
 {wp && ( 
 <div style={{ display:"flex", justifyContent:"space-between", fontSize: <span>Weekly penalty</span><span>{wp}</span> 
 </div> 
 )} 
 </div> 
 ); 
 })} 
 {allDates.length === 0 && ( 
 <div style={{ textAlign:"center", color:"#aaa", padding:"40px 0", fontSize:1 )} 
 </> 
 )} 
 </div> 
 )} 
 </div>
 ); }
