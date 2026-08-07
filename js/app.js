/* ============================================================
   FASTO INNOVA — App (state, screens, Brain 1 orchestration)
   Engine (core.js / data.js) is unchanged from the tested v0.2
   build. This file wires that engine to the new Figma-sourced
   UI: multi-chat Fasto-AI screen, two-pane Clients screen, and
   a Research Progress table on the Dashboard. No flow-diagram
   panel and no Guardian log sheet in this design — Brain 3
   still validates every message and profile, just without a
   dedicated viewer (per your call — matches the Figma file
   exactly; check DevTools console for a live Guardian trace).
   ============================================================ */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const CAT_LABEL = { verdure:"vegetables", pomodori:"tomatoes", frutta:"fruit", legumi:"legumes", olio:"oil", vino:"wine", uova:"eggs", formaggi:"cheese", carne:"meat", erbe:"herbs", castagne:"chestnuts", miele:"honey", conserve:"preserves" };

let state = {
  apiKey: "", model: "claude-haiku-4-5-20251001", offline: true,
  chats: [],           // {id,title,phase,pct,messages:[{role,text}],apiMessages,profile,candidates,recs,offlineStep,offlineReady,ts}
  activeChatId: null,
  clients: [],          // matched-buyer threads (Clients screen)
  glog: [],
  screen: "dashboard",
  activeClientId: null,
  showAllResearch: false
};

/* ---------- Prompts / tool schemas (Brain 1 + Brain 2) ---------- */
const SYSTEM_INTERVIEW = `You are the friendly voice of Fasto Innova, a service that helps small farmers around Cassino (Lazio, Italy) sell directly to nearby buyers. You are Brain 1 of a three-brain system: you talk to people; Brain 2 matches them with buyers from a verified local database; Brain 3 supervises safety.

Rules:
- Mirror the user's language (Italian or English).
- Be warm and simple. No jargon, no forms. ONE question per message. Keep every reply under 65 words.
- Early on, ask the farmer's first name so we can personalise the dashboard — don't block on it if they skip it.
- Collect: (1) name (optional), (2) products grown, (3) roughly how many kg per WEEK of each, (4) months of availability, (5) village/area and rough km from Cassino, (6) organic certification: yes / no / partial.
- If something is vague, gently ask once, then accept an estimate.
- Never promise prices, never name specific buyers yourself — that is Brain 2's job with verified data only.
- If asked about transport: our logistics partner arranges pickup and delivery, the farmer does not need a van.
- When you have the key points, summarise them in one short message and ask "Shall I search for matches?" — when the farmer confirms, call submit_farmer_profile. Map each product to one category of: verdure, pomodori, frutta, legumi, olio, vino, uova, formaggi, carne, erbe, castagne, miele, conserve.`;

const TOOL_PROFILE = {
  name: "submit_farmer_profile",
  description: "Send the completed, farmer-confirmed profile to Brain 2 (matching engine).",
  input_schema: {
    type: "object",
    properties: {
      farmer_name: { type: "string", description: "Farmer's first name, if given" },
      village: { type: "string", description: "Village or area of the farm" },
      distance_km_from_cassino: { type: "number" },
      products: { type: "array", items: { type: "object", properties: {
        name: { type: "string" }, category: { type: "string", enum: CATEGORIES }, kg_per_week: { type: "number" } },
        required: ["name", "category", "kg_per_week"] } },
      organic: { type: "string", enum: ["yes", "no", "partial"] },
      available_months: { type: "array", items: { type: "integer", minimum: 1, maximum: 12 } }
    },
    required: ["village", "products", "organic"]
  }
};

const SYSTEM_MATCH = `You are the recommendation writer inside Brain 2 of Fasto Innova. You receive a farmer profile plus candidate buyers ALREADY retrieved and scored from our verified Cassino database. Your tasks:
1. Pick and rank the best 5 (you may reorder slightly if reasons justify it).
2. For each, write one plain-language sentence a farmer immediately understands (mention what they buy and why it fits).
3. Add 2-3 creative suggestions: seasonal angles, simple transformations (e.g. passata from surplus tomatoes), or channels from the list.
4. Draft ONE outreach message to the top buyer: Italian version + English translation, max 90 words each, warm and professional, from the farmer's perspective, mentioning product, weekly quantity and that Fasto Innova's logistics partner handles delivery.
STRICT: use ONLY the provided buyer_id values. Never invent buyers, prices, or certifications. Never claim organic unless profile organic is "yes". Answer ONLY by calling submit_recommendations.`;

const TOOL_RECS = {
  name: "submit_recommendations",
  description: "Return ranked recommendations, suggestions and one outreach draft.",
  input_schema: {
    type: "object",
    properties: {
      ranked: { type: "array", items: { type: "object", properties: {
        buyer_id: { type: "string" }, pitch_reason: { type: "string" } }, required: ["buyer_id", "pitch_reason"] } },
      creative_suggestions: { type: "array", items: { type: "string" } },
      outreach: { type: "object", properties: {
        buyer_id: { type: "string" }, message_it: { type: "string" }, message_en: { type: "string" } },
        required: ["buyer_id", "message_it", "message_en"] }
    },
    required: ["ranked", "creative_suggestions", "outreach"]
  }
};

/* ---------- small UI helpers ---------- */
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600); }
function setTyping(on) { const t = $("typingInd"); if (t) t.style.display = on ? "block" : "none"; const b = $("sendBtn"); if (b) b.disabled = on; }
function showErr(msg) { const b = $("errBanner"); if (!b) return; b.textContent = msg; b.style.display = "block"; }
function clearErr() { const b = $("errBanner"); if (b) b.style.display = "none"; }

function addLog(level, msg) {
  const t = new Date().toTimeString().slice(0, 8);
  state.glog.push({ level, msg, t });
  if (state.glog.length > 200) state.glog.shift();
  if (level !== "info") console.debug("[Guardian]", level, msg);
}

/* ---------- Claude API ---------- */
async function callClaude(system, messages, tools, maxTokens, forceTool) {
  const body = { model: state.model, max_tokens: maxTokens, system, messages };
  if (tools) body.tools = tools;
  if (forceTool) body.tool_choice = { type: "tool", name: forceTool };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": state.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    const m = (data.error && data.error.message) || res.statusText;
    if (res.status === 401) throw new Error("Invalid API key (401). Check it in console.anthropic.com.");
    if (res.status === 400 && /credit/i.test(m)) throw new Error("No credits on this Anthropic account — add some in Billing.");
    throw new Error("API error " + res.status + ": " + m);
  }
  return data;
}

/* ================= MULTI-CHAT (Fasto-AI screen) ================= */
function newChatObj() {
  return { id: "c" + Date.now() + Math.random().toString(36).slice(2, 6), title: "New chat", phase: "idle", pct: 0,
    messages: [], apiMessages: [], profile: null, candidates: [], recs: null, offlineStep: 0, offlineReady: false, ts: Date.now() };
}
function activeChat() { return state.chats.find(c => c.id === state.activeChatId) || null; }
function chatTitle(chat) {
  if (chat.profile && chat.profile.farmer_name) return chat.profile.farmer_name;
  if (chat.profile) { const top = topProductCategory(chat.profile); if (top) return "Chat · " + (CAT_LABEL[top] || top); }
  return "New chat";
}

function startNewChat() {
  const chat = newChatObj();
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  const greet = state.offline
    ? "Buongiorno! (Offline demo) I'm the Fasto Innova assistant. Press a sample chip or say hello to begin."
    : "Buongiorno! I'm the Fasto Innova assistant. I help small farmers around Cassino find the right local buyers — no forms, just a chat. What's your name, and what do you grow?";
  addMsg(chat, "ai", greet);
  updateHeaderIdentity();
  renderChatRail();
  renderTranscript();
}
function selectChat(id) { state.activeChatId = id; clearErr(); updateHeaderIdentity(); renderChatRail(); renderTranscript(); }

function renderChatRail() {
  const el = $("chatRailList"); if (!el) return;
  el.innerHTML = state.chats.map(c => `
    <div class="chat-rail-item ${c.id === state.activeChatId ? "active" : ""}" onclick="selectChat('${c.id}')">
      <img class="ic-svg sm" src="assets/icon-chat-item.svg" alt="">${esc(c.title)}
    </div>`).join("");
}
function addMsg(chat, role, text) {
  chat.messages.push({ role, text, ts: Date.now() });
  if (chat.id === state.activeChatId) renderTranscript();
}
function renderTranscript() {
  const chat = activeChat();
  const el = $("assistTranscript"); if (!el) return;
  if (!chat) { el.innerHTML = ""; return; }
  el.innerHTML = chat.messages.map(m => {
    if (m.role === "sys") return `<div class="bubble meta">${esc(m.text)}</div>`;
    return `<div class="bubble ${m.role === "user" ? "out" : "in"}">${esc(m.text)}</div>`;
  }).join("");
  el.scrollTop = el.scrollHeight;
}

/* ---------- Brain 1 turn ---------- */
async function sendUserMessage(text) {
  const chat = activeChat(); if (!chat) return;
  clearErr();
  addMsg(chat, "user", text);

  const findings = guardianScanText(text);
  findings.forEach(f => addLog(f.level, "Guardian · input scan: " + f.msg));
  if (findings.some(f => f.level === "block")) {
    addMsg(chat, "sys", "Message blocked by the Guardian for safety. Please rephrase.");
    return;
  }
  if (!findings.length) addLog("ok", "Guardian · input scan: clean");

  if (state.offline) return offlineTurn(chat);

  chat.apiMessages.push({ role: "user", content: text });
  setTyping(true);
  try {
    const resp = await callClaude(SYSTEM_INTERVIEW, chat.apiMessages, [TOOL_PROFILE], 600);
    setTyping(false);
    chat.apiMessages.push({ role: "assistant", content: resp.content });

    let toolUse = null;
    for (const block of resp.content) {
      if (block.type === "text" && block.text.trim()) addMsg(chat, "ai", block.text.trim());
      if (block.type === "tool_use" && block.name === "submit_farmer_profile") toolUse = block;
    }
    addLog("info", "Brain 1 · replied (" + (resp.usage ? resp.usage.output_tokens + " tokens" : "ok") + ")");

    if (toolUse) {
      chat.apiMessages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "Profile received by Guardian for validation." }] });
      await onProfileCaptured(toolUse.input, chat);
    }
  } catch (e) {
    setTyping(false);
    showErr(e.message);
    addLog("block", "System · " + e.message);
    chat.apiMessages.pop();
  }
}

/* ---------- Handoff: Guardian validates, Brain 2 runs ---------- */
async function onProfileCaptured(raw, chat) {
  addLog("info", "Brain 1 → Guardian · profile handoff");
  const v = guardianValidateProfile(raw);
  v.warnings.forEach(w => addLog("warn", "Guardian · " + w));

  if (!v.ok) {
    v.errors.forEach(er => addLog("block", "Guardian · REJECTED: " + er));
    addMsg(chat, "sys", "The Guardian rejected the profile: " + v.errors.join("; "));
    return;
  }
  addLog("ok", "Guardian · profile valid (" + v.profile.products.length + " products, " + totalKg(v.profile) + " kg/week) → forwarded to Brain 2");
  chat.profile = v.profile;
  chat.phase = "matching"; chat.pct = 45; chat.ts = Date.now();
  chat.title = chatTitle(chat);
  if (chat.id === state.activeChatId) updateHeaderIdentity();
  renderChatRail(); renderDashboard();

  const month = new Date().getMonth() + 1;
  const ranked = rankMatches(v.profile, DB, month);
  chat.candidates = ranked.slice(0, 8);
  addLog("info", "Brain 2 · scored " + ranked.length + " database entries, top score " + ranked[0].score + "/100");

  if (state.offline) { finishWithRecs(offlineRecs(chat), chat); return; }

  addMsg(chat, "sys", "Brain 2 is analysing " + ranked.length + " verified Cassino buyers…");
  setTyping(true);
  try {
    const payload = { farmer_profile: chat.profile, current_month: month,
      candidates: chat.candidates.map(c => ({ buyer_id: c.id, name: c.name, type: c.type, zone: c.zone, distance_km: c.distance_km, buys: c.needs, volume_capacity: c.volume, quality_focus: c.quality_focus, notes: c.notes, engine_score: c.score, engine_reasons: c.reasons, is_channel: c.is_channel })) };
    const resp = await callClaude(SYSTEM_MATCH, [{ role: "user", content: JSON.stringify(payload) }], [TOOL_RECS], 1800, "submit_recommendations");
    setTyping(false);
    const tu = resp.content.find(b => b.type === "tool_use");
    if (!tu) throw new Error("Brain 2 returned no structured recommendations.");
    addLog("info", "Brain 2 → Guardian · recommendations handoff");
    const check = guardianVerifyRecs(tu.input, chat.candidates.map(c => c.id), chat.profile);
    check.issues.forEach(i => addLog(i.level, "Guardian · " + i.msg));
    finishWithRecs(check.verified, chat);
    addMsg(chat, "ai", "Done! I found the best matches for you — check Clients for the outreach draft.");
  } catch (e) {
    setTyping(false);
    showErr(e.message);
    addLog("block", "System · " + e.message);
  }
}

function finishWithRecs(recs, chat) {
  chat.recs = recs;
  chat.phase = "done"; chat.pct = 100;
  addClientFromRecs(recs, chat);
  renderDashboard();
  renderChats();
}

/* ---------- Clients ("chats with clients") ---------- */
function addClientFromRecs(recs, chat) {
  if (!recs.outreach) return;
  const c = chat.candidates.find(x => x.id === recs.outreach.buyer_id); if (!c) return;
  const existing = state.clients.find(x => x.buyerId === c.id && x.status === "draft");
  if (existing) { existing.message_it = recs.outreach.message_it; existing.message_en = recs.outreach.message_en; existing.flagged = !!recs.outreach.flagged_claim; return; }
  state.clients.unshift({
    id: "cl" + Date.now(), buyerId: c.id, name: c.name, type: c.type, zone: c.zone,
    message_it: recs.outreach.message_it, message_en: recs.outreach.message_en,
    flagged: !!recs.outreach.flagged_claim, status: "draft", ts: Date.now(), extra: []
  });
  if (!state.activeClientId) state.activeClientId = state.clients[0].id;
}
function markSent(id) {
  const c = state.clients.find(x => x.id === id); if (!c) return;
  c.status = "sent"; c.sentTs = Date.now();
  toast("Marked as sent to " + c.name);
  renderChats(); renderDashboard();
}

/* ---------- Header identity ---------- */
function updateHeaderIdentity() {
  const chat = activeChat();
  const name = (chat && chat.profile && chat.profile.farmer_name) || "Guest Farmer";
  $("whoName").textContent = name.toUpperCase();
}

/* ================= RENDERERS ================= */
function phaseLabel(p) { return { interview: "Interviewing", matching: "Matching", done: "Outreach ready" }[p] || p; }
function progClass(pct) { return pct >= 70 ? "" : pct >= 30 ? "warn" : "danger"; }
function relDate(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
function adjustPrice(cat) {
  if (!cat) return;
  const cur = PRICE_ASSUMPTIONS[cat] || 3;
  const v = window.prompt("Assumed price for " + (CAT_LABEL[cat] || cat) + " (EUR/kg):", cur.toFixed(2));
  if (v === null) return;
  const n = parseFloat(v.replace(",", "."));
  if (isFinite(n) && n > 0) { PRICE_ASSUMPTIONS[cat] = n; renderDashboard(); }
}

function renderDashboard() {
  if (!$("dashboardScreen")) return;
  const rows = state.chats.filter(c => c.profile).sort((a, b) => b.ts - a.ts);
  const shown = state.showAllResearch ? rows : rows.slice(0, 3);

  $("researchBody").innerHTML = shown.map(c => {
    const top = topProductCategory(c.profile);
    const prod = c.profile.products.find(p => p.category === top) || c.profile.products[0];
    const price = PRICE_ASSUMPTIONS[top] || 3;
    return `<tr>
      <td class="rp-conv"><b>${esc(c.title)}</b><small>${esc(relDate(c.ts))}</small></td>
      <td>${esc(CAT_LABEL[top] || top || "—")}</td>
      <td>${prod ? Math.round(prod.kg_per_week) + " kg/wk" : "—"}</td>
      <td class="rp-price" onclick="adjustPrice('${top}')">€${price.toFixed(2)}/kg</td>
      <td class="rp-prog">
        <div class="progress-track"><div class="progress-fill ${progClass(c.pct)}" style="width:${c.pct}%"></div></div>
        <div class="prog-label">${esc(phaseLabel(c.phase))} · ${c.pct}%</div>
      </td>
    </tr>`;
  }).join("");
  $("researchEmpty").style.display = shown.length ? "none" : "block";
  const seeAll = $("researchSeeAll");
  seeAll.style.display = rows.length > 3 ? "inline-flex" : "none";
  seeAll.textContent = state.showAllResearch ? "Show latest 3" : "See all (" + rows.length + ")";
}

function avatarHTML(name, idx) {
  return `<div class="avatar av-${idx % 5}">${esc((name || "?").slice(0, 2).toUpperCase())}</div>`;
}

function renderChats() {
  if (!$("clientsScreen")) return;
  const list = $("clientList");
  if (!state.clients.length) {
    list.innerHTML = `<div class="empty-state">No matched buyers yet.<br>Talk to Fasto-AI to get your first match.</div>`;
    $("threadPane").innerHTML = `<div class="empty-state" style="margin:auto">Select a conversation</div>`;
    return;
  }
  list.innerHTML = state.clients.map((c, i) => `
    <div class="client-item ${c.id === state.activeClientId ? "active" : ""}" onclick="selectClient('${c.id}')">
      ${avatarHTML(c.name, i)}
      <div style="min-width:0;flex:1">
        <div class="ci-top"><span class="ci-name">${esc(c.name)}</span>${c.status === "sent" ? '<span class="pill pill-accent" style="margin-left:auto">Sent</span>' : '<span class="pill pill-amber" style="margin-left:auto">Draft</span>'}</div>
        <div class="ci-prev">${esc(c.message_it.slice(0, 46))}…</div>
      </div>
    </div>`).join("");
  if (!state.activeClientId) state.activeClientId = state.clients[0].id;
  renderThread();
}
function selectClient(id) { state.activeClientId = id; renderChats(); }

function renderThread() {
  const c = state.clients.find(x => x.id === state.activeClientId);
  const pane = $("threadPane");
  if (!c) { pane.innerHTML = `<div class="empty-state" style="margin:auto">Select a conversation</div>`; return; }
  const idx = state.clients.indexOf(c);
  pane.innerHTML = `
    <div class="thread-head">
      ${avatarHTML(c.name, idx)}
      <div style="min-width:0;flex:1">
        <div class="title-sm">${esc(c.name)}</div>
        <div class="foot">${esc(c.zone)} · ${esc((c.type || "").replace(/_/g, " "))}</div>
      </div>
      ${c.status === "sent" ? '<span class="pill pill-accent">Sent</span>' : '<span class="pill pill-amber">Draft</span>'}
    </div>
    <div class="thread-body" id="threadBody">
      <div class="day-divider">Today</div>
      <div class="bubble meta">Drafted by Brain 2 · real message, not simulated</div>
      ${c.flagged ? '<div class="bubble meta" style="color:var(--warn)">⚠ Guardian adjusted a claim in this draft</div>' : ""}
      <div class="bubble out">${esc(c.message_it)}</div>
      <div class="bubble-actions">
        ${c.status === "sent" ? "" : `<button class="btn btn-ghost btn-sm" onclick="markSent('${c.id}')">Mark as sent</button>`}
        <button class="btn btn-ghost btn-sm" onclick="copyClientMsg('${c.id}')">Copy Italian</button>
      </div>
      <div class="bubble meta">English translation</div>
      <div class="bubble in">${esc(c.message_en)}</div>
      ${(c.extra || []).map(m => `<div class="bubble out">${esc(m.text)}</div>`).join("")}
    </div>
    <div class="thread-input-row">
      <button class="round-icon-btn" title="Attach (not needed for this demo)"><img class="ic-svg sm" src="assets/icon-attach.svg" alt=""></button>
      <input type="text" class="input-glass" id="clientInput" placeholder="Type your message here">
      <button class="round-icon-btn" id="clientSendBtn" title="Send"><img class="ic-svg sm" src="assets/icon-send.svg" alt=""></button>
    </div>`;
  const body = $("threadBody"); body.scrollTop = body.scrollHeight;
  $("clientSendBtn").onclick = () => sendClientNote(c.id);
  $("clientInput").addEventListener("keydown", e => { if (e.key === "Enter") sendClientNote(c.id); });
}
function sendClientNote(id) {
  const input = $("clientInput"); if (!input) return;
  const text = input.value.trim(); if (!text) return;
  const c = state.clients.find(x => x.id === id); if (!c) return;
  c.extra = c.extra || []; c.extra.push({ text, ts: Date.now() });
  input.value = "";
  renderThread();
}
function copyClientMsg(id) { const c = state.clients.find(x => x.id === id); if (c) { navigator.clipboard.writeText(c.message_it); toast("Copied"); } }

/* ================= NAVIGATION ================= */
function switchScreen(name) {
  state.screen = name;
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === name + "Screen"));
  document.querySelectorAll(".nav-item").forEach(s => s.classList.toggle("active", s.dataset.screen === name));
  if (name === "dashboard") renderDashboard();
  if (name === "clients") renderChats();
  if (name === "assistant") { renderChatRail(); renderTranscript(); }
}

/* ================= Offline scripted demo ================= */
const OFFLINE_SCRIPT = [
  "Buongiorno! I'm the Fasto Innova assistant. First — what's your name?",
  "Nice to meet you! Now tell me — what do you grow on your farm?",
  "Lovely! And roughly how many kilograms per week can you offer, for each product?",
  "Great. Which months of the year is your produce available, and where is your farm (village and rough distance from Cassino)?",
  "Last question: do you have an organic certification — yes, no, or partially?",
  "Perfect, let me summarise: tomatoes ~80 kg/week and zucchine ~40 kg/week, June–October, near Sant'Elia Fiumerapido (~6 km), no organic certification. Shall I search for matches?"
];
const OFFLINE_PROFILE = { farmer_name: "Marco", village: "Sant'Elia Fiumerapido", distance_km_from_cassino: 6, organic: "no", available_months: [6,7,8,9,10],
  products: [{ name: "pomodori", category: "pomodori", kg_per_week: 80 }, { name: "zucchine", category: "verdure", kg_per_week: 40 }] };

function offlineTurn(chat) {
  const step = chat.offlineStep++;
  if (step < OFFLINE_SCRIPT.length) {
    setTimeout(() => { addMsg(chat, "ai", OFFLINE_SCRIPT[step]); addLog("info", "Brain 1 · scripted reply (offline mode)"); }, 450);
    if (step === OFFLINE_SCRIPT.length - 1) chat.offlineReady = true;
  }
  if (chat.offlineReady && step === OFFLINE_SCRIPT.length) {
    setTimeout(() => onProfileCaptured(OFFLINE_PROFILE, chat), 550);
  }
}
function offlineRecs(chat) {
  const top = chat.candidates.slice(0, 5);
  return {
    ranked: top.map(c => ({ buyer_id: c.id, pitch_reason: (c.is_channel ? "Direct sales channel: " : "") + c.notes })),
    creative_suggestions: [
      "Surplus tomatoes in late September? Offer them to Di Vetta dal 1934 as artisan passata (conserve).",
      "The Saturday market at Piazza Nicholas Green lets you sell retail at retail prices — good margin on 20-30 kg.",
      "Joining Rete Campagna Amica gives km-0 visibility that hotels like Edra Palace value."
    ],
    outreach: { buyer_id: top[0].id,
      message_it: "Buongiorno, sono Marco, un piccolo produttore di Sant'Elia Fiumerapido. Ogni settimana ho circa 80 kg di pomodori freschi e 40 kg di zucchine, disponibili da giugno a ottobre. Mi piacerebbe proporvi una fornitura diretta: prodotto raccolto in giornata, consegna gestita dal partner logistico di Fasto Innova. Possiamo fissare una breve chiacchierata o portarvi un campione? Grazie!",
      message_en: "Good morning, I'm Marco, a small producer from Sant'Elia Fiumerapido. Every week I have about 80 kg of fresh tomatoes and 40 kg of zucchine, available June to October. I would love to propose a direct supply: picked the same day, delivery handled by Fasto Innova's logistics partner. Could we arrange a short chat, or may I bring you a sample? Thank you!" }
  };
}

/* ================= BOOT ================= */
function boot() {
  const saved = localStorage.getItem("fasto_key");
  if (saved) $("apikey").value = saved;

  let mode = "offline";
  $("modeOffline").onclick = () => { mode = "offline"; $("modeOffline").classList.add("active"); $("modeLive").classList.remove("active"); $("liveKeyBlock").style.display = "none"; };
  $("modeLive").onclick = () => { mode = "live"; $("modeLive").classList.add("active"); $("modeOffline").classList.remove("active"); $("liveKeyBlock").style.display = "block"; };

  $("startBtn").onclick = () => {
    state.offline = (mode === "offline");
    state.apiKey = $("apikey").value.trim();
    state.model = $("model").value;
    if (!state.offline && !state.apiKey.startsWith("sk-ant")) { alert("Paste a valid Anthropic API key (starts with sk-ant), or switch to Offline mode."); return; }
    if (!state.offline && $("remember").checked) localStorage.setItem("fasto_key", state.apiKey);

    $("onboard").style.display = "none";
    $("app").classList.add("ready");
    $("modePill").textContent = state.offline ? "Offline demo" : ("Live · " + (state.model.includes("haiku") ? "Haiku 4.5" : "Sonnet 5"));
    addLog("ok", "Guardian armed. Database loaded: " + DB.buyers.length + " buyers + " + DB.channels.length + " channels (Cassino).");
    addLog("info", "Guardian watching all traffic Brain 1 ⇄ Brain 2.");

    startNewChat();
    switchScreen("dashboard");
    renderChats();
  };

  document.querySelectorAll(".nav-item[data-screen]").forEach(el => el.onclick = () => switchScreen(el.dataset.screen));
  $("newChatBtn").onclick = () => startNewChat();

  $("sendBtn").onclick = () => { const v = $("userInput").value.trim(); if (v) { $("userInput").value = ""; sendUserMessage(v); } };
  $("userInput").addEventListener("keydown", e => { if (e.key === "Enter") $("sendBtn").onclick(); });
  document.querySelectorAll(".sugg-chip").forEach(ch => ch.onclick = () => { $("userInput").value = ch.dataset.fill; $("userInput").focus(); });

  $("topSearch").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    if (state.screen === "clients") {
      document.querySelectorAll(".client-item").forEach(el => { el.style.display = el.textContent.toLowerCase().includes(q) ? "" : "none"; });
    } else if (state.screen === "dashboard") {
      document.querySelectorAll("#researchBody tr").forEach(el => { el.style.display = el.textContent.toLowerCase().includes(q) ? "" : "none"; });
    }
  });

  $("bellBtn").onclick = () => { switchScreen("clients"); toast(state.clients.filter(c => c.status === "draft").length + " draft(s) ready to send"); };
  $("profileBtn").onclick = () => { if (confirm("Restart the demo? This clears the current session.")) location.reload(); };
  $("researchSeeAll").onclick = () => { state.showAllResearch = !state.showAllResearch; renderDashboard(); };

  renderDashboard();
}
document.addEventListener("DOMContentLoaded", boot);
