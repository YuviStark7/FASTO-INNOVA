/* ============================================================
   Agri-Link AI — Core engine (Brain 2: Matchmaker, Brain 3: Guardian)
   Pure functions: run in the browser AND in Node for testing.
   ============================================================ */

var CATEGORIES = ["verdure","pomodori","frutta","legumi","olio","vino","uova","formaggi","carne","erbe","castagne","miele","conserve"];

/* Months (1-12) when each category is typically available locally */
var CATEGORY_SEASONS = {
  verdure:   [1,2,3,4,5,6,7,8,9,10,11,12],
  pomodori:  [6,7,8,9,10],
  frutta:    [5,6,7,8,9,10],
  legumi:    [1,2,3,4,5,6,7,8,9,10,11,12],
  olio:      [1,2,11,12],
  vino:      [1,2,3,4,5,6,7,8,9,10,11,12],
  uova:      [1,2,3,4,5,6,7,8,9,10,11,12],
  formaggi:  [1,2,3,4,5,6,7,8,9,10,11,12],
  carne:     [1,2,3,4,5,6,7,8,9,10,11,12],
  erbe:      [3,4,5,6,7,8,9,10],
  castagne:  [10,11],
  miele:     [1,2,3,4,5,6,7,8,9,10,11,12],
  conserve:  [1,2,3,4,5,6,7,8,9,10,11,12]
};

function volumeBand(totalKg) {
  if (totalKg < 50) return "low";
  if (totalKg <= 200) return "medium";
  return "high";
}

function totalKg(profile) {
  return (profile.products || []).reduce(function (s, p) { return s + (Number(p.kg_per_week) || 0); }, 0);
}

function farmerCategories(profile) {
  var set = {};
  (profile.products || []).forEach(function (p) { if (p.category) set[p.category] = true; });
  return Object.keys(set);
}

function topProductCategory(profile) {
  var best = null, kg = -1;
  (profile.products || []).forEach(function (p) {
    if ((Number(p.kg_per_week) || 0) > kg) { kg = Number(p.kg_per_week) || 0; best = p.category; }
  });
  return best;
}

/* ---------- BRAIN 2: deterministic scoring ---------- */
function scoreBuyer(profile, buyer, month) {
  var reasons = [];
  var cats = farmerCategories(profile);
  if (!cats.length) return { score: 0, reasons: ["No products in profile"] };

  // 1. Category match (max 45)
  var matched = cats.filter(function (c) { return buyer.needs.indexOf(c) !== -1; });
  var catPts = 40 * (matched.length / cats.length);
  var topCat = topProductCategory(profile);
  if (topCat && buyer.needs.indexOf(topCat) !== -1) { catPts += 5; reasons.push("Needs your main product (" + topCat + ")"); }
  if (matched.length) reasons.push("Buys " + matched.join(", "));
  else reasons.push("No direct product overlap");

  // 2. Volume fit (max 20)
  var fBand = volumeBand(totalKg(profile));
  var order = ["low", "medium", "high"];
  var diff = Math.abs(order.indexOf(fBand) - order.indexOf(buyer.volume));
  var volPts = diff === 0 ? 20 : (diff === 1 ? 12 : 5);
  if (diff === 0) reasons.push("Volume fits (" + fBand + " ↔ " + buyer.volume + ")");
  else if (diff === 1) reasons.push("Volume roughly compatible");
  else reasons.push("Volume mismatch (" + fBand + " vs " + buyer.volume + ")");

  // 3. Distance (max 15) — proximity to Cassino centre as logistics proxy
  var d = Math.min(Number(buyer.distance_km) || 0, 25);
  var distPts = 15 * (1 - d / 25);
  if (d <= 3) reasons.push("Very close (" + buyer.distance_km + " km)");

  // 4. Quality alignment (max 10)
  var q = buyer.quality_focus || [];
  var qPts = 0;
  var likesQuality = q.some(function (x) { return ["km0","bio","alta_qualità","qualità","qualità_ingredienti","territorio","solo_produttori"].indexOf(x) !== -1; });
  if (profile.organic === "yes" && likesQuality) { qPts = 10; reasons.push("Values organic / km0 producers"); }
  else if (profile.organic === "partial" && likesQuality) { qPts = 7; }
  else if (likesQuality) { qPts = 5; reasons.push("Quality-focused buyer"); }
  else qPts = 3;

  // 5. Seasonality (max 10)
  var months = profile.available_months && profile.available_months.length ? profile.available_months : null;
  var inSeason = months ? months.indexOf(month) !== -1 : true;
  var catInSeason = topCat ? (CATEGORY_SEASONS[topCat] || []).indexOf(month) !== -1 : true;
  var seaPts = (inSeason && catInSeason) ? 10 : (inSeason || catInSeason ? 6 : 3);
  if (inSeason && catInSeason) reasons.push("In season now");
  else if (!inSeason) reasons.push("Supply starts later — plan ahead");

  var score = Math.round(catPts + volPts + distPts + qPts + seaPts);
  return { score: Math.max(0, Math.min(100, score)), reasons: reasons };
}

function rankMatches(profile, db, month) {
  var pool = (db.buyers || []).concat(db.channels || []);
  var ranked = pool.map(function (b) {
    var r = scoreBuyer(profile, b, month);
    return {
      id: b.id, name: b.name, type: b.type, zone: b.zone, distance_km: b.distance_km,
      needs: b.needs, volume: b.volume, quality_focus: b.quality_focus, notes: b.notes,
      confidence: b.confidence, is_channel: (db.channels || []).indexOf(b) !== -1,
      score: r.score, reasons: r.reasons
    };
  });
  ranked.sort(function (a, b) { return b.score - a.score; });
  return ranked;
}

/* ---------- BRAIN 3: Guardian ---------- */
var INJECTION_PATTERNS = [
  /ignore (all|any|previous|prior|the) (instructions|rules|prompts?)/i,
  /disregard (the )?(system|previous)/i,
  /system prompt/i,
  /you are now/i,
  /pretend (to be|you are)/i,
  /jailbreak/i,
  /reveal.*(key|prompt|instructions)/i,
  /<\s*script/i
];

var PII_PATTERNS = [
  { name: "phone number", re: /(\+39\s?)?3\d{2}[\s.\-]?\d{6,7}\b/ },
  { name: "codice fiscale", re: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/i },
  { name: "IBAN", re: /\bIT\d{2}[A-Z]\d{10,26}\b/i },
  { name: "email address", re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/ }
];

function guardianScanText(text) {
  var findings = [];
  INJECTION_PATTERNS.forEach(function (re) {
    if (re.test(text)) findings.push({ level: "block", msg: "Possible prompt-injection pattern detected (" + re.source.slice(0, 30) + "…)" });
  });
  PII_PATTERNS.forEach(function (p) {
    if (p.re.test(text)) findings.push({ level: "warn", msg: "Personal data detected (" + p.name + ") — not needed at this stage, will not be stored in the profile" });
  });
  return findings;
}

function guardianValidateProfile(profile) {
  var errors = [], warnings = [];
  var p = JSON.parse(JSON.stringify(profile || {}));

  if (typeof p.farmer_name === "string" && p.farmer_name.trim()) p.farmer_name = p.farmer_name.trim().slice(0, 60);
  else delete p.farmer_name;

  if (!p.village || typeof p.village !== "string") { p.village = "Cassino area"; warnings.push("Village missing — defaulted to 'Cassino area'"); }
  if (!Array.isArray(p.products) || !p.products.length) errors.push("Profile has no products — cannot match");

  (p.products || []).forEach(function (prod, i) {
    if (CATEGORIES.indexOf(prod.category) === -1) {
      warnings.push("Unknown category '" + prod.category + "' for product " + (prod.name || i) + " — mapped to 'verdure'");
      prod.category = "verdure";
    }
    var kg = Number(prod.kg_per_week);
    if (!isFinite(kg) || kg <= 0) { errors.push("Invalid quantity for " + (prod.name || "product " + i)); }
    else if (kg > 5000) { warnings.push("Quantity " + kg + " kg/week for " + prod.name + " looks too high for a small farm — capped at 5000"); prod.kg_per_week = 5000; }
    else prod.kg_per_week = kg;
  });

  if (["yes", "no", "partial"].indexOf(p.organic) === -1) { p.organic = "no"; warnings.push("Organic status unclear — set to 'no' (never claim what we can't verify)"); }

  if (Array.isArray(p.available_months)) {
    p.available_months = p.available_months.filter(function (m) { return m >= 1 && m <= 12; });
  } else p.available_months = [];

  var d = Number(p.distance_km_from_cassino);
  if (!isFinite(d) || d < 0 || d > 60) { p.distance_km_from_cassino = 8; warnings.push("Farm distance unclear — assumed 8 km"); }

  return { ok: errors.length === 0, errors: errors, warnings: warnings, profile: p };
}

function guardianVerifyRecs(recs, candidateIds, profile) {
  var issues = [];
  var out = { ranked: [], creative_suggestions: [], outreach: null };

  (recs.ranked || []).forEach(function (r) {
    if (candidateIds.indexOf(r.buyer_id) === -1) {
      issues.push({ level: "block", msg: "Blocked: AI referenced a buyer not in the database (id '" + r.buyer_id + "') — removed" });
    } else out.ranked.push(r);
  });

  out.creative_suggestions = (recs.creative_suggestions || []).slice(0, 4);

  var o = recs.outreach;
  if (o) {
    if (candidateIds.indexOf(o.buyer_id) === -1) {
      issues.push({ level: "block", msg: "Blocked: outreach message targeted an unknown buyer — removed" });
    } else {
      var claimsOrganic = /biologic|organic|certificat/i;
      if (profile.organic !== "yes" && (claimsOrganic.test(o.message_it || "") || claimsOrganic.test(o.message_en || ""))) {
        issues.push({ level: "warn", msg: "Outreach draft claimed organic/certified status the farmer does not have — flagged for correction" });
        o.flagged_claim = true;
      }
      if ((o.message_it || "").length > 1200) { o.message_it = o.message_it.slice(0, 1200); issues.push({ level: "warn", msg: "Outreach (IT) truncated to safe length" }); }
      out.outreach = o;
    }
  }
  return { verified: out, issues: issues };
}

/* Node export for testing */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CATEGORIES: CATEGORIES, CATEGORY_SEASONS: CATEGORY_SEASONS,
    volumeBand: volumeBand, totalKg: totalKg, farmerCategories: farmerCategories,
    scoreBuyer: scoreBuyer, rankMatches: rankMatches,
    guardianScanText: guardianScanText, guardianValidateProfile: guardianValidateProfile,
    guardianVerifyRecs: guardianVerifyRecs
  };
}
