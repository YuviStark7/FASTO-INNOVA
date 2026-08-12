/* ============================================================
   FASTO INNOVA — Supabase client + data access layer
   ------------------------------------------------------------
   The URL and key below are the PUBLIC ("publishable") ones —
   Supabase's security model is built around this: they're safe
   to ship in client-side code because every table is locked down
   with Row Level Security (see the migration in the project
   notes). This is a different situation from the Anthropic API
   key, which IS secret and is deliberately never stored in any
   file — only ever typed in by hand, in the browser, per session.
   ============================================================ */
const SUPABASE_URL = "https://asiuqyhlpnljhpcvkfaj.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4rVvLMZoV57aPPJK2MRvIg_fuscIRNo";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const DataStore = {
  /* ---------- auth ---------- */
  signUp(email, password) { return sb.auth.signUp({ email, password }); },
  signIn(email, password) { return sb.auth.signInWithPassword({ email, password }); },
  signOut() { return sb.auth.signOut(); },
  async getSession() { const { data } = await sb.auth.getSession(); return data.session; },

  /* ---------- farmer (display row) ---------- */
  getMyFarmer(uid) { return sb.from("farmers").select("*").eq("id", uid).maybeSingle(); },
  updateFarmerName(uid, name) { return sb.from("farmers").update({ farmer_name: name }).eq("id", uid); },

  /* ---------- chats (each chat carries its own captured profile) ---------- */
  listMyChats(uid) { return sb.from("chats").select("*").eq("farmer_id", uid).order("created_at", { ascending: false }); },
  createChat(uid) { return sb.from("chats").insert({ farmer_id: uid }).select().single(); },
  updateChat(chatId, patch) { return sb.from("chats").update(patch).eq("id", chatId); },

  listMessages(chatId) { return sb.from("messages").select("*").eq("chat_id", chatId).order("created_at", { ascending: true }); },
  addMessage(chatId, role, text) { return sb.from("messages").insert({ chat_id: chatId, role, text }); },

  listProducts(chatId) { return sb.from("products").select("*").eq("chat_id", chatId); },
  async saveProducts(chatId, products) {
    const del = await sb.from("products").delete().eq("chat_id", chatId);
    if (del.error) return del;
    if (!products || !products.length) return { error: null };
    const rows = products.map(p => ({ chat_id: chatId, name: p.name, category: p.category, kg_per_week: p.kg_per_week }));
    return sb.from("products").insert(rows);
  },

  saveMatches(chatId, ranked) {
    const rows = ranked.map((r, i) => ({ chat_id: chatId, buyer_id: r.buyer_id, pitch_reason: r.pitch_reason, match_rank: i + 1 }));
    return sb.from("matches").insert(rows);
  },

  /* ---------- outreach (Clients screen) ---------- */
  listMyOutreach(uid) { return sb.from("outreach").select("*").eq("farmer_id", uid).order("created_at", { ascending: false }); },
  createOutreach(uid, chatId, buyerId, messageIt, messageEn, flagged) {
    return sb.from("outreach").insert({ farmer_id: uid, chat_id: chatId, buyer_id: buyerId, message_it: messageIt, message_en: messageEn, flagged }).select().single();
  },
  updateOutreach(id, patch) { return sb.from("outreach").update(patch).eq("id", id); },

  /* ---------- buyers (curated reference database) ---------- */
  listBuyers() { return sb.from("buyers").select("*"); },

  /* ---------- admin (RLS returns every farmer's rows once is_admin=true) ---------- */
  listAllFarmers() { return sb.from("farmers").select("*").order("created_at", { ascending: false }); },
  listAllChats() { return sb.from("chats").select("*").order("updated_at", { ascending: false }); },
  listAllOutreach() { return sb.from("outreach").select("*").order("created_at", { ascending: false }); }
};
