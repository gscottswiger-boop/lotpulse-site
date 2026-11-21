// ════════════════════════════════════════════════════════════════════════════
// promo-popup.js — dealer-branded promo offer popup (separate GTM tag)
// ════════════════════════════════════════════════════════════════════════════
// A SEPARATE product from the "Watch this car" widget. It reuses LotPulse's
// backend but is deliberately NOT branded LotPulse on the page: the shopper
// sees the dealer's name and the offer, nothing else. (LotPulse's promise is
// "no forms"; this is a form. Mixing the two brands would muddy that.)
//
// What it does, on a single-vehicle page (VDP) only:
//   1. Finds the VIN (same detection order as lotpulse-widget.js)
//   2. Asks GET /v1/promo/config which offer (if any) this VIN gets. A rooftop
//      can run several offers; the server picks the one highest in the
//      agency's list whose filter covers this car. All of it — on/off, pause,
//      schedules, filters, priority — is decided SERVER-side, so none of it
//      can be read or bypassed from here.
//   3. Shows the popup after N seconds (timed) or, on desktop only, when the
//      mouse leaves through the top of the window (exit intent). Mobile is
//      timed-only: it has no reliable exit signal.
//   4. Collects name / email / phone and POSTs /v1/promo/lead. No SMS consent
//      is asked for or implied — this form never texts anyone.
//
// Never shows:
//   • more than once per VIN per browser session
//   • again on the same VIN within the repeat-suppress window (days)
//   • on ANY vehicle within that window after the shopper has submitted
//   • on a VIN the shopper already watched this session (lotpulse-widget.js
//     sets sessionStorage "lp_watched_<VIN>")
//   • on top of an open LotPulse watch sheet (window.__lotpulseSheetOpen)
//
// REOPEN TAB: when a shopper closes the popup WITHOUT submitting, a small
// "$500 OFF" bookmark tab stays on the right edge of the page. Clicking it
// reopens the popup. It also shows on later visits to that same car while the
// popup itself is being held back, so the offer never becomes unreachable.
// The tab has its own small × ; closing it hides it for the don't-show-again
// window. It never shows after a submit, or on a car the shopper is watching.
// VEHICLE: the popup shows the exact car the offer is for — year, make, model,
// trim, stock number and VIN — under the header, in both text and graphic mode.
//
// PRINTABLE VOUCHER: after a successful submit (and only then) the thank-you
// screen shows the shopper's confirmation code and a "Print my offer" button.
// The voucher carries the dealer, amount, vehicle, shopper's name, dates, fine
// print and the code — the same code that lands in the CRM lead and the
// dashboard's Promo leads list, so the dealer can match paper to lead. All of
// it comes back from the server in the submit response; nothing printable
// exists in the page before that. On phones the voucher opens in a new tab
// (to save or screenshot) instead of going straight to a print dialog.
// Optional GTM config:  printButton: false      (hide the print button)
//
// Optional GTM config:  reopenTab: false        (turn the tab off for a site)
//                       reopenTabTop: "60%"     (move it; % / px / vh from top,
//                                                e.g. to clear a chat widget)
//
// TAB + COLOR FROM THE DASHBOARD: the agency can also set the reopen tab's
// on/off, its position and the accent color per rooftop in the VinPop panel.
// The config response carries them as tab: { enabled, topPct, accent }, each
// null when not set. Each one resolves on its own:
//     dashboard value  →  GTM value (above / accentColor)  →  built-in default
// (on · 50% · navy #1F2A44). Anything malformed falls to the next level.
// Text on the accent (header band, buttons, tab) is white or near-black
// (#14181D), whichever contrasts better, so a light brand color stays readable.
//
// GTM snippet (its own tag, after the LotPulse tag or standalone):
//   <script>
//     window.__lotpulsePromoConfig = {
//       apiBase: "https://lotpulse-q249.onrender.com",
//       publicKey: "<dealer public key>",
//       accentColor: "#C8102E"          // optional: dealer's brand color
//     };
//   </script>
//   <script src="https://login.lotpulse.io/promo-popup.js" async></script>
// If __lotpulsePromoConfig is absent it falls back to __lotpulseConfig, so a
// dealer already running LotPulse only needs the second <script> line.
//
// QA: add ?lp_promo_test=1 to a VDP URL to skip the CLIENT-side suppression
// and use a 3-second delay. Server eligibility still applies — if the promo
// isn't live for this dealer/VIN, nothing shows, test mode or not. Test mode
// also skips the "Who sees VinPop" engagement rules below.
//
// RUNS ON EVERY PAGE (GTM trigger: All Pages). On a page that isn't a single
// vehicle page it never shows the popup — it only counts the visit and sends
// the "Live now" presence heartbeat.
//
// WHO SEES VINPOP (engagement rules, set per rooftop by the agency):
//   • audience "all"     — today's behaviour: every shopper on a VDP.
//   • audience "engaged" — the timed / exit-intent triggers are NOT armed until
//     the shopper meets ANY rule that's switched on: N distinct vehicle pages
//     (this visit or the last 30 days), N active minutes this visit (counted
//     only while the tab is visible), a visit on an earlier day, or N% scroll
//     on this vehicle page. Checked every 5 seconds. Once they qualify, the
//     normal delay and exit-intent logic runs exactly as before.
//   The tally lives in first-party localStorage "lp_eng" on the dealer's
//   domain: a random visitor id, first-seen time, days visited, {VIN: lastSeen}
//   for 30 days, and this visit's active seconds. No name, no IP, no cookie.
//   If storage is blocked: "all" still shows, "engaged" fails closed (no popup).
//
// DEMO: add ?vinpop=demo to any page URL to start a demo for this browser tab
// (it stays on as you click to other vehicle pages; ?vinpop=off ends it). A
// demo shows the popup after 3 seconds, ignores "don't show again" and the
// engagement rules, is labelled DEMO, and its submissions are NOT saved, NOT
// sent to the CRM and NOT counted. When the rooftop's Demo switch is on, the
// server shows the popup ONLY to demo tabs; every other shopper sees nothing,
// while "Live now" keeps tracking everyone.
//
// SITE-WIDE OFFERS (Oct 2026): an offer can also be "site-wide": not tied to
// a car ("$500 off any pre-owned vehicle"), shown on the page kinds the agency
// ticks (homepage, inventory listings, vehicle pages, all other pages) and/or
// pages whose path contains a URL rule. So on EVERY page the popup now asks
// /v1/promo/config with page=home|listings|vehicles|other and the path (never
// the query string). The server decides; on a vehicle page the car's own offer
// wins and a site offer is only the fallback. A site-wide popup shows no car,
// and its voucher names none. Its "don't show again" / reopen-tab memory is
// kept per OFFER ("o<id>") instead of per VIN. Non-vehicle pages that get "no
// site offer here" remember it for 10 minutes in sessionStorage, so browsing
// doesn't call the API on every page.
//
// SCRATCH TO REVEAL: an offer set to reveal "scratch" opens with its amount
// hidden under a silver foil (a canvas over the offer). The shopper scratches
// it off with a finger or mouse; at about half cleared the rest fades away and
// the form appears. "Tap to reveal" does the same in one tap (and from the
// keyboard). Revealed once, it stays revealed for that offer this session —
// except in demo / test mode, where each page load starts covered again.
// dataLayer gets lp_promo_revealed with method scratch / tap.
//
// SCRATCH THEMES (Nov 2026): a scratch offer carries `theme` (classic, plus
// 16 seasonal ids: newyear valentine presidents tax stpatrick spring mothers
// memorial fathers july4 labor halloween veterans thanksgiving blackfriday holiday) and `banner` (the event-banner
// line, or null). A theme changes the foil, the card frame, the header
// wording, the event banner under the header and the reveal effect (snow,
// fireworks, stars, gold confetti on a canvas over the page). The header
// always keeps the dealer's accent color. Unknown / missing theme = Classic,
// exactly as before (the classic DOM confetti is kept as is).
//
// LIVE NOW: POST /v1/promo/presence on page load, every 30s while the tab is
// visible, when the tab is hidden/shown, and on pagehide (sendBeacon). It
// sends the path (query string masked), the page title, the VIN on a VDP, the
// counters above and the VinPop state. Never the full URL.
// ════════════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  if (window.__lotpulsePromoLoaded) return;   // GTM can fire twice
  window.__lotpulsePromoLoaded = true;

  var CONFIG = window.__lotpulsePromoConfig || window.__lotpulseConfig || {};
  var API = (CONFIG.apiBase || "").replace(/\/$/, "");
  var KEY = CONFIG.publicKey || "";
  // GTM layer of the look (see header). null = the GTM tag doesn't set it.
  // Validation is unchanged from before, so every existing tag reads the same.
  var GTM_ACCENT = /^#[0-9a-fA-F]{3,8}$/.test(CONFIG.accentColor || "") ? CONFIG.accentColor : null;
  var GTM_TAB_ON = CONFIG.reopenTab === false ? false : CONFIG.reopenTab === true ? true : null;
  var GTM_TAB_TOP = /^\d{1,4}(%|px|vh)$/.test(CONFIG.reopenTabTop || "") ? CONFIG.reopenTabTop : null;
  var INK = "#14181D";
  // Resolved look. Set from GTM + defaults now, then again from the dashboard
  // values once the config response arrives (before anything is drawn).
  var ACCENT, ON_ACCENT, TAB_ON, TAB_TOP;
  applyLook(null);
  var TEST =/[?&]lp_promo_test=1\b/.test(window.location.search);
  // Demo tab (see header). Remembered in sessionStorage for this tab only.
  var DEMO = (function () {
    var q = window.location.search;
    try {
      if (/[?&]vinpop=demo\b/i.test(q)) { window.sessionStorage.setItem("lp_vinpop_demo", "1"); return true; }
      if (/[?&]vinpop=off\b/i.test(q)) { window.sessionStorage.removeItem("lp_vinpop_demo"); return false; }
      return window.sessionStorage.getItem("lp_vinpop_demo") === "1";
    } catch (e) { return /[?&]vinpop=demo\b/i.test(q); }
  })();
  if (DEMO) TEST = true;   // demo = test-mode timing: 3s, no suppression, no rules
  var PRINT_ON = CONFIG.printButton !== false;

  // ── Look: dashboard → GTM → default, per setting ───────────────────────────
  // "#abc", "#aabbcc" or "#aabbccdd" → [r, g, b]; alpha ignored. null if junk.
  function hexRgb(h) {
    var s = String(h || "").replace(/^#/, "");
    if (!/^[0-9a-fA-F]+$/.test(s)) return null;
    if (s.length === 3 || s.length === 4) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (s.length < 6) return null;
    return [parseInt(s.substr(0, 2), 16), parseInt(s.substr(2, 2), 16), parseInt(s.substr(4, 2), 16)];
  }
  function luminance(rgb) {
    var c = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  // White or near-black text on the accent — whichever has the higher WCAG
  // contrast ratio (ties go to white). Same rule as the dashboard preview.
  function textOn(hex) {
    var rgb = hexRgb(hex);
    if (!rgb) return "#fff";
    var L = luminance(rgb), Lk = luminance(hexRgb(INK));
    return (L + 0.05) / (Lk + 0.05) > 1.05 / (L + 0.05) ? INK : "#fff";
  }
  function applyLook(t) {
    try {
      t = t && typeof t === "object" ? t : {};
      var acc = typeof t.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(t.accent) ? t.accent : null;
      var on = typeof t.enabled === "boolean" ? t.enabled : null;
      var top = typeof t.topPct === "number" && Math.floor(t.topPct) === t.topPct && t.topPct >= 10 && t.topPct <= 90
        ? t.topPct + "%" : null;
      ACCENT = acc || GTM_ACCENT || "#1F2A44";
      TAB_ON = on !== null ? on : GTM_TAB_ON !== false;
      TAB_TOP = top || GTM_TAB_TOP || "50%";
    } catch (e) {
      ACCENT = GTM_ACCENT || "#1F2A44"; TAB_ON = GTM_TAB_ON !== false; TAB_TOP = GTM_TAB_TOP || "50%";
    }
    ON_ACCENT = textOn(ACCENT);
  }

  if (!API || !KEY) {
    console.warn("[Promo] missing apiBase or publicKey; promo not loaded");
    return;
  }

  function log() {
    try { console.log.apply(console, ["[Promo]"].concat([].slice.call(arguments))); } catch (e) {}
  }

  // ── Storage helpers — every access wrapped; privacy modes throw ────────────
  function ssGet(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) {} }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function withinDays(ts, days) {
    var t = parseInt(ts, 10);
    return Number.isFinite(t) && (Date.now() - t) < days * 86400000;
  }

  // ── Engagement tally (localStorage "lp_eng") ───────────────────────────────
  var ENG_KEY = "lp_eng";
  var VISIT_GAP_MS = 30 * 60 * 1000;        // 30 min of nothing = a new visit
  var ENG_WINDOW_MS = 30 * 86400000;        // vehicles / days remembered for 30 days
  var STORAGE_OK = (function () {
    try { var k = "__lp_eng_t"; window.localStorage.setItem(k, "1"); window.localStorage.removeItem(k); return true; }
    catch (e) { return false; }
  })();
  var ENG = null, SCROLL_MAX = 0;
  var PAGE = { kind: null, vin: null };     // kind: "vdp" | "other"
  var RULES = null;                         // engagement rules (config or presence response)

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function localDay(t) { var d = new Date(t); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function randomVid() {
    var out = "";
    try {
      var a = new Uint8Array(12); window.crypto.getRandomValues(a);
      for (var i = 0; i < a.length; i++) out += (a[i] < 16 ? "0" : "") + a[i].toString(16);
      return out;
    } catch (e) {
      while (out.length < 24) out += Math.floor(Math.random() * 16).toString(16);
      return out;
    }
  }
  function refHost() {
    try {
      if (!document.referrer) return null;
      var h = new URL(document.referrer).hostname;
      return h && h !== window.location.hostname ? h : null;
    } catch (e) { return null; }
  }
  function readEng() {
    if (!STORAGE_OK) return null;
    try {
      var e = JSON.parse(window.localStorage.getItem(ENG_KEY) || "null");
      if (!e || typeof e !== "object" || !/^[A-Za-z0-9_-]{8,40}$/.test(e.vid || "")) return null;
      if (!Array.isArray(e.days)) e.days = [];
      if (!e.vins || typeof e.vins !== "object") e.vins = {};
      return e;
    } catch (err) { return null; }
  }
  function writeEng(e) { if (STORAGE_OK) lsSet(ENG_KEY, JSON.stringify(e)); }

  // Re-read before every write so two open tabs don't overwrite each other.
  function engUpdate(fn) {
    var now = Date.now();
    var e = readEng() || ENG || { v: 1, vid: randomVid(), firstSeen: now, days: [], vins: {}, visit: null };
    if (!e.visit || now - (e.visit.last || 0) > VISIT_GAP_MS) {
      e.visit = { start: now, last: now, active: 0, ref: refHost() };
    }
    var t = localDay(now);
    if (e.days.indexOf(t) === -1) e.days.push(t);
    var cutoff = now - ENG_WINDOW_MS;
    e.days = e.days.filter(function (d) { return new Date(d + "T12:00:00").getTime() > cutoff; }).slice(-31);
    for (var v in e.vins) if (e.vins.hasOwnProperty(v) && !(e.vins[v] > cutoff)) delete e.vins[v];
    if (fn) fn(e, now);
    ENG = e;
    writeEng(e);
    return e;
  }

  // The counters the rules are checked against. Pure read of ENG.
  function tally() {
    var e = ENG || {}, now = Date.now(), n = 0, today = localDay(now);
    for (var v in (e.vins || {})) if (e.vins.hasOwnProperty(v) && e.vins[v] > now - ENG_WINDOW_MS) n++;
    return {
      vehicles: n,
      minutes: Math.floor(((e.visit && e.visit.active) || 0) / 60),
      returning: (e.days || []).some(function (d) { return d !== today; }),
      scrollPct: PAGE.kind === "vdp" ? SCROLL_MAX : 0,
      blocked: !STORAGE_OK,
    };
  }

  // Sent with a VinPop submit for the lead's engagement grade (server-side,
  // api/lib/leadGrade.js). visitNumber = distinct days in lp_eng.days.
  function engSnapshot() {
    var t = tally();
    return {
      vehicles: t.vehicles, minutes: t.minutes, returning: t.returning, scrollPct: t.scrollPct,
      visitNumber: ((ENG && ENG.days) || []).length,
    };
  }
  // Up to n VINs viewed in the last 30 days, newest first.
  function recentVins(n) {
    var e = ENG || {}, now = Date.now(), list = [];
    for (var v in (e.vins || {})) {
      if (e.vins.hasOwnProperty(v) && e.vins[v] > now - ENG_WINDOW_MS) list.push([v, e.vins[v]]);
    }
    list.sort(function (a, b) { return b[1] - a[1]; });
    return list.slice(0, n).map(function (x) { return x[0]; });
  }

  // SAME rule as qualifies() in api/lib/promo.js — keep them in sync.
  // true if ANY switched-on rule is met; always true with audience "all";
  // false when storage is blocked and audience is "engaged" (fail closed).
  function qualifies(t, r) {
    if (!r || r.audience !== "engaged") return true;
    if (!t || t.blocked) return false;
    if (r.vehicles != null && (t.vehicles || 0) >= r.vehicles) return true;
    if (r.minutes != null && (t.minutes || 0) >= r.minutes) return true;
    if (r.returning === true && t.returning === true) return true;
    if (r.scrollPct != null && (t.scrollPct || 0) >= r.scrollPct) return true;
    return false;
  }
  // Read-only hooks for QA in the browser console. Expose nothing else.
  try { window.__vinpop = { qualifies: qualifies, tally: tally }; } catch (e) {}

  function trackScroll() {
    function measure() {
      try {
        var de = document.documentElement, h = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
        if (h <= 0) return;
        var pct = Math.min(100, Math.round(((window.scrollY || de.scrollTop || 0) + window.innerHeight) / h * 100));
        if (pct > SCROLL_MAX) SCROLL_MAX = pct;
      } catch (e) {}
    }
    window.addEventListener("scroll", measure, { passive: true });
  }

  // ── Presence heartbeat ("Live now") ────────────────────────────────────────
  function vpState() {
    if (ssGet("lp_promo_submitted_s") || withinDays(lsGet("lp_promo_submitted"), 30)) return "claimed";
    if (ssGet("lp_promo_shown_any")) return "shown";
    var r = RULES || (function () { try { return JSON.parse(ssGet("lp_eng_rules") || "null"); } catch (e) { return null; } })();
    return r && qualifies(tally(), r) ? "qualified" : "not_qualified";
  }
  function beat(how) {
    if (!STORAGE_OK || !ENG || !PAGE.kind) return;   // no stable visitor id → don't count
    var t = tally();
    var body = JSON.stringify({
      vid: ENG.vid, visit: ENG.visit && ENG.visit.start, ref: ENG.visit && ENG.visit.ref,
      // Path only. The query string can carry tokens — never send it.
      page: window.location.pathname + (window.location.search ? "?…" : ""),
      title: String(document.title || "").slice(0, 120),
      vin: PAGE.kind === "vdp" ? PAGE.vin : null,
      vehicles: t.vehicles, minutes: t.minutes, returning: t.returning, scrollPct: t.scrollPct,
      vpState: vpState(), visible: document.visibilityState === "visible",
    });
    var url = API + "/v1/promo/presence?key=" + encodeURIComponent(KEY);
    if (how === "beacon" && navigator.sendBeacon) {
      try { if (navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return; } catch (e) {}
    }
    try {
      fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: body, keepalive: true })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.rules) { if (!CFG) RULES = j.rules; ssSet("lp_eng_rules", JSON.stringify(j.rules)); }
        }).catch(function () {});
    } catch (e) {}
  }

  // One 5-second clock: active time (visible tab only), visit freshness, the
  // engagement gate, and the 30-second heartbeat.
  var lastTick = Date.now(), sinceBeat = 0, waitingForQualify = false;
  function startClock() {
    setInterval(function () {
      var now = Date.now(), dt = Math.min(now - lastTick, 6000);
      lastTick = now;
      if (document.visibilityState === "visible") {
        engUpdate(function (e) { e.visit.active = (e.visit.active || 0) + dt / 1000; e.visit.last = now; });
        sinceBeat += dt;
        if (sinceBeat >= 30000) { sinceBeat = 0; beat(); }
      }
      if (waitingForQualify && CFG && qualifies(tally(), CFG.engagement)) {
        waitingForQualify = false;
        log("shopper qualified — arming triggers");
        armTriggers();
        beat();
      }
    }, 5000);
    document.addEventListener("visibilitychange", function () {
      lastTick = Date.now();
      if (document.visibilityState === "hidden") beat("beacon");
      else { sinceBeat = 0; beat(); }
    });
    window.addEventListener("pagehide", function () {
      if (!PAGE.kind) PAGE.kind = "other";
      beat("beacon");
    });
  }

  // Called once we know what kind of page this is.
  function classify(kind, vin) {
    if (PAGE.kind) return;
    PAGE.kind = kind; PAGE.vin = vin || null;
    if (kind === "vdp" && vin) {
      engUpdate(function (e, now) { e.vins[vin] = now; });
      trackScroll();
    }
    beat();
  }

  // ── Analytics → dealer's own dataLayer (same approach as the watch widget) ─
  function promoEvent(name, params) {
    try {
      window.dataLayer = window.dataLayer || [];
      var payload = { event: name, event_owner: "lotpulse", product_name: "VinPop" };
      for (var k in params) {
        if (params.hasOwnProperty(k) && params[k] != null && params[k] !== "") payload[k] = params[k];
      }
      window.dataLayer.push(payload);
    } catch (e) { /* analytics must never break the popup */ }
  }

  // ASC page_type for the page the popup is on, and the car (if any).
  function evPage() {
    return ({ home: "home", listings: "itemlist", vehicles: "item", other: "other" })[PAGEKIND] || "item";
  }
  function isSite() { return !!(CFG && CFG.placement === "site"); }
  function isScratch() { return !!(CFG && CFG.reveal === "scratch"); }

  // "/" and the usual index files are the homepage; everything else that
  // isn't a vehicle or listing page is "other".
  function homeOrOther() {
    var p = String(window.location.pathname || "/").toLowerCase();
    return /^\/(index\.(html?|php|aspx?))?$/.test(p) || p === "/home" || p === "/home/" ? "home" : "other";
  }

  // ── VIN detection (mirrors lotpulse-widget.js) ─────────────────────────────
  function cleanVin(raw) {
    if (!raw) return null;
    var v = String(raw).toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "");
    return v.length === 17 ? v : null;
  }
  function jsonLdVins() {
    var seen = {}, out = [];
    function walk(n) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) walk(n[i]); return; }
      if (n.vehicleIdentificationNumber) {
        var v = cleanVin(n.vehicleIdentificationNumber);
        if (v && !seen[v]) { seen[v] = true; out.push(v); }
      }
      for (var k in n) if (typeof n[k] === "object") walk(n[k]);
    }
    var s = document.querySelectorAll('script[type="application/ld+json"]');
    for (var j = 0; j < s.length; j++) { try { walk(JSON.parse(s[j].textContent)); } catch (e) {} }
    return out;
  }
  function attrVins() {
    var seen = {}, out = [];
    function add(v) { if (v && !seen[v]) { seen[v] = true; out.push(v); } }
    var els = document.querySelectorAll("[data-vin],[data-vehicle-vin],[itemprop='vehicleIdentificationNumber']");
    for (var i = 0; i < els.length; i++) {
      add(cleanVin(els[i].getAttribute("data-vin") || els[i].getAttribute("data-vehicle-vin")
        || els[i].getAttribute("content") || els[i].textContent));
    }
    // Dealer Inspire list view prints "VIN: <vin>" as text (see the widget).
    var t = document.querySelectorAll("[data-testid='vin-number']");
    for (var k = 0; k < t.length; k++) {
      var m = (t[k].textContent || "").match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
      add(m ? cleanVin(m[1]) : null);
    }
    return out;
  }
  // Returns { vin } on a VDP, { srp: true } on a listing page, or null.
  // The listing test is the SAME one lotpulse-widget.js boot() uses (2+
  // distinct VINs in page elements OR in JSON-LD), so the popup and the
  // widget can never disagree about what kind of page this is. VIN source
  // order also mirrors the widget's findVin(): JSON-LD first.
  function findVdpVin() {
    var ld = jsonLdVins(), at = attrVins();
    if (ld.length >= 2 || at.length >= 2) return { srp: true };
    if (ld.length === 1) return { vin: ld[0] };
    if (at.length === 1) return { vin: at[0] };
    var input = document.querySelector("input[name='vin']");
    var iv = input && cleanVin(input.getAttribute("value"));
    if (iv) return { vin: iv };
    var meta = document.querySelector("meta[name='vin'],meta[property='vehicle:vin']");
    var mv = meta && cleanVin(meta.getAttribute("content"));
    if (mv) return { vin: mv };
    var m = window.location.href.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
    if (m) return { vin: m[1].toUpperCase() };
    return null;
  }

  // ── API ────────────────────────────────────────────────────────────────────
  function apiGet(path) {
    return fetch(API + path, { headers: { "x-lotpulse-key": KEY } }).then(function (r) { return r.json(); });
  }
  function apiPost(path, body) {
    return fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-lotpulse-key": KEY },
      body: JSON.stringify(body),
      keepalive: true,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, json: j }; });
    });
  }

  // ── State ──────────────────────────────────────────────────────────────────
  var VIN = null, CFG = null, IMG = null, shown = false, host = null, root = null;
  // PAGEKIND: home | listings | vehicles | other. SKEY: what "seen / shown /
  // tab closed" is remembered against — the VIN for a car's offer, "o<id>"
  // for a site-wide offer. REVEALED: scratch offer already uncovered.
  var PAGEKIND = null, SKEY = null, REVEALED = true;
  var lastFocus = null, savedOverflow = null, sheetWaits = 0;
  var tabHost = null, lastTrigger = "timed", offerGone = false, viaTab = false;

  function isDesktopPointer() {
    try { return window.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch (e) { return false; }
  }

  // key: VIN (a car's offer) or "o<id>" (site-wide offer). The "already
  // watched" check is always about the car on this page, if there is one.
  function clientSuppressed(key, days) {
    if (TEST) return false;
    if (ssGet("lp_promo_shown_" + key)) return "shown_this_session";
    if (VIN && ssGet("lp_watched_" + VIN)) return "already_watched";
    if (days && withinDays(lsGet("lp_promo_seen_" + key), days)) return "seen_recently";
    if (days && withinDays(lsGet("lp_promo_submitted"), days)) return "submitted_recently";
    return false;
  }

  // ── Markup ─────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function css() {
    return ""
      + ":host{all:initial}"
      + "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}"
      + ".scrim{position:fixed;inset:0;background:rgba(10,12,16,.55);z-index:2147483646;opacity:0;transition:opacity .2s}"
      + ".scrim.in{opacity:1}"
      + ".box{position:fixed;z-index:2147483647;left:50%;top:50%;width:min(420px,calc(100vw - 32px));"
      + "max-height:calc(100vh - 32px);overflow:auto;background:transparent;color:#14171F;"
      + "filter:drop-shadow(0 22px 30px rgba(0,0,0,.30));transform:translate(-50%,-46%);opacity:0;"
      + "transition:transform .22s ease,opacity .22s ease}"
      + ".box.in{transform:translate(-50%,-50%);opacity:1}"
      // No gray scroll bar beside the tag (Nov 2026): the card still scrolls
      // (wheel, trackpad, touch, keyboard) when it's taller than the window;
      // a white fade at the bottom of the card says there's more below. On a
      // card that fits, the fade sits over the body's own bottom padding.
      + ".box{scrollbar-width:none;-ms-overflow-style:none}.box::-webkit-scrollbar{display:none;width:0;height:0}"

      + ".box:focus{outline:none}"
      // Phones: a centered card 16px in from each edge (not a full-width
      // bottom sheet), so the dealer's page stays visible around it. Too tall
      // for the screen (long form, small phone): it scrolls inside the card.
      + "@media (max-width:560px){.box{width:calc(100vw - 32px);"
      + "max-height:calc(100vh - 40px);max-height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px))}"
      // Too tall to float (the form is showing): keep the side margins but
      // run the card down to the bottom edge of the screen, square bottom
      // corners, scrolling inside. A short card (scratch, covered) floats.
      + ".box.tall{top:auto;bottom:0;transform:translate(-50%,24px);"
      + "max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px - env(safe-area-inset-top,0px))}"
      + ".box.tall.in{transform:translate(-50%,0)}"
      + ".box.tall .body{border-radius:0;padding-bottom:calc(18px + env(safe-area-inset-bottom,0px))}}"
      // Hang-tag top (Nov 2026, matches the VinPop logo): a wide flat top with
      // clipped corners in the accent color, and a punched hole that shows the
      // page behind it. The ring is a lighter (or, on a light accent, darker)
      // reinforcement patch around the hole.
      + ".roof{position:relative;height:64px;margin-bottom:-1px;background:" + ACCENT + ";"
      + "clip-path:polygon(0 100%,0 57px,1.5px 52px,55px 2.5px,59px .6px,64px 0,"
      + "calc(100% - 64px) 0,calc(100% - 59px) .6px,calc(100% - 55px) 2.5px,calc(100% - 1.5px) 52px,100% 57px,100% 100%);"
      + "-webkit-mask:radial-gradient(circle at 50% 30px,transparent 10px,#000 10.6px);"
      + "mask:radial-gradient(circle at 50% 30px,transparent 10px,#000 10.6px)}"
      + ".roof i{position:absolute;left:50%;top:30px;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;"
      + "background:" + (ON_ACCENT === INK ? "rgba(20,24,29,.16)" : "rgba(255,255,255,.32)") + "}"
      + "@media (max-width:560px){.roof{height:54px;"
      + "clip-path:polygon(0 100%,0 48px,1.5px 43px,46px 2.5px,50px .6px,55px 0,"
      + "calc(100% - 55px) 0,calc(100% - 50px) .6px,calc(100% - 46px) 2.5px,calc(100% - 1.5px) 43px,100% 48px,100% 100%);"
      + "-webkit-mask:radial-gradient(circle at 50% 26px,transparent 9px,#000 9.6px);"
      + "mask:radial-gradient(circle at 50% 26px,transparent 9px,#000 9.6px)}.roof i{top:26px;width:26px;height:26px;margin:-13px 0 0 -13px}}"
      + ".band{background:" + ACCENT + ";color:" + ON_ACCENT + ";padding:14px 24px 20px;position:relative}"
      + ".dealer{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;margin:0 32px 8px 0}"
      // The offer amount is the whole pitch, so it's the biggest thing on the
      // card: "$750" huge, "OFF" beside it, the vehicle / tagline underneath.
      + ".hl{margin:0 32px 0 0;font-weight:800;line-height:1}"
      + ".amt{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}"
      + ".amt .n{font-size:68px;letter-spacing:-.02em;line-height:.95}"
      + ".amt .off{font-size:34px;letter-spacing:.02em}"
      + ".subhl{display:block;font-size:19px;font-weight:600;line-height:1.3;margin-top:10px;opacity:.95}"
      + "@media (max-width:560px){.amt .n{font-size:52px}.amt .off{font-size:26px}.subhl{font-size:16px;margin-top:8px}}"
      // Offer wording in place of "$X OFF": a sentence, so smaller and wrapping.
      + ".amt.wd .n{font-size:34px;line-height:1.12;letter-spacing:-.01em}"
      + "@media (max-width:560px){.amt.wd .n{font-size:26px}}"
      // Image mode: the dealer's own graphic replaces the colored band. Shown
      // uncropped (contain), since offer art usually has text near the edges.
      + ".art{position:relative;background:" + ACCENT + ";overflow:hidden;line-height:0}"
      + ".art img{display:block;width:100%;height:auto;max-height:46vh;object-fit:contain}"
      + ".art .x{background:rgba(0,0,0,.45);color:#fff}.art .x:hover{background:rgba(0,0,0,.65)}"
      + ".sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}"
      + ".demo{background:#FFD54A;color:#14171F;font-size:11.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;"
      + "text-align:center;padding:7px 12px;line-height:1.3}"
      + ".x{position:absolute;top:4px;right:12px;width:36px;height:36px;border:0;border-radius:50%;"
      + "background:" + (ON_ACCENT === INK ? "rgba(20,24,29,.10)" : "rgba(255,255,255,.16)") + ";color:" + ON_ACCENT + ";"
      + "font-size:22px;line-height:36px;cursor:pointer;padding:0}"
      + ".x:hover{background:" + (ON_ACCENT === INK ? "rgba(20,24,29,.18)" : "rgba(255,255,255,.28)") + "}"
      + ".x:focus-visible,.go:focus-visible,.no:focus-visible,input:focus-visible{outline:3px solid #7AA7FF;outline-offset:2px}"
      + ".body{padding:20px 24px 22px;background:#fff;border-radius:0 0 16px 16px}"
      + ".body::after{content:'';display:block;position:sticky;bottom:-22px;height:26px;margin:-4px -24px -22px;"
      + "background:linear-gradient(rgba(255,255,255,0),#fff 85%);pointer-events:none;border-radius:0 0 16px 16px}"
      + "@media (max-width:560px){.body{padding:16px 18px 18px}.band{padding:12px 18px 16px}.veh{padding:10px 18px 11px}"
      + ".body::after{bottom:-18px;margin:-4px -18px -18px}}"
      + ".sub{font-size:15px;line-height:1.45;color:#3A4150;margin:0 0 16px}"
      + "label{display:block;font-size:13px;font-weight:600;color:#2A303C;margin:0 0 6px}"
      + "input{display:block;width:100%;font-size:16px;padding:12px 14px;border:1.5px solid #CDD2DB;"
      + "border-radius:10px;margin:0 0 12px;color:#14171F;background:#fff}"
      + "input:focus{border-color:" + ACCENT + ";outline:none}"
      + ".hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}"
      + ".err{display:none;background:#FDECEC;color:#9B1C1C;font-size:14px;padding:10px 12px;border-radius:8px;margin:0 0 12px}"
      + ".go{display:block;width:100%;border:0;border-radius:10px;padding:14px 16px;font-size:17px;font-weight:700;"
      + "color:" + ON_ACCENT + ";background:" + ACCENT + ";cursor:pointer}"
      + ".go:disabled{opacity:.6;cursor:default}"
      + ".no{display:block;margin:12px auto 0;background:none;border:0;color:#5A6272;font-size:14px;"
      + "text-decoration:underline;cursor:pointer;padding:6px}"
      + ".fine{font-size:12px;line-height:1.45;color:#6A7282;margin:14px 0 0}"
      + ".fine a{color:#4A5262}"
      // Vehicle strip: which car this offer is for.
      + ".veh{background:#F3F5F9;border-bottom:1px solid #E3E7EE;padding:11px 24px 12px}"
      + ".veh .vt{font-size:15.5px;font-weight:700;color:#14171F;line-height:1.3}"
      + ".veh .vm{font-size:12px;color:#4A5262;margin-top:3px;line-height:1.5;word-break:break-word}"
      + ".veh .vm b{font-weight:600;color:#2A303C}"
      + ".veh .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em}"
      + ".code{display:none;border:1.5px dashed #B9C0CC;border-radius:10px;padding:10px 12px;margin:0 0 14px}"
      + ".code span{display:block;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:#5A6272}"
      + ".code strong{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:24px;"
      + "letter-spacing:.08em;color:#14171F;margin-top:2px;user-select:all}"
      + ".go.print{display:none;margin-bottom:4px}"
      + ".done{display:none;text-align:center;padding:8px 0 4px}"
      + ".check{width:52px;height:52px;border-radius:50%;background:#E7F6EE;color:#1E8E5A;display:flex;"
      + "align-items:center;justify-content:center;margin:0 auto 12px;font-size:28px}"
      + ".done h3{font-size:20px;margin:0 0 8px}.done p{font-size:15px;color:#3A4150;line-height:1.45;margin:0 0 16px}"
      // Scratch to reveal: the offer sits under a canvas "foil". touch-action
      // none on the canvas so a finger scratches instead of scrolling.
      + ".hl.sc{font-size:26px;font-weight:800;line-height:1.15;letter-spacing:-.01em}"
      + "@media (max-width:560px){.hl.sc{font-size:22px}.tk{height:150px}.prize .pa .n{font-size:48px}.prize .pa .off{font-size:24px}}"
      + ".tk{position:relative;height:172px;border-radius:12px;overflow:hidden;margin:0 0 10px;"
      + "border:2px dashed " + (ON_ACCENT === INK ? "#B9C0CC" : ACCENT) + ";background:#F7F8FB;"
      + "-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}"
      + ".prize{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;"
      + "text-align:center;padding:10px 14px}"
      + ".prize .pa{display:flex;align-items:baseline;gap:8px;color:" + (ON_ACCENT === INK ? INK : ACCENT) + ";font-weight:800;line-height:1}"
      + ".prize .pa .n{font-size:56px;letter-spacing:-.02em}.prize .pa .off{font-size:28px}"
      + ".prize .pa.wd{display:block;text-align:center;padding:0 14px}.prize .pa.wd .n{font-size:28px;line-height:1.12;letter-spacing:-.01em}"
      + "@media (max-width:560px){.prize .pa.wd .n{font-size:22px}}"
      + ".prize .pl{font-size:16px;font-weight:600;color:#2A303C;margin-top:8px;line-height:1.3}"
      + ".prize img{max-width:100%;max-height:100%;object-fit:contain;display:block}"
      + ".tk canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab;transition:opacity .45s ease}"
      + ".tk canvas:active{cursor:grabbing}"
      + ".tk canvas.gone{opacity:0;pointer-events:none}"
      + ".hint{display:flex;align-items:center;gap:10px;font-size:13px;color:#5A6272;margin:0 0 6px}"
      + ".meter{flex:1;height:5px;border-radius:5px;background:#E3E7EE;overflow:hidden;min-width:40px}"
      + ".meter b{display:block;height:100%;width:0;background:" + ACCENT + ";transition:width .15s}"
      + ".rv{background:none;border:0;padding:6px 0;font-size:13px;font-weight:700;cursor:pointer;"
      + "color:" + (ON_ACCENT === INK ? INK : ACCENT) + ";text-decoration:underline;text-underline-offset:2px;white-space:nowrap}"
      + ".rv:focus-visible{outline:3px solid #7AA7FF;outline-offset:2px}"
      + ".bit{position:absolute;left:50%;top:45%;width:7px;height:11px;border-radius:2px;pointer-events:none;"
      + "animation:lpburst .9s ease-out forwards}"
      + "@keyframes lpburst{to{transform:translate(var(--dx),var(--dy)) rotate(var(--r));opacity:0}}"
      + ".form-in{animation:lpfade .3s ease}@keyframes lpfade{from{opacity:0;transform:translateY(6px)}}"
      + "@media (prefers-reduced-motion:reduce){.bit{display:none}.form-in{animation:none}.tk canvas{transition:none}}"
      // Scratch themes: event banner under the header, the bow on the card,
      // and the effects canvas over the whole page.
      + ".strip{display:flex;align-items:center;justify-content:center;gap:8px;min-height:30px;padding:6px 12px;text-align:center;"
      + "font-size:11.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;line-height:1.3}"
      + ".strip svg{width:12px;height:12px;flex:none}"
      + ".tkw{position:relative}"
      + ".tkw .bow{position:absolute;left:50%;top:-17px;width:64px;height:40px;margin-left:-32px;pointer-events:none;z-index:2;"
      + "filter:drop-shadow(0 2px 2px rgba(0,0,0,.25))}"
      + ".fx{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647}"
      // Short desktop windows (most laptops): tighter spacing and a shorter
      // scratch card, so the whole form, button included, fits on screen.
      // Phones keep their own layout above.
      + "@media (min-width:561px) and (max-height:980px){"
      + ".band{padding:10px 24px 13px}.dealer{margin-bottom:5px}.hl.sc{font-size:23px}"
      + ".amt .n{font-size:56px}.amt .off{font-size:28px}.amt.wd .n{font-size:30px}.subhl{font-size:17px;margin-top:6px}"
      + ".veh{padding:7px 24px 8px}.veh .vt{font-size:15px}.veh .vm{margin-top:1px}"
      + ".body{padding:14px 24px 16px}.sub{font-size:14px;margin:0 0 10px}"
      + "label{margin:0 0 4px}input{padding:9px 12px;margin:0 0 9px}.err{margin:0 0 9px}"
      + ".go{padding:11px 16px;font-size:16px}.no{margin:6px auto 0;padding:4px}.fine{margin:8px 0 0;font-size:11.5px}"
      + ".tk{height:120px;margin:0 0 8px}.prize .pa .n{font-size:46px}.prize .pa .off{font-size:23px}"
      + ".prize .pa.wd .n{font-size:24px}.prize .pl{font-size:14.5px;margin-top:4px}.hint{margin:0 0 4px}"
      + ".code{margin:0 0 10px}.done p{margin:0 0 12px}"
      + ".body::after{bottom:-16px;margin:-4px -24px -16px}}"
      // Very short windows: the scratch card and form shrink a bit more.
      + "@media (min-width:561px) and (max-height:800px){"
      + ".tk{height:100px}.prize .pa .n{font-size:40px}.prize .pa .off{font-size:20px}.prize .pl{font-size:13.5px}"
      + ".sub{margin:0 0 8px}input{padding:8px 12px;margin:0 0 7px}label{font-size:12.5px;margin:0 0 3px}}";
  }

  function amountLabel() {
    return "$" + Math.round((CFG.offerCents || 0) / 100).toLocaleString("en-US");
  }
  // The offer's own wording, shown INSTEAD of "$X OFF" (e.g. "Get up to
  // $2,000 Over Trade Value For Your Vehicle!"). "" = "$X OFF" as always.
  function wordingText() {
    return CFG && typeof CFG.wording === "string" ? CFG.wording.replace(/\s+/g, " ").trim() : "";
  }
  // The big amount block: "$X" + "OFF", or the wording on its own.
  function amountHtml(cls, style) {
    var w = wordingText();
    return w
      ? '<span class="' + cls + ' wd"' + (style || "") + '><span class="n">' + esc(w) + '</span></span>'
      : '<span class="' + cls + '"' + (style || "") + '><span class="n">' + esc(amountLabel()) + '</span><span class="off">OFF</span></span>';
  }

  // Line under the big amount. The agency's own line is shown as written. The
  // automatic one ("this 2024 Toyota RAV4") would just repeat the vehicle strip
  // directly below it, so it becomes "on this vehicle" and the strip names the car.
  function subheadText() {
    var sub = CFG.subhead || CFG.headline || "";
    if (CFG.vehicleLabel && sub === "this " + CFG.vehicleLabel) return "on this vehicle";
    return sub;
  }

  // ── Scratch themes ─────────────────────────────────────────────────────────
  var GOLD = "linear-gradient(135deg,#B38A2E,#F5DE8C 35%,#C9A24A 60%,#F2D27A 85%,#A67C24)";
  function stripes(a, b) { return "repeating-linear-gradient(45deg," + a + " 0 9px,#FFFFFF 9px 18px," + b + " 18px 27px,#FFFFFF 27px 36px)"; }
  // pat: foil pattern {k, a, b}. fx: reveal effect {t: burst | fall | fireworks
  // | classic, s: particle shape, c: colors, n: count}.
  var THEMES = {
    classic: { cover: "Scratch to reveal your offer", revealed: "You uncovered {a} off",
      strip: { bg: "#14213D", color: "#FFFFFF", icon: "spark" },
      foil: ["#B8BFCA", "#EEF1F5", "#C2C8D2", "#E5E8EE", "#ADB4C0"], foilTitle: "SCRATCH HERE", foilSub: "to see your offer",
      titleColor: "#4A5266", subColor: "#5E6678", pat: { k: "dollar", a: "rgba(20,33,61,.09)" }, fx: { t: "classic" } },
    newyear: { cover: "Scratch to start the new year with savings", revealed: "Happy New Year! {a} off",
      strip: { bg: "#0B1229", color: "#F2D27A", icon: "spark" },
      foil: ["#0D1531", "#2B3B70", "#121C40", "#3A3360", "#0B1229"], foilTitle: "SCRATCH HERE", foilSub: "to ring in your offer", dark: true,
      titleColor: "#F2D27A", subColor: "#C9D2EE", pat: { k: "starspark", a: "rgba(242,210,122,.38)", b: "rgba(255,255,255,.30)" },
      ticketBg: "#0E1733", frame: GOLD, amount: "#F2D27A", line: "#E8ECF8",
      fx: { t: "fireworks", c: ["#F2D27A", "#FFFFFF", "#C9D2EE", "#F5B942"] } },
    valentine: { cover: "Scratch to fall in love with your next car", revealed: "Love at first sight: {a} off",
      strip: { bg: "#B0183D", color: "#FFFFFF", icon: "heart" },
      foil: ["#E8789A", "#F9C6D4", "#EC8DAA", "#FBD5DF", "#D9607F"], foilTitle: "SCRATCH HERE", foilSub: "to find your match",
      titleColor: "#7A0F2C", subColor: "#8E2A47", pat: { k: "heart", a: "rgba(255,255,255,.55)", b: "rgba(176,24,61,.22)" },
      ticketBg: "#FFF5F8", frame: stripes("#D61F4D", "#F48FB1"), amount: "#C2123F", line: "#5A1428",
      fx: { t: "burst", s: "heart", c: ["#D61F4D", "#F48FB1", "#FFFFFF", "#B0183D"] } },
    presidents: { cover: "Scratch to reveal your Presidents Day deal", revealed: "Your Presidents Day deal: {a} off",
      strip: { bg: "#0E2A5C", color: "#FFFFFF", icon: "star", border: "#B22234" },
      foil: ["#1A2D5A", "#3B5491", "#22386B", "#4A5F9A", "#16264D"], foilTitle: "SCRATCH HERE", foilSub: "to see your deal", dark: true,
      titleColor: "#FFFFFF", subColor: "#C9D2EE", pat: { k: "star", a: "rgba(255,255,255,.30)", b: "rgba(255,255,255,.16)" },
      ticketBg: "#FFFFFF", frame: stripes("#B22234", "#0E2A5C"), amount: "#0E2A5C", line: "#1D2B57",
      fx: { t: "burst", s: "star", c: ["#B22234", "#FFFFFF", "#0E2A5C"] } },
    tax: { cover: "Scratch to stretch your tax refund", revealed: "Your tax refund bonus: {a} off",
      strip: { bg: "#14532D", color: "#FFFFFF", icon: "dollar" },
      foil: ["#2F6B3F", "#7FB58A", "#3E7D4E", "#9CC7A5", "#285C36"], foilTitle: "SCRATCH HERE", foilSub: "to see your refund bonus",
      titleColor: "#0F3D20", subColor: "#163F25", pat: { k: "dollar", a: "rgba(255,255,255,.28)" },
      ticketBg: "#F3FAF4", frame: "linear-gradient(135deg,#14532D,#4C9A5F 50%,#14532D)", amount: "#14532D", line: "#1E3A2A",
      fx: { t: "fall", s: "bill", c: ["#3E7D4E", "#7FB58A", "#14532D", "#B9DCC0"] } },
    stpatrick: { cover: "Scratch to see how lucky you are", revealed: "Lucky you: {a} off",
      strip: { bg: "#0B6E3B", color: "#FFFFFF", icon: "clover" },
      foil: ["#1E7A44", "#7CC79A", "#2B8C53", "#9BD6B1", "#17683A"], foilTitle: "SCRATCH FOR LUCK", foilSub: "to see your offer",
      titleColor: "#0B3D20", subColor: "#14532D", pat: { k: "clover", a: "rgba(255,255,255,.45)", b: "rgba(11,61,32,.20)" },
      ticketBg: "#F4FBF6", frame: GOLD, amount: "#0B6E3B", line: "#1E3A2A",
      fx: { t: "burst", s: "clovercoin", c: ["#1E7A44", "#2B8C53", "#F2D27A", "#C9A24A"] } },
    spring: { cover: "Scratch to find your springtime offer", revealed: "You found {a} off",
      strip: { bg: "#6A3FB5", color: "#FFFFFF", icon: "flower" },
      foil: ["#B9A6E3", "#E9E1FA", "#C7B8EC", "#F1EBFC", "#A995DA"], foilTitle: "SCRATCH TO FIND", foilSub: "your springtime offer",
      titleColor: "#4B2E83", subColor: "#5E4596", pat: { k: "egg", a: "#FDE7EE", b: "#FFF6C7", c: "#D7F0E2", d: "#DCE6FA" },
      ticketBg: "#FFFDF5", frame: "repeating-linear-gradient(45deg,#F4A9C0 0 9px,#FFE57A 9px 18px,#8FD3B0 18px 27px,#9DB8F0 27px 36px)", amount: "#6A3FB5", line: "#3A2A55",
      fx: { t: "burst", s: "egg", c: ["#F4A9C0", "#FFE57A", "#8FD3B0", "#9DB8F0", "#C9B2F2"] } },
    mothers: { cover: "Scratch to reveal your Mother's Day offer", revealed: "You uncovered {a} off",
      strip: { bg: "#A33C6B", color: "#FFFFFF", icon: "flower" },
      foil: ["#E9A7B8", "#FBE3E8", "#EFB7C5", "#FDEDF1", "#DC90A4"], foilTitle: "SCRATCH HERE", foilSub: "to see your offer",
      titleColor: "#7A2346", subColor: "#8E3A5C", pat: { k: "flower", a: "rgba(255,255,255,.65)", b: "rgba(163,60,107,.25)" },
      ticketBg: "#FFF7F9", frame: "linear-gradient(135deg,#E8A0B4,#FBE3E8 40%,#D987A0 70%,#F4C6D2)", amount: "#A33C6B", line: "#4A2034",
      fx: { t: "fall", s: "petal", c: ["#F4A7BB", "#FBD5DF", "#E8789A", "#FFFFFF"] } },
    memorial: { cover: "Scratch to reveal your Memorial Day offer", revealed: "You uncovered {a} off",
      strip: { bg: "#1B2A55", color: "#FFFFFF", icon: "star", border: "#7A1424" },
      foil: ["#2B2F3A", "#5A6072", "#353A47", "#6B7182", "#262A34"], foilTitle: "SCRATCH HERE", foilSub: "to see your offer", dark: true,
      titleColor: "#F1F3F7", subColor: "#C5CAD6", pat: { k: "star", a: "rgba(255,255,255,.22)", b: "rgba(255,255,255,.12)" },
      ticketBg: "#F7F7F4", frame: "linear-gradient(90deg,#7A1424,#1B2A55)", amount: "#7A1424", line: "#1B2A55",
      fx: { t: "burst", s: "star", c: ["#7A1424", "#FFFFFF", "#1B2A55"], n: 24 } },
    fathers: { cover: "Scratch to reveal your Father's Day offer", revealed: "You uncovered {a} off",
      strip: { bg: "#1F3A5F", color: "#FFFFFF", icon: "tie" },
      foil: ["#3E5A7E", "#8BA4C4", "#4A6A92", "#A3B8D2", "#34506F"], foilTitle: "SCRATCH HERE", foilSub: "to see your offer",
      titleColor: "#0E1E33", subColor: "#13263F", pat: { k: "plaid", a: "rgba(255,255,255,.16)", b: "rgba(15,30,51,.14)" },
      ticketBg: "#F5F8FB", frame: "linear-gradient(135deg,#1F3A5F,#8BA4C4 50%,#1F3A5F)", amount: "#1F3A5F", line: "#2A2F38",
      fx: { t: "burst", s: "rect", c: ["#1F3A5F", "#8BA4C4", "#C9A24A", "#FFFFFF"] } },
    july4: { cover: "Scratch to reveal your 4th of July offer", revealed: "You uncovered {a} off",
      strip: { bg: "#1D3A8A", color: "#FFFFFF", icon: "star", border: "#B22234" },
      foil: ["#AEBBD3", "#EEF2F9", "#B9C5DB", "#E6ECF6", "#A3B1CC"], foilTitle: "SCRATCH HERE", foilSub: "to see your offer",
      titleColor: "#1D2B57", subColor: "#3B4A75", pat: { k: "star", a: "rgba(178,34,52,.30)", b: "rgba(29,58,138,.28)" },
      ticketBg: "#FFFFFF", frame: stripes("#B22234", "#1D3A8A"), amount: "#1D3A8A", line: "#1D2B57",
      fx: { t: "burst", s: "star", c: ["#B22234", "#FFFFFF", "#1D3A8A"] } },
    labor: { cover: "Scratch to reveal your Labor Day deal", revealed: "Your Labor Day deal: {a} off",
      strip: { bg: "#1F4E8C", color: "#FFFFFF", icon: "sun" },
      foil: ["#E07A1F", "#F6B66A", "#E58A2E", "#F8C886", "#D06A12"], foilTitle: "SCRATCH HERE", foilSub: "to see your deal",
      titleColor: "#4A2203", subColor: "#5A2A08", pat: { k: "sun", a: "rgba(255,255,255,.45)", b: "rgba(120,50,0,.18)" },
      ticketBg: "#FFF8F0", frame: "linear-gradient(135deg,#1F4E8C,#3A78C2 50%,#1F4E8C)", amount: "#1F4E8C", line: "#2A2A2A",
      fx: { t: "burst", s: "rect", c: ["#E07A1F", "#1F4E8C", "#F6B66A", "#FFFFFF"] } },
    halloween: { cover: "Scratch for a treat", revealed: "Treat unlocked: {a} off",
      strip: { bg: "#1A1024", color: "#FF8A1F", icon: "moon" },
      foil: ["#1E1230", "#4A2A6B", "#2A1A40", "#5A3A20", "#1A0F28"], foilTitle: "SCRATCH FOR A TREAT", foilSub: "no tricks, just savings", dark: true,
      titleColor: "#FF8A1F", subColor: "#D9C6F0", pat: { k: "pumpkin", a: "rgba(255,138,31,.42)", b: "rgba(255,255,255,.16)" },
      ticketBg: "#1B1226", frame: "repeating-linear-gradient(45deg,#FF7A00 0 9px,#1B1226 9px 18px)", amount: "#FF8A1F", line: "#F1E6FF",
      fx: { t: "burst", s: "bat", c: ["#FF7A00", "#7B3FB8", "#1A1024", "#9BE15D"] } },
    veterans: { cover: "Scratch to reveal your Veterans Day offer", revealed: "You uncovered {a} off",
      strip: { bg: "#1B2A55", color: "#FFFFFF", icon: "star", border: "#7A1424" },
      foil: ["#5B6146", "#9AA07E", "#6B7253", "#A9AE8E", "#4F553C"], foilTitle: "SCRATCH HERE", foilSub: "to see your offer",
      titleColor: "#1A1F10", subColor: "#262C18", pat: { k: "star", a: "rgba(255,255,255,.32)", b: "rgba(27,42,85,.20)" },
      ticketBg: "#FBFAF5", frame: "linear-gradient(90deg,#7A1424 0 33%,#FFFFFF 33% 66%,#1B2A55 66%)", amount: "#1B2A55", line: "#2A2F20",
      fx: { t: "burst", s: "star", c: ["#7A1424", "#FFFFFF", "#1B2A55"], n: 24 } },
    thanksgiving: { cover: "Scratch to reveal your Thanksgiving offer", revealed: "Something to be thankful for: {a} off",
      strip: { bg: "#7A3A12", color: "#FFFFFF", icon: "leaf" },
      foil: ["#A85A1E", "#E7A35C", "#B86A2A", "#EDB777", "#8F4A16"], foilTitle: "SCRATCH HERE", foilSub: "to see your offer",
      titleColor: "#3A1803", subColor: "#4A2208", pat: { k: "leaf", a: "rgba(255,255,255,.42)", b: "rgba(90,30,0,.20)" },
      ticketBg: "#FFF8EE", frame: "linear-gradient(135deg,#7A3A12,#D98A3A 35%,#A85A1E 60%,#E7A35C 85%,#7A3A12)", amount: "#8F3A0F", line: "#3E2412",
      fx: { t: "fall", s: "leaf", c: ["#C0571A", "#E39B3B", "#8F3A0F", "#D6A13A"] } },
    blackfriday: { cover: "Scratch to reveal your Black Friday deal", revealed: "Your Black Friday deal: {a} off",
      strip: { bg: "#0E0E10", color: "#F2D27A", icon: "tag" },
      foil: ["#141418", "#3A3A44", "#1C1C22", "#4A4636", "#121216"], foilTitle: "SCRATCH HERE", foilSub: "to see your deal", dark: true,
      titleColor: "#F2D27A", subColor: "#CFC4A0", pat: { k: "percent", a: "rgba(242,210,122,.16)" },
      ticketBg: "#121214", frame: GOLD, amount: "#F2D27A", line: "#FFFFFF",
      fx: { t: "burst", s: "rect", c: ["#F2D27A", "#C9A24A", "#FFFFFF", "#2A2A2E"] } },
    holiday: { cover: "Scratch to unwrap your holiday offer", revealed: "You unwrapped {a} off",
      strip: { bg: "#1E6B3A", color: "#FFFFFF", icon: "flake" },
      foil: ["#A87A22", "#F3D98B", "#C99A3A", "#F6E3A6", "#9C6F1C"], foilTitle: "SCRATCH TO UNWRAP", foilSub: "your holiday offer",
      titleColor: "#5A3A06", subColor: "#6E4E14", pat: { k: "snow", a: "rgba(255,255,255,.62)" },
      ticketBg: "#FFF9EE", frame: stripes("#C8102E", "#1E6B3A"), amount: "#B3122A", line: "#1E3A2A", bow: true,
      fx: { t: "fall", s: "flake", c: ["#FFFFFF"] } }
  };
  function th() { return THEMES[CFG && CFG.theme] || THEMES.classic; }
  function themeId() { return CFG && THEMES[CFG.theme] ? CFG.theme : "classic"; }
  // With offer wording the prize itself says what the offer is, so the line
  // above it says "your offer" rather than "$X off".
  function revealedLine() {
    return wordingText() ? th().revealed.replace("{a} off", "your offer") : th().revealed.replace("{a}", amountLabel());
  }
  var STRIP_ICONS = {
    flake: '<svg viewBox="-10 -10 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M0-9V9M-7.8-4.5 7.8 4.5M-7.8 4.5 7.8-4.5"/></svg>',
    star: '<svg viewBox="-10 -10 20 20" fill="currentColor" aria-hidden="true"><path d="M0-9.5 2.6-3.1 9.5-3 4.1 1.3 5.9 8 0 4.2-5.9 8-4.1 1.3-9.5-3-2.6-3.1Z"/></svg>',
    spark: '<svg viewBox="-10 -10 20 20" fill="currentColor" aria-hidden="true"><path d="M0-10 2.2-2.2 10 0 2.2 2.2 0 10-2.2 2.2-10 0-2.2-2.2Z"/></svg>',
    tag: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h6.1c.4 0 .8.2 1.1.4l7 7a1.5 1.5 0 0 1 0 2.1l-6.1 6.1a1.5 1.5 0 0 1-2.1 0l-7-7A1.5 1.5 0 0 1 2 9.6ZM6.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/></svg>',
    heart: '<svg viewBox="-10 -10 20 20" fill="currentColor" aria-hidden="true"><path d="M0 8C-11 1-8-9 0-4C8-9 11 1 0 8Z"/></svg>',
    clover: '<svg viewBox="-10 -10 20 20" fill="currentColor" aria-hidden="true"><circle cx="0" cy="-4.5" r="4.2"/><circle cx="-4.2" cy="1.5" r="4.2"/><circle cx="4.2" cy="1.5" r="4.2"/><path d="M-.8 2h1.6L2 10H.4Z"/></svg>',
    flower: '<svg viewBox="-10 -10 20 20" fill="currentColor" aria-hidden="true"><circle cx="0" cy="-5" r="3.6"/><circle cx="4.8" cy="-1.5" r="3.6"/><circle cx="3" cy="4.2" r="3.6"/><circle cx="-3" cy="4.2" r="3.6"/><circle cx="-4.8" cy="-1.5" r="3.6"/></svg>',
    sun: '<svg viewBox="-10 -10 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="0" cy="0" r="4" fill="currentColor"/><path d="M0-9.5V-7M0 7V9.5M-9.5 0H-7M7 0H9.5M-6.7-6.7-5-5M5 5 6.7 6.7M-6.7 6.7-5 5M5-5 6.7-6.7"/></svg>',
    leaf: '<svg viewBox="-10 -10 20 20" fill="currentColor" aria-hidden="true"><path d="M-7 7C-8-4 0-9 8-8C9 0 4 8-7 7Z"/></svg>',
    moon: '<svg viewBox="-10 -10 20 20" fill="currentColor" aria-hidden="true"><path d="M3-9A9 9 0 1 0 9 3 7 7 0 0 1 3-9Z"/></svg>',
    tie: '<svg viewBox="-10 -10 20 20" fill="currentColor" aria-hidden="true"><path d="M-3-9H3L1.6-5.5 4 6 0 9.5-4 6-1.6-5.5Z"/></svg>',
    dollar: '<svg viewBox="-10 -10 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M0-9.5V9.5M5-5C4-7 2-7.5 0-7.5S-5-6.5-5-4 0-1.5 0-.5 5 1.5 5 4.5 2 7.5 0 7.5-4 7-5 5"/></svg>'
  };
  var BOW_SVG = '<svg class="bow" viewBox="0 0 64 40" aria-hidden="true">'
    + '<path d="M32 20 C22 2,4 4,6 14 C8 24,24 24,32 20Z" fill="#C8102E" stroke="#8E0B20" stroke-width="1.5"/>'
    + '<path d="M32 20 C42 2,60 4,58 14 C56 24,40 24,32 20Z" fill="#C8102E" stroke="#8E0B20" stroke-width="1.5"/>'
    + '<path d="M30 22 L22 38 L27 36 L29 40 L32 24Z" fill="#B00D27"/><path d="M34 22 L42 38 L37 36 L35 40 L32 24Z" fill="#B00D27"/>'
    + '<path d="M13 12 C17 9,23 11,27 16" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="2" stroke-linecap="round"/>'
    + '<circle cx="32" cy="19" r="5.5" fill="#E0213F" stroke="#8E0B20" stroke-width="1.5"/></svg>';
  // The event banner under the header ("Holiday Sales Event"), if any.
  function stripHtml() {
    var line = CFG && typeof CFG.banner === "string" ? CFG.banner.trim() : "";
    if (!line) return "";
    var st = th().strip, ic = STRIP_ICONS[st.icon] || "";
    return '<div class="strip" style="background:' + st.bg + ';color:' + st.color
      + (st.border ? ';border-bottom:4px solid ' + st.border : '') + '">' + ic + '<span>' + esc(line) + '</span>' + ic + '</div>';
  }

  // Scratch header: the band never gives the amount away — the prize does.
  function scratchHeaderHtml() {
    var dealer = esc(CFG.dealerName || "");
    return '<div class="band">'
      + (dealer ? '<p class="dealer">' + dealer + '</p>' : "")
      + '<h2 class="hl sc" id="hl">' + esc(REVEALED ? revealedLine() : th().cover) + '</h2>'
      + '<button class="x" id="x" type="button" aria-label="Close">&times;</button></div>'
      + stripHtml();
  }
  // What's under the foil: the dealer's graphic if it loaded, else the amount
  // and the line under it.
  function prizeHtml(useImage) {
    var t = th(), themed = !!t.frame;
    var inner = useImage
      ? '<img src="' + esc(API + CFG.imagePath) + '" alt="' + esc(CFG.headline) + '">'
      : amountHtml("pa", themed ? ' style="color:' + t.amount + '"' : "").replace(/^<span/, "<div").replace(/<\/span>$/, "</div>")
        + (subheadText() ? '<div class="pl"' + (themed ? ' style="color:' + t.line + '"' : "") + '>' + esc(subheadText()) + '</div>' : "");
    // Themed card: the frame is a gradient border (padding-box / border-box).
    var tkStyle = themed ? ' style="border:3px solid transparent;background:linear-gradient(' + t.ticketBg + ',' + t.ticketBg
      + ') padding-box,' + t.frame + ' border-box"' : "";
    return '<div class="tkw">' + (t.bow ? BOW_SVG : "")
      + '<div class="tk" id="tk"' + tkStyle + '><div class="prize" id="prize">' + inner + '</div>'
      + (REVEALED ? "" : '<canvas id="foil" aria-hidden="true"></canvas>') + '</div></div>'
      + (REVEALED ? "" : '<div class="hint" id="hint"><span>' + (isDesktopPointer() ? "Scratch with your mouse" : "Scratch with your finger")
        + '</span><span class="meter" aria-hidden="true"><b id="meter"></b></span>'
        + '<button class="rv" id="rv" type="button">' + (isDesktopPointer() ? "Click to reveal" : "Tap to reveal") + '</button></div>');
  }

  // Header: either the dealer's uploaded graphic (image mode) or the text band
  // with the big offer amount. Image mode is used only if the image already
  // finished loading (it's preloaded during the delay) — a slow or broken image
  // falls back to the text band rather than showing an empty box.
  function headerHtml(useImage) {
    var dealer = esc(CFG.dealerName || "");
    var close = '<button class="x" id="x" type="button" aria-label="Close">&times;</button>';
    if (useImage) {
      return '<div class="art">'
        + '<img src="' + esc(API + CFG.imagePath) + '" alt="' + esc(CFG.headline) + '">'
        + '<h2 class="sr" id="hl">' + esc(CFG.headline) + '</h2>'
        + close + '</div>';
    }
    return '<div class="band">'
      + (dealer ? '<p class="dealer">' + dealer + '</p>' : "")
      + '<h2 class="hl" id="hl">'
      +   amountHtml("amt")
      +   '<span class="subhl">' + esc(subheadText()) + '</span>'
      + '</h2>'
      + close + '</div>';
  }

  // "2024 Toyota RAV4 XLE" + "Stock # T24-4471 · VIN JTMB1RFV5RD012345".
  // Falls back to just the VIN when the car isn't in the feed yet.
  function vehicleHtml() {
    var v = CFG.vehicle || {};
    var title = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
    var vin = v.vin || VIN;
    var meta = [];
    if (v.stockNumber) meta.push('<b>Stock #</b> <span class="mono">' + esc(v.stockNumber) + '</span>');
    if (vin) meta.push('<b>VIN</b> <span class="mono">' + esc(vin) + '</span>');
    if (!title && !meta.length) return "";
    return '<div class="veh" id="veh">'
      + (title ? '<div class="vt">' + esc(title) + '</div>' : "")
      + (meta.length ? '<div class="vm">' + meta.join(' &nbsp;·&nbsp; ') + '</div>' : "")
      + '</div>';
  }

  function html(useImage) {
    var dealer = esc(CFG.dealerName || "");
    return ""
      + '<div class="scrim" id="scrim"></div>'
      + '<div class="box" id="box" role="dialog" aria-modal="true" aria-labelledby="hl" tabindex="-1">'
      +   '<div class="roof" aria-hidden="true"><i></i></div>'
      +   (isScratch() ? scratchHeaderHtml() : headerHtml(useImage))
      +   (DEMO ? '<div class="demo">Demo · nothing you enter is sent</div>' : "")
      +   (isSite() ? "" : vehicleHtml())
      +   '<div class="body">'
      +     (isScratch() ? prizeHtml(useImage) : "")
      +     (isScratch() && !REVEALED ? '<button class="no" id="no0" type="button">No thanks</button>' : "")
      +     '<form id="form" novalidate' + (isScratch() && !REVEALED ? ' style="display:none"' : "") + '>'
      +       '<p class="sub">Enter your info and ' + (dealer || "our team") + ' will reach out '
      +         (isSite() ? 'about your offer.' : 'with your offer on this vehicle.') + '</p>'
      +       '<div class="err" id="err" role="alert"></div>'
      +       '<label for="n">Name</label>'
      +       '<input id="n" name="name" type="text" autocomplete="name" required maxlength="120">'
      +       '<label for="e">Email</label>'
      +       '<input id="e" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="200">'
      +       '<label for="p">Phone</label>'
      +       '<input id="p" name="phone" type="tel" autocomplete="tel" inputmode="tel" required placeholder="(555) 555-5555">'
      +       '<input class="hp" id="hp" name="company" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">'
      +       '<button class="go" id="go" type="submit">Claim my offer</button>'
      +       '<button class="no" id="no" type="button">No thanks</button>'
      +       '<p class="fine">' + esc(CFG.disclaimer || "")
      +         ' By submitting, you are asking ' + (dealer || "the dealer") + ' to contact you about this offer. '
      +         '<a href="' + esc(CFG.privacyUrl) + '" target="_blank" rel="noopener">Privacy Policy</a></p>'
      +     '</form>'
      +     '<div class="done" id="done">'
      +       '<div class="check" aria-hidden="true">&#10003;</div>'
      +       '<h3 id="doneH">You’re all set</h3>'
      +       '<p id="doneP"></p>'
      +       '<div class="code" id="codeBox"><span>Your confirmation code</span><strong id="code"></strong></div>'
      +       '<button class="go print" id="print" type="button">Print my offer</button>'
      +       '<button class="go" id="ok" type="button">Keep browsing</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  // ── Show / hide ────────────────────────────────────────────────────────────
  // reopen=true: the shopper clicked the reopen tab. That is a deliberate
  // click, so none of the "is this a good moment" checks apply, and it is NOT
  // counted as a new impression (it would inflate views and understate the
  // conversion rate on the settings screen).
  function show(trigger, reopen) {
    if (host) return;                 // already open
    if (shown && !reopen) return;

    if (!reopen) {
    // Re-check the watch signals at the moment of showing — the shopper may
    // have watched the car (or opened the watch sheet) during the delay.
    if (!TEST && VIN && ssGet("lp_watched_" + VIN)) { log("skip: watched this VIN during delay"); return; }
    if (window.__lotpulseSheetOpen) {
      if (trigger === "timed" && sheetWaits++ < 6) {
        log("watch sheet open — retrying in 10s");
        setTimeout(function () { show(trigger); }, 10000);
      }
      return;
    }
    // Timed trigger fired while the tab was in the background: wait until the
    // shopper is actually looking, so the impression is real.
    if (document.hidden) {
      var onVis = function () {
        if (!document.hidden) { document.removeEventListener("visibilitychange", onVis); show(trigger); }
      };
      document.addEventListener("visibilitychange", onVis);
      return;
    }
    lastTrigger = trigger;
    }

    removeTab();
    if (reopen) viaTab = true;
    shown = true;
    ssSet("lp_promo_shown_" + SKEY, "1");
    ssSet("lp_promo_shown_any", "1");
    lsSet("lp_promo_seen_" + SKEY, String(Date.now()));

    host = document.createElement("div");
    host.id = "lp-promo-host";
    root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var useImage = !!(IMG && IMG.complete && IMG.naturalWidth > 0);
    root.innerHTML = "<style>" + css() + "</style>" + html(useImage);
    document.body.appendChild(host);
    wire(lastTrigger);

    lastFocus = document.activeElement;
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    fitBox();
    window.addEventListener("resize", onResize);
    requestAnimationFrame(function () {
      root.getElementById("scrim").classList.add("in");
      root.getElementById("box").classList.add("in");
      // Scratch card not uncovered yet: paint the foil now that the card has
      // its size, and put focus on "Tap to reveal" (the keyboard's way in).
      if (isScratch() && !REVEALED) setupFoil();
      setTimeout(function () {
        // Phones: focus the dialog itself. Focusing a button by script makes
        // iOS Safari draw its blue keyboard-focus ring on it.
        var f = isScratch() && !REVEALED
          ? (isDesktopPointer() ? root.getElementById("rv") : root.getElementById("box"))
          : root.getElementById("n");
        if (f) f.focus();
      }, 240);
    });

    if (reopen) {
      promoEvent("lp_promo_reopened", {
        item_id: VIN, page_type: evPage(), element_type: "popup",
        event_action_result: "popup",
        offer_amount: CFG.offerCents ? Math.round(CFG.offerCents / 100) : null,
        page_location: window.location.href,
      });
      log("reopened from tab");
      return;
    }
    if (!DEMO) apiPost("/v1/promo/impression", { vin: VIN, offerId: CFG.offerId }).catch(function () {});
    beat();
    promoEvent("lp_promo_view", {
      item_id: VIN, page_type: evPage(), element_type: "popup",
      event_action_result: "popup", trigger_type: trigger,
      offer_amount: CFG.offerCents ? Math.round(CFG.offerCents / 100) : null,
      creative: (isScratch() ? "scratch_" : "") + (useImage ? "image" : "text"),
      page_location: window.location.href,
    });
    log("shown (" + trigger + ", " + (useImage ? "image" : "text") + ")");
  }

  // Phones: a card taller than the screen runs to the bottom edge instead of
  // floating clipped in the middle (see .box.tall). Checked on open, after
  // a scratch reveal and on resize / rotation.
  function fitBox() {
    if (!host) return;
    var box = root.getElementById("box");
    if (!box) return;
    var phone = false;
    try { phone = window.matchMedia("(max-width:560px)").matches; } catch (e) {}
    if (!phone) { box.classList.remove("tall"); return; }
    var was = box.classList.contains("tall");
    box.classList.remove("tall");
    var tall = box.scrollHeight > box.clientHeight + 1
      || box.getBoundingClientRect().height > window.innerHeight - 40;
    if (tall) box.classList.add("tall");
    else if (was) box.classList.remove("tall");
  }
  function onResize() { fitBox(); }

  function hide(reason) {
    if (!host) return;
    fxStop();
    var box = root.getElementById("box"), scrim = root.getElementById("scrim");
    box.classList.remove("in"); scrim.classList.remove("in");
    document.documentElement.style.overflow = savedOverflow || "";
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    var h = host; host = null;
    setTimeout(function () { if (h && h.parentNode) h.parentNode.removeChild(h); }, 250);
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
    if (reason) {
      promoEvent("lp_promo_dismissed", {
        item_id: VIN, page_type: evPage(), element_type: "popup",
        event_action_result: "close", close_method: reason, page_location: window.location.href,
      });
      // Closed without submitting: leave the reopen tab on the page edge.
      setTimeout(showTab, 300);
    }
  }

  // ── Reopen tab ─────────────────────────────────────────────────────────────
  // A small bookmark on the right edge. Its own shadow root, so the dealer
  // site's CSS can't restyle it and ours can't leak. Deliberately quiet: no
  // animation loop, no badge, and the shopper can close it.
  function tabClosed() {
    if (TEST) return false;
    if (ssGet("lp_promo_tab_closed_" + SKEY)) return true;
    return withinDays(lsGet("lp_promo_tab_closed_" + SKEY), (CFG && CFG.suppressDays) || 7);
  }
  function removeTab() {
    if (tabHost && tabHost.parentNode) tabHost.parentNode.removeChild(tabHost);
    tabHost = null;
  }
  function showTab() {
    if (!TAB_ON || tabHost || host || !CFG || submitted || offerGone) return;
    // Never after a submit (this visit or within the window), never on a car
    // the shopper is already watching, never once they've closed the tab.
    if (!TEST && (ssGet("lp_promo_submitted_s")
        || withinDays(lsGet("lp_promo_submitted"), CFG.suppressDays || 7)
        || (VIN && ssGet("lp_watched_" + VIN)))) return;
    if (tabClosed()) return;

    // A scratch offer that hasn't been uncovered keeps its secret on the tab.
    var hidden = isScratch() && !REVEALED;
    var amount = hidden ? "Scratch" : amountLabel();
    tabHost = document.createElement("div");
    tabHost.id = "lp-promo-tab-host";
    var r = tabHost.attachShadow ? tabHost.attachShadow({ mode: "open" }) : tabHost;
    r.innerHTML = "<style>"
      + ":host{all:initial}"
      + "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}"
      + ".wrap{position:fixed;right:0;top:" + TAB_TOP + ";z-index:2147483000;transform:translate(110%,-50%);"
      + "transition:transform .35s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 4px 10px rgba(0,0,0,.28))}"
      + ".wrap.in{transform:translate(0,-50%)}"
      // Compact price tag (Nov 2026, matches the VinPop logo): flat on the page
      // edge, clipped-corner end facing in with a punched hole and a small
      // reinforcement ring, the amount on it.
      + ".tab{display:flex;align-items:center;justify-content:center;border:0;cursor:pointer;"
      + "background:radial-gradient(circle at 15px 50%," + (ON_ACCENT === INK ? "rgba(20,24,29,.16)" : "rgba(255,255,255,.32)") + " 7px,transparent 7.6px)," + ACCENT + ";color:" + ON_ACCENT + ";height:50px;padding:0 15px 0 30px;min-width:95px;line-height:1;"
      + "clip-path:polygon(0 11px,1px 8px,9px 1.5px,13px 0,100% 0,100% 100%,13px 100%,9px calc(100% - 1.5px),1px calc(100% - 8px),0 calc(100% - 11px));"
      + "-webkit-mask:radial-gradient(circle at 15px 50%,transparent 4.5px,#000 5px);"
      + "mask:radial-gradient(circle at 15px 50%,transparent 4.5px,#000 5px);transition:padding .15s}"
      + ".tab:hover{padding-right:21px}"
      + ".tab:focus-visible{outline:3px solid #7AA7FF;outline-offset:-3px}"
      + ".n{font-size:21px;font-weight:800;letter-spacing:-.01em}.n.w{font-size:16px;letter-spacing:0}"
      + ".tx{position:absolute;top:-9px;left:16px;width:22px;height:22px;border-radius:50%;border:2px solid #fff;"
      + "background:#2A303C;color:#fff;font-size:14px;line-height:17px;padding:0;cursor:pointer;text-align:center}"
      + ".tx:hover{background:#000}"
      + ".tx:focus-visible{outline:3px solid #7AA7FF}"
      + "@media (max-width:560px){.tab{height:44px;min-width:84px;padding:0 12px 0 27px;"
      + "background:radial-gradient(circle at 14px 50%," + (ON_ACCENT === INK ? "rgba(20,24,29,.16)" : "rgba(255,255,255,.32)") + " 6.4px,transparent 7px)," + ACCENT + ";"
      + "clip-path:polygon(0 10px,1px 7px,8px 1.5px,12px 0,100% 0,100% 100%,12px 100%,8px calc(100% - 1.5px),1px calc(100% - 7px),0 calc(100% - 10px));"
      + "-webkit-mask:radial-gradient(circle at 14px 50%,transparent 4px,#000 4.5px);mask:radial-gradient(circle at 14px 50%,transparent 4px,#000 4.5px)}.n{font-size:18px}}"
      + "@media (prefers-reduced-motion:reduce){.wrap{transition:none}}"
      + "@media print{.wrap{display:none}}"
      + "</style>"
      + '<div class="wrap" id="w">'
      +   '<button class="tab" id="t" type="button" aria-label="' + (hidden ? "Reopen your scratch-off offer"
            : "Reopen offer: " + esc(wordingText() || amount + " off")) + '">'
      +     '<span class="n' + (hidden ? " w" : "") + '">' + esc(amount) + '</span></button>'
      +   '<button class="tx" id="tx" type="button" aria-label="Hide this offer">&times;</button>'
      + '</div>';
    document.body.appendChild(tabHost);
    requestAnimationFrame(function () { var w = r.getElementById("w"); if (w) w.classList.add("in"); });

    r.getElementById("t").addEventListener("click", function () { show(lastTrigger, true); });
    r.getElementById("tx").addEventListener("click", function () {
      ssSet("lp_promo_tab_closed_" + SKEY, "1");
      lsSet("lp_promo_tab_closed_" + SKEY, String(Date.now()));
      removeTab();
      promoEvent("lp_promo_tab_dismissed", { item_id: VIN, page_type: evPage(), page_location: window.location.href });
    });
    log("reopen tab shown");
  }

  var submitted = false;
  function onKey(e) {
    if (!host) return;
    if (e.key === "Escape") { e.preventDefault(); hide(submitted ? null : "escape"); return; }
    if (e.key === "Tab") {
      // Keep focus inside the dialog.
      var f = [].slice.call(root.querySelectorAll("button,input:not(.hp),a[href]"))
        .filter(function (el) { return el.offsetParent !== null && !el.disabled; });
      if (!f.length) return;
      var active = root.activeElement;
      var idx = f.indexOf(active);
      if (e.shiftKey && (idx <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (idx === f.length - 1 || idx === -1)) { e.preventDefault(); f[0].focus(); }
    }
  }

  // ── Printable voucher ──────────────────────────────────────────────────────
  // A self-contained one-page document — never the dealer's web page. Dealer-
  // branded like the popup: no LotPulse name on it.
  function voucherDoc(v, withPrintButton) {
    var veh = v.vehicle || {};
    var title = [veh.year, veh.make, veh.model, veh.trim].filter(Boolean).join(" ");
    var amount = "$" + Math.round((v.offerCents || 0) / 100).toLocaleString("en-US");
    // Offer wording replaces "$X OFF" on the voucher too (it's what the
    // shopper was shown). Comes from the server's saved offer, not the page.
    var wording = typeof v.wording === "string" ? v.wording.replace(/\s+/g, " ").trim() : "";
    function row(label, val) {
      return val ? '<tr><th>' + label + '</th><td>' + esc(val) + '</td></tr>' : "";
    }
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>' + esc((wording || amount + " off") + " — " + (v.dealerName || "Offer")) + '</title><style>'
      + '*{box-sizing:border-box}body{margin:0;padding:28px 18px;background:#fff;color:#14171F;'
      + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
      + '-webkit-print-color-adjust:exact;print-color-adjust:exact}'
      + '.v{max-width:620px;margin:0 auto;border:3px dashed #14171F;border-radius:14px;padding:26px 28px}'
      + '.d{font-size:13px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;color:#3A4150}'
      + '.a{font-size:68px;font-weight:800;line-height:1;margin:10px 0 2px;color:' + (ON_ACCENT === INK ? INK : ACCENT) + ';letter-spacing:-.02em}'
      + '.a small{font-size:30px;letter-spacing:.02em;margin-left:8px}'
      + '.a.wd{font-size:40px;line-height:1.12;letter-spacing:-.01em}'
      + '.c{font-size:20px;font-weight:700;margin:14px 0 2px}'
      + 'table{border-collapse:collapse;width:100%;margin:10px 0 0}'
      + 'th{text-align:left;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#5A6272;'
      + 'font-weight:600;padding:5px 14px 5px 0;white-space:nowrap;vertical-align:top;width:1%}'
      + 'td{font-size:15px;padding:5px 0}'
      + '.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}'
      + '.k{margin:20px 0 0;border:2px solid #14171F;border-radius:10px;padding:12px 16px;text-align:center}'
      + '.k span{display:block;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:#5A6272}'
      + '.k strong{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
      + 'font-size:34px;letter-spacing:.1em;margin-top:2px}'
      + '.f{font-size:12px;line-height:1.5;color:#4A5262;margin:18px 0 0}'
      + '.pb{display:block;margin:22px auto 0;max-width:620px;width:100%;border:0;border-radius:10px;padding:14px;'
      + 'font-size:17px;font-weight:700;color:' + ON_ACCENT + ';background:' + ACCENT + ';cursor:pointer}'
      + '@media print{body{padding:0}.pb{display:none}}'
      + '.demo{max-width:620px;margin:0 auto 12px;background:#FFD54A;border-radius:8px;padding:8px 12px;text-align:center;'
      + 'font-weight:800;font-size:13px;letter-spacing:.06em;text-transform:uppercase}'
      + '</style></head><body>'
      + (v.demo ? '<div class="demo">Demo voucher · not a real offer · not valid at the dealership</div>' : "")
      + '<div class="v">'
      + '<div class="d">' + esc(v.dealerName || "") + '</div>'
      + (wording ? '<div class="a wd">' + esc(wording) + '</div>' : '<div class="a">' + esc(amount) + '<small>OFF</small></div>')
      + (title ? '<div class="c">' + esc(title) + '</div>' : (v.offerLine ? '<div class="c">' + esc(v.offerLine) + '</div>' : ""))
      + '<table>'
      + (veh.stockNumber ? '<tr><th>Stock #</th><td class="mono">' + esc(veh.stockNumber) + '</td></tr>' : "")
      + (veh.vin ? '<tr><th>VIN</th><td class="mono">' + esc(veh.vin) + '</td></tr>' : "")
      + row("Issued to", v.name) + row("Issued", v.issuedOn) + row("Offer ends", v.endsOn)
      + '</table>'
      + '<div class="k"><span>Confirmation code</span><strong>' + esc(v.code) + '</strong></div>'
      + '<p class="f">' + esc(v.disclaimer || "") + ' Valid only when verified by '
      + esc(v.dealerName || "the dealership") + '. Bring this page, or give your confirmation code.</p>'
      + '</div>'
      + (withPrintButton ? '<button class="pb" id="pb" type="button">Print</button>' : "")
      + '</body></html>';
  }

  function printVoucher(v) {
    promoEvent("lp_promo_voucher_opened", {
      item_id: VIN, page_type: evPage(), element_type: "form",
      offer_amount: v.offerCents ? Math.round(v.offerCents / 100) : null,
      page_location: window.location.href,
    });
    // Phones / tablets: open the voucher in its own tab. Printing from a phone
    // is rare; a page they can keep open, save or screenshot is what's useful.
    if (!isDesktopPointer()) {
      try {
        var w = window.open("", "_blank");
        if (w && w.document) {
          w.document.open(); w.document.write(voucherDoc(v, true)); w.document.close();
          var b = w.document.getElementById("pb");
          if (b) b.onclick = function () { try { w.focus(); w.print(); } catch (e) {} };
          return;
        }
      } catch (e) { /* popup blocked: fall through to the print path */ }
    }
    // Desktop: print just the voucher from a hidden frame, so the dealer's
    // page itself never ends up on paper.
    try {
      var old = document.getElementById("lp-promo-print");
      if (old && old.parentNode) old.parentNode.removeChild(old);
      var f = document.createElement("iframe");
      f.id = "lp-promo-print";
      f.setAttribute("aria-hidden", "true");
      f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
      document.body.appendChild(f);
      var d = f.contentWindow.document;
      d.open(); d.write(voucherDoc(v, false)); d.close();
      setTimeout(function () {
        try { f.contentWindow.focus(); f.contentWindow.print(); }
        catch (e) { log("print failed:", e && e.message); }
      }, 150);
    } catch (e) { log("print failed:", e && e.message); }
  }

  // ── Scratch to reveal ──────────────────────────────────────────────────────
  // The foil is a canvas over the prize. Scratching erases it (destination-
  // out strokes); every few strokes we sample how much is see-through, and at
  // REVEAL_AT the rest fades away. The bitmap is sized for the screen's pixel
  // ratio (capped at 2) so it stays crisp without a huge canvas on phones.
  var REVEAL_AT = 0.5, BRUSH = 20;
  function setupFoil() {
    var c = root.getElementById("foil"), tk = root.getElementById("tk");
    if (!c || !tk || !c.getContext) { reveal("tap"); return; }   // no canvas: just show it
    var ctx = c.getContext("2d"), meter = root.getElementById("meter");
    var dpr = Math.min(window.devicePixelRatio || 1, 2), w = 0, h = 0, last = null, strokes = 0, down = false;

    function paint() {
      w = tk.clientWidth; h = tk.clientHeight;
      if (!w || !h) return false;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      var t = th(), SF = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
      var g = ctx.createLinearGradient(0, 0, w, h), stops = [0, 0.32, 0.52, 0.78, 1];
      for (var k = 0; k < 5; k++) g.addColorStop(stops[k], t.foil[k]);
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // Fine grain, so it reads as foil rather than a flat box.
      for (var i = 0, n = Math.round(w * h / 26); i < n; i++) {
        ctx.fillStyle = Math.random() < 0.5 ? (t.dark ? "rgba(255,255,255,.10)" : "rgba(255,255,255,.35)") : (t.dark ? "rgba(0,0,0,.25)" : "rgba(70,80,100,.10)");
        ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
      }
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      drawPattern(ctx, t, w, h, SF);
      if (t !== THEMES.classic) {
        // A soft plate behind the words so they read over the pattern.
        ctx.font = "800 21px " + SF;
        var tw = Math.max(ctx.measureText(t.foilTitle).width, 150) + 36;
        ctx.fillStyle = t.dark ? "rgba(0,0,0,.28)" : "rgba(255,255,255,.28)";
        roundRectPath(ctx, w / 2 - tw / 2, h / 2 - 31, tw, 60, 12); ctx.fill();
      }
      ctx.fillStyle = t.titleColor;
      ctx.font = (t === THEMES.classic ? "800 22px " : "800 21px ") + SF;
      ctx.fillText(t.foilTitle, w / 2, h / 2 - 8);
      ctx.font = "500 13px " + SF;
      ctx.fillStyle = t.subColor;
      ctx.fillText(t.foilSub, w / 2, h / 2 + 16);
      // The brush erases by its alpha, so it must be fully opaque (the
      // pattern leaves a faint stroke color behind).
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "#000"; ctx.fillStyle = "#000"; ctx.globalAlpha = 1;
      ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = BRUSH * 2;
      return true;
    }
    if (!paint()) { reveal("tap"); return; }

    function pt(e) { var r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * (w / (r.width || w)), y: (e.clientY - r.top) * (h / (r.height || h)) }; }
    function scratchTo(p) {
      ctx.beginPath();
      if (last) { ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); }
      else { ctx.arc(p.x, p.y, BRUSH, 0, Math.PI * 2); ctx.fill(); }
      last = p;
      if (++strokes % 6 === 0) check();
    }
    // Share of the foil that's see-through, sampling every 8th pixel.
    function check() {
      if (REVEALED) return;
      var clear = 0, total = 0;
      try {
        var d = ctx.getImageData(0, 0, c.width, c.height).data;
        for (var i = 3; i < d.length; i += 32) { total++; if (d[i] < 40) clear++; }
      } catch (e) { return; }
      var pct = total ? clear / total : 0;
      if (meter) meter.style.width = Math.min(100, Math.round(pct / REVEAL_AT * 100)) + "%";
      if (pct >= REVEAL_AT) reveal("scratch");
    }
    c.addEventListener("pointerdown", function (e) {
      if (REVEALED) return;
      down = true; last = null;
      try { c.setPointerCapture(e.pointerId); } catch (_) {}
      scratchTo(pt(e)); e.preventDefault();
    });
    c.addEventListener("pointermove", function (e) {
      if (!down || REVEALED) return;
      var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (!evs || !evs.length) evs = [e];
      for (var i = 0; i < evs.length; i++) scratchTo(pt(evs[i]));
      e.preventDefault();
    });
    function up() { if (down) { down = false; last = null; check(); } }
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    // Older iOS without pointer events: stop the page scrolling under a finger.
    c.addEventListener("touchmove", function (e) { if (!REVEALED) e.preventDefault(); }, { passive: false });
  }

  // ── Theme shapes: foil patterns and reveal particles ──
  function drawFlake(c, x, y, r) {
    c.save(); c.translate(x, y); c.lineCap = "round";
    for (var i = 0; i < 6; i++) {
      c.rotate(Math.PI / 3);
      c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -r);
      c.moveTo(0, -r * 0.55); c.lineTo(-r * 0.28, -r * 0.82);
      c.moveTo(0, -r * 0.55); c.lineTo(r * 0.28, -r * 0.82); c.stroke();
    }
    c.restore();
  }
  function starPath(c, x, y, r, inner, pts) {
    inner = inner || 0.45; pts = pts || 5;
    c.beginPath();
    for (var i = 0; i < pts * 2; i++) {
      var rr = i % 2 ? r * inner : r, a = -Math.PI / 2 + i * Math.PI / pts;
      if (i) c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    c.closePath();
  }
  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function heartPath(c, x, y, r) {
    c.beginPath(); c.moveTo(x, y + r * 0.9);
    c.bezierCurveTo(x - r * 1.7, y - r * 0.1, x - r * 0.7, y - r * 1.35, x, y - r * 0.45);
    c.bezierCurveTo(x + r * 0.7, y - r * 1.35, x + r * 1.7, y - r * 0.1, x, y + r * 0.9);
    c.closePath();
  }
  function cloverShape(c, x, y, r) {
    c.beginPath();
    [[0, -0.48], [-0.46, 0.2], [0.46, 0.2]].forEach(function (p) { c.moveTo(x + p[0] * r + r * 0.42, y + p[1] * r); c.arc(x + p[0] * r, y + p[1] * r, r * 0.42, 0, Math.PI * 2); });
    c.fill();
    c.beginPath(); c.moveTo(x, y + r * 0.2); c.quadraticCurveTo(x + r * 0.2, y + r * 0.7, x + r * 0.35, y + r); c.lineWidth = Math.max(1, r * 0.16); c.stroke();
  }
  function eggPath(c, x, y, r) { c.beginPath(); c.ellipse(x, y, r * 0.7, r, 0, 0, Math.PI * 2); }
  function flowerShape(c, x, y, r) {
    c.beginPath();
    for (var i = 0; i < 5; i++) { var a = -Math.PI / 2 + i * Math.PI * 2 / 5; c.moveTo(x + Math.cos(a) * r * 0.5 + r * 0.4, y + Math.sin(a) * r * 0.5); c.arc(x + Math.cos(a) * r * 0.5, y + Math.sin(a) * r * 0.5, r * 0.4, 0, Math.PI * 2); }
    c.fill();
  }
  function leafShape(c, x, y, r, rot) {
    c.save(); c.translate(x, y); c.rotate(rot || 0);
    c.beginPath(); c.moveTo(0, -r); c.quadraticCurveTo(r * 0.8, -r * 0.1, 0, r); c.quadraticCurveTo(-r * 0.8, -r * 0.1, 0, -r); c.fill();
    c.restore();
  }
  function sunShape(c, x, y, r) {
    c.beginPath(); c.arc(x, y, r * 0.42, 0, Math.PI * 2); c.fill();
    c.lineWidth = Math.max(1, r * 0.14); c.lineCap = "round"; c.beginPath();
    for (var i = 0; i < 8; i++) { var a = i * Math.PI / 4; c.moveTo(x + Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62); c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
    c.stroke();
  }
  function pumpkinShape(c, x, y, r) {
    c.beginPath(); c.ellipse(x - r * 0.38, y, r * 0.45, r * 0.7, 0, 0, Math.PI * 2); c.ellipse(x + r * 0.38, y, r * 0.45, r * 0.7, 0, 0, Math.PI * 2); c.ellipse(x, y, r * 0.5, r * 0.75, 0, 0, Math.PI * 2); c.fill();
    c.fillRect(x - r * 0.08, y - r * 1.05, r * 0.18, r * 0.35);
  }
  function batShape(c, x, y, r) {
    c.beginPath(); c.moveTo(x, y - r * 0.2);
    c.quadraticCurveTo(x - r * 0.5, y - r * 0.8, x - r * 1.3, y - r * 0.4);
    c.quadraticCurveTo(x - r * 0.9, y - r * 0.1, x - r, y + r * 0.3);
    c.quadraticCurveTo(x - r * 0.6, y + r * 0.05, x - r * 0.45, y + r * 0.35);
    c.quadraticCurveTo(x - r * 0.2, y + r * 0.1, x, y + r * 0.45);
    c.quadraticCurveTo(x + r * 0.2, y + r * 0.1, x + r * 0.45, y + r * 0.35);
    c.quadraticCurveTo(x + r * 0.6, y + r * 0.05, x + r, y + r * 0.3);
    c.quadraticCurveTo(x + r * 0.9, y - r * 0.1, x + r * 1.3, y - r * 0.4);
    c.quadraticCurveTo(x + r * 0.5, y - r * 0.8, x, y - r * 0.2);
    c.fill();
  }
  // Foil pattern for a theme: a staggered grid of small shapes (or plaid).
  function drawPattern(ctx, t, w, h, SF) {
    var p = t.pat || { k: "dollar", a: "rgba(20,33,61,.09)" };
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    if (p.k === "plaid") {
      for (var px = 0; px < w; px += 26) { ctx.fillStyle = p.a; ctx.fillRect(px, 0, 8, h); ctx.fillStyle = p.b; ctx.fillRect(px + 14, 0, 3, h); }
      for (var py = 0; py < h; py += 26) { ctx.fillStyle = p.a; ctx.fillRect(0, py, w, 8); ctx.fillStyle = p.b; ctx.fillRect(0, py + 14, w, 3); }
      return;
    }
    for (var y = 14, row = 0; y < h + 10; y += 30, row++) {
      for (var x = (row % 2 ? 19 : 2), col = 0; x < w + 10; x += 34, col++) {
        var alt = (row + col) % 2, colr = alt && p.b ? p.b : p.a;
        ctx.fillStyle = colr; ctx.strokeStyle = colr;
        if (p.k === "dollar") { ctx.font = "700 17px " + SF; ctx.fillText("$", x, y); }
        else if (p.k === "percent") { ctx.font = "800 16px " + SF; ctx.fillText("%", x, y); }
        else if (p.k === "snow") { ctx.lineWidth = 1.3; drawFlake(ctx, x, y, alt ? 6 : 4.5); }
        else if (p.k === "starspark") { if (alt) { ctx.fillStyle = p.a; starPath(ctx, x, y, 5.5); } else { ctx.fillStyle = p.b; starPath(ctx, x, y, 5, 0.22, 4); } ctx.fill(); }
        else if (p.k === "star") { starPath(ctx, x, y, 5.5); ctx.fill(); }
        else if (p.k === "heart") { heartPath(ctx, x, y, alt ? 5 : 6.5); ctx.fill(); }
        else if (p.k === "clover") { cloverShape(ctx, x, y, alt ? 6 : 7.5); }
        else if (p.k === "egg") {
          ctx.fillStyle = [p.a, p.b, p.c, p.d][(row * 3 + col) % 4]; eggPath(ctx, x, y, 6.5); ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x - 4.2, y); ctx.lineTo(x + 4.2, y); ctx.stroke();
        }
        else if (p.k === "flower") { flowerShape(ctx, x, y, alt ? 6 : 7.5); }
        else if (p.k === "sun") { sunShape(ctx, x, y, alt ? 6 : 7.5); }
        else if (p.k === "leaf") { leafShape(ctx, x, y, alt ? 6 : 7.5, (row * 7 + col * 3) % 6 - 3); }
        else if (p.k === "pumpkin") { if (alt) { ctx.fillStyle = p.a; pumpkinShape(ctx, x, y, 6.5); } else { ctx.fillStyle = p.b; starPath(ctx, x, y, 3.5, 0.3, 4); ctx.fill(); } }
      }
    }
  }

  // Themed reveal effects on a canvas over the whole page (inside our shadow
  // root): a burst of shapes out of the card, shapes drifting down, or
  // fireworks. It stops itself, and on close. Reduced motion: none.
  var FX = { cv: null, parts: [], raf: 0, timers: [] };
  function fxStop() {
    FX.parts = []; FX.timers.forEach(clearTimeout); FX.timers = [];
    if (FX.raf) cancelAnimationFrame(FX.raf); FX.raf = 0;
    if (FX.cv && FX.cv.parentNode) FX.cv.parentNode.removeChild(FX.cv);
    FX.cv = null;
  }
  function drawParticle(c, p) {
    var s = p.s;
    c.fillStyle = p.col; c.strokeStyle = p.col;
    switch (p.shape) {
      case "rect": c.fillRect(-s / 2, -s * 0.8, s, s * 1.6); break;
      case "star": starPath(c, 0, 0, s); c.fill(); if (p.col === "#FFFFFF") { c.strokeStyle = "#1D3A8A"; c.lineWidth = 1; c.stroke(); } break;
      case "heart": heartPath(c, 0, 0, s); c.fill(); if (p.col === "#FFFFFF") { c.strokeStyle = "#D61F4D"; c.lineWidth = 1; c.stroke(); } break;
      case "clover": c.lineWidth = 1.5; cloverShape(c, 0, 0, s * 1.2); break;
      case "coin": c.beginPath(); c.arc(0, 0, s * 0.8, 0, Math.PI * 2); c.fill(); c.strokeStyle = "#A67C24"; c.lineWidth = 1.4; c.stroke(); break;
      case "egg": eggPath(c, 0, 0, s); c.fill(); c.strokeStyle = "rgba(255,255,255,.85)"; c.lineWidth = 1.2; c.beginPath(); c.moveTo(-s * 0.62, 0); c.lineTo(s * 0.62, 0); c.stroke(); break;
      case "petal": c.beginPath(); c.ellipse(0, 0, s * 0.45, s * 0.9, 0, 0, Math.PI * 2); c.fill(); break;
      case "leaf": leafShape(c, 0, 0, s * 1.1, 0); break;
      case "bill": c.fillRect(-s * 1.1, -s * 0.55, s * 2.2, s * 1.1); c.strokeStyle = "rgba(255,255,255,.7)"; c.lineWidth = 1; c.strokeRect(-s * 0.8, -s * 0.32, s * 1.6, s * 0.64); break;
      case "bat": batShape(c, 0, 0, s); break;
      case "flake": c.shadowColor = "rgba(40,60,90,.55)"; c.shadowBlur = 2; c.strokeStyle = "#FFFFFF"; c.lineWidth = 1.4; drawFlake(c, 0, 0, s + 1.5); break;
      case "dot": c.shadowColor = "rgba(40,60,90,.5)"; c.shadowBlur = 2; c.fillStyle = "#FFFFFF"; c.beginPath(); c.arc(0, 0, s * 0.6, 0, Math.PI * 2); c.fill(); break;
    }
  }
  function themedEffect() {
    var t = th(), e = t.fx || {};
    try { if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return; } catch (err) {}
    fxStop();
    var cv = document.createElement("canvas"); cv.className = "fx"; cv.setAttribute("aria-hidden", "true");
    root.appendChild(cv); FX.cv = cv;
    var W = window.innerWidth, H = window.innerHeight, d = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * d); cv.height = Math.round(H * d);
    var c = cv.getContext("2d"); c.setTransform(d, 0, 0, d, 0, 0);
    var tk = root.getElementById("tk"), ctr = { x: W / 2, y: H / 2 };
    if (tk) { var r = tk.getBoundingClientRect(); ctr = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
    var cols = e.c || ["#FFFFFF"], i;
    if (e.t === "burst") {
      var n = e.n || (e.s === "rect" ? 46 : 34);
      for (i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 5, shape = e.s;
        if (shape === "clovercoin") shape = i % 3 === 0 ? "coin" : "clover";
        FX.parts.push({ x: ctr.x, y: ctr.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3, g: 0.16, life: 0, max: 70 + Math.random() * 30,
          s: shape === "rect" ? 4 + Math.random() * 3 : 5 + Math.random() * 4, col: shape === "coin" ? "#E7C25A" : cols[i % cols.length],
          shape: shape, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3 });
      }
    } else if (e.t === "fall") {
      var snow = e.s === "flake", count = snow ? 90 : 46;
      for (i = 0; i < count; i++) {
        FX.parts.push({ x: Math.random() * W, y: -10 - Math.random() * H * 0.9, vy: 0.9 + Math.random() * 1.6, life: 0, max: 600, fall: true,
          s: snow ? 2.5 + Math.random() * 4 : 5 + Math.random() * 4, col: cols[i % cols.length],
          shape: snow ? (Math.random() < 0.55 ? "flake" : "dot") : e.s, rot: Math.random() * 6,
          vr: (Math.random() - 0.5) * (snow ? 0.04 : 0.08), sway: Math.random() * 6, amp: 0.4 + Math.random() * 0.9 });
      }
    } else if (e.t === "fireworks") {
      [[0.3, 0.2], [0.72, 0.14], [0.5, 0.32], [0.22, 0.44], [0.78, 0.4]].forEach(function (p, k) {
        FX.timers.push(setTimeout(function () {
          var col = cols[k % cols.length], bx = W * p[0], by = H * p[1];
          for (var j = 0; j < 46; j++) {
            var a2 = j / 46 * Math.PI * 2 + Math.random() * 0.1, sp2 = 1.6 + Math.random() * 2.8;
            FX.parts.push({ x: bx, y: by, px: bx, py: by, vx: Math.cos(a2) * sp2, vy: Math.sin(a2) * sp2, g: 0.035, drag: 0.975,
              life: 0, max: 60 + Math.random() * 25, s: 2.2, col: Math.random() < 0.25 ? "#FFFFFF" : col, shape: "spark" });
          }
          if (!FX.raf) FX.raf = requestAnimationFrame(step);
        }, k * 320));
      });
    }
    function step() {
      if (!FX.cv) return;
      c.clearRect(0, 0, W, H);
      FX.parts = FX.parts.filter(function (p) { return p.life < p.max && p.y < H + 20; });
      FX.parts.forEach(function (p) {
        p.life++;
        if (p.fall) { p.sway += 0.03; p.x += Math.sin(p.sway) * p.amp; p.y += p.vy; }
        else { p.px = p.x; p.py = p.y; if (p.drag) { p.vx *= p.drag; p.vy *= p.drag; } p.vy += p.g; p.x += p.vx; p.y += p.vy; }
        p.rot += p.vr || 0;
        c.globalAlpha = p.fall ? 1 : Math.max(0, 1 - p.life / p.max);
        c.save();
        if (p.shape === "spark") {
          c.strokeStyle = p.col; c.lineWidth = p.s; c.lineCap = "round";
          c.beginPath(); c.moveTo(p.px, p.py); c.lineTo(p.x, p.y); c.stroke();
        } else { c.translate(p.x, p.y); c.rotate(p.rot || 0); drawParticle(c, p); }
        c.restore();
      });
      c.globalAlpha = 1;
      if (FX.parts.length) FX.raf = requestAnimationFrame(step);
      else { FX.raf = 0; c.clearRect(0, 0, W, H); }   // a later firework burst restarts it
    }
    FX.raf = requestAnimationFrame(step);
    // Clean up the canvas once the effect has run its course.
    FX.timers.push(setTimeout(fxStop, e.t === "fall" ? 11000 : 6000));
  }

  function confetti(host) {
    var colors = [ACCENT, "#FFB020", "#0D9488", "#14213D", "#8EA6FF"];
    for (var i = 0; i < 22; i++) {
      var b = document.createElement("i");
      b.className = "bit";
      var a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 80;
      b.style.background = colors[i % colors.length];
      b.style.setProperty("--dx", Math.round(Math.cos(a) * d) + "px");
      b.style.setProperty("--dy", Math.round(Math.sin(a) * d * 0.7) + "px");
      b.style.setProperty("--r", Math.round(Math.random() * 540 - 270) + "deg");
      host.appendChild(b);
    }
    setTimeout(function () {
      var bits = host.querySelectorAll(".bit");
      for (var j = 0; j < bits.length; j++) if (bits[j].parentNode) bits[j].parentNode.removeChild(bits[j]);
    }, 1200);
  }

  // Uncover the offer: fade the foil, show the form. method: scratch | tap.
  function reveal(method) {
    if (REVEALED || !host) return;
    REVEALED = true;
    ssSet("lp_promo_rev_" + SKEY, "1");
    var c = root.getElementById("foil"), tk = root.getElementById("tk");
    var meter = root.getElementById("meter");
    if (meter) meter.style.width = "100%";
    if (c) c.classList.add("gone");
    if (th() === THEMES.classic) { if (tk) confetti(tk); }
    else themedEffect();
    var hl = root.getElementById("hl");
    if (hl) hl.textContent = revealedLine();
    setTimeout(function () {
      if (!host) return;
      var hint = root.getElementById("hint"), no0 = root.getElementById("no0"), form = root.getElementById("form");
      if (hint) hint.style.display = "none";
      if (no0) no0.style.display = "none";
      if (form) { form.style.display = "block"; form.className = "form-in"; }
      fitBox();
      // Desktop: straight into the form. Phones: don't pop the keyboard over
      // the offer they just uncovered.
      var n = root.getElementById("n");
      if (n && isDesktopPointer()) n.focus();
      else { var bx = root.getElementById("box"); if (bx) bx.focus({ preventScroll: true }); }
    }, method === "tap" ? 200 : 380);
    promoEvent("lp_promo_revealed", {
      item_id: VIN, page_type: evPage(), element_type: "popup",
      event_action_result: "reveal", reveal_method: method, scratch_theme: themeId(),
      offer_amount: CFG.offerCents ? Math.round(CFG.offerCents / 100) : null,
      page_location: window.location.href,
    });
    log("revealed (" + method + ")");
  }

  function wire(trigger) {
    var form = root.getElementById("form"), err = root.getElementById("err"), go = root.getElementById("go");
    var name = root.getElementById("n"), email = root.getElementById("e"), phone = root.getElementById("p");

    root.getElementById("x").addEventListener("click", function () { hide(submitted ? null : "close_button"); });
    root.getElementById("no").addEventListener("click", function () { hide("no_thanks"); });
    root.getElementById("scrim").addEventListener("click", function () { hide(submitted ? null : "backdrop"); });
    root.getElementById("ok").addEventListener("click", function () { hide(null); });
    var no0 = root.getElementById("no0"), rv = root.getElementById("rv");
    if (no0) no0.addEventListener("click", function () { hide("no_thanks"); });
    if (rv) rv.addEventListener("click", function () { reveal("tap"); });
    document.addEventListener("keydown", onKey, true);

    phone.addEventListener("input", function (e) {
      var d = e.target.value.replace(/\D/g, "");
      if (d.length === 11 && d[0] === "1") d = d.slice(1);
      d = d.slice(0, 10);
      var out = d;
      if (d.length > 6) out = "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
      else if (d.length > 3) out = "(" + d.slice(0, 3) + ") " + d.slice(3);
      e.target.value = out;
    });

    function fail(msg, field) {
      err.textContent = msg; err.style.display = "block";
      if (field) field.focus();
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      err.style.display = "none";
      var nm = name.value.trim(), em = email.value.trim(), ph = phone.value.replace(/\D/g, "");
      if (nm.length < 2) return fail("Please enter your name.", name);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) return fail("Please enter a valid email.", email);
      if (ph.length !== 10) return fail("Please enter a valid 10-digit phone number.", phone);

      go.disabled = true; go.textContent = "Sending…";
      apiPost("/v1/promo/lead", {
        // offerId = the offer this shopper was SHOWN; the server records the
        // lead against it (and re-checks it's still live for this car).
        vin: VIN, offerId: CFG.offerId, name: nm, email: em, phone: ph, trigger: trigger,
        page: PAGEKIND,
        demo: DEMO || undefined,   // demo: validated, voucher returned, NOT saved or sent
        pageUrl: window.location.href, company: root.getElementById("hp").value,
        // Anonymous visitor id: links this lead to the "Live now" viewer row.
        vid: STORAGE_OK && ENG ? ENG.vid : null,
        // Engagement grade inputs (the server prefers its own live / trail
        // counters and only falls back to these, clamped). Counts and VINs
        // only — never pages, titles, referrers or timestamps.
        visit: STORAGE_OK && ENG && ENG.visit ? ENG.visit.start : null,
        eng: STORAGE_OK && ENG ? engSnapshot() : null,
        vins: STORAGE_OK && ENG ? recentVins(10) : [],
      }).then(function (res) {
        if (!res.ok) {
          go.disabled = false; go.textContent = "Claim my offer";
          if (res.status === 410) {
            // Offer was paused/ended while the popup was open. Say so plainly
            // and let them close it; don't pretend it worked.
            go.style.display = "none";
            offerGone = true;   // nothing to reopen — don't leave a tab behind
            return fail((res.json && res.json.error) || "Sorry, this offer is no longer available.");
          }
          return fail((res.json && res.json.error) || "Something went wrong. Please try again.");
        }
        submitted = true;
        if (!DEMO) {   // a demo submit must not hide the popup from this browser later
          lsSet("lp_promo_submitted", String(Date.now()));
          ssSet("lp_promo_submitted_s", "1");
        }
        removeTab();
        beat();
        form.style.display = "none";
        var first = nm.split(/\s+/)[0];
        root.getElementById("doneH").textContent = "Thanks, " + first + "!";
        root.getElementById("doneP").textContent = DEMO
          ? "Demo only: nothing was saved or sent to " + (CFG.dealerName || "the dealer") + ". A real shopper sees: “" + (CFG.dealerName || "The dealer") + " has your request and will reach out about your offer.”"
          : (CFG.dealerName || "The dealer") + " has your request and will reach out about your offer.";
        root.getElementById("done").style.display = "block";
        fitBox();   // the thank-you is short: float it again
        // Voucher: only the server's submit response carries it, so there is
        // nothing to print until the shopper has actually given their details.
        var voucher = res.json && res.json.voucher;
        var okBtn = root.getElementById("ok");
        if (voucher && voucher.code) {
          root.getElementById("code").textContent = voucher.code;
          root.getElementById("codeBox").style.display = "block";
          if (PRINT_ON) {
            var pb = root.getElementById("print");
            pb.textContent = isDesktopPointer() ? "Print my offer" : "View my offer voucher";
            pb.style.display = "block";
            pb.addEventListener("click", function () { printVoucher(voucher); });
            okBtn.className = "no";          // demote "Keep browsing" to a link
            pb.focus();
          } else { okBtn.focus(); }
        } else { okBtn.focus(); }
        promoEvent("lp_promo_submitted", {
          item_id: VIN, page_type: evPage(), element_type: "form", form_type: "offer",
          event_action_result: "complete", trigger_type: trigger,
          reopened_from_tab: viaTab ? "yes" : "no",
          offer_amount: CFG.offerCents ? Math.round(CFG.offerCents / 100) : null,
          page_location: window.location.href,
        });
      }).catch(function () {
        go.disabled = false; go.textContent = "Claim my offer";
        fail("Network error. Please try again.");
      });
    });
  }

  // ── Triggers ───────────────────────────────────────────────────────────────
  function armTriggers() {
    var delay = TEST ? 3 : Math.max(5, parseInt(CFG.delaySeconds, 10) || 35);
    // Time spent working out what kind of page this is (up to ~6s on a page
    // with no VIN, waiting for a late one) counts toward the delay, so a
    // homepage shopper isn't kept waiting longer than a VDP shopper.
    var wait = TEST ? delay * 1000 : Math.max(1000, delay * 1000 - DETECT_MS);
    setTimeout(function () { show("timed"); }, wait);

    // Exit intent: desktop only. Armed after a short dwell so a shopper who
    // lands and immediately reaches for another tab isn't ambushed.
    if (isDesktopPointer()) {
      setTimeout(function () {
        document.addEventListener("mouseout", function (e) {
          if (shown) return;
          if (!e.relatedTarget && e.clientY <= 0) show("exit_intent");
        });
      }, TEST ? 500 : 5000);
    }
    log("armed: timed " + delay + "s" + (isDesktopPointer() ? " + exit-intent" : " (mobile: timed only)"));
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  // Rooftop-level "nothing for non-vehicle pages" answers. Remembered for 10
  // minutes per tab so browsing a site with no site-wide offer doesn't call
  // the API on every page.
  var NO_SITE_REASONS = ["disabled", "paused", "demo_only", "no_live_offer", "no_site_offer"];
  var NO_SITE_KEY = "lp_promo_nosite";

  // Any page that isn't a single vehicle page: only a site-wide offer can
  // show here, and the server decides which (by page kind and path).
  function startSite(kind) {
    VIN = null; PAGEKIND = kind;
    if (!TEST && ssGet("lp_promo_submitted_s")) { log("suppressed: submitted this visit"); return; }
    var nos = parseInt(ssGet(NO_SITE_KEY) || "", 10);
    if (!TEST && !DEMO && Number.isFinite(nos) && Date.now() - nos < 10 * 60000) {
      log("no site-wide offer (remembered for this tab)"); return;
    }
    fetchConfig("/v1/promo/config?page=" + kind + "&path=" + encodeURIComponent(window.location.pathname || "/"));
  }

  function start(found) {
    VIN = found.vin; PAGEKIND = "vehicles";
    // Session-level checks first: they need no config, and skipping the API
    // call on repeat pageviews keeps load off the server.
    var pre = clientSuppressed(VIN, 0);
    // Normally a session-suppressed page stops here without calling the API.
    // The exception: the shopper already saw (and closed) the popup on this
    // car. Then we still fetch the offer so the reopen TAB can come back —
    // otherwise a reload would make the offer unreachable.
    // Whether the tab can be on is only fully known from the config response
    // (the dashboard can override GTM either way), so use what this tab's
    // last config said ("1"/"0"; "" = not set in the dashboard → GTM decides).
    var srvTab = ssGet("lp_promo_tab_srv");
    var tabMaybeOn = srvTab === "1" ? true : srvTab === "0" ? false : GTM_TAB_ON !== false;
    var tabOnly = pre === "shown_this_session" && tabMaybeOn
      && !ssGet("lp_promo_submitted_s") && !ssGet("lp_promo_tab_closed_" + VIN);
    if (pre && !tabOnly) { log("suppressed: " + pre); return; }

    fetchConfig("/v1/promo/config?vin=" + encodeURIComponent(VIN) + "&page=vehicles&path="
      + encodeURIComponent(window.location.pathname || "/"));
  }

  function fetchConfig(url) {
    apiGet(url + (DEMO ? "&demo=1" : "")).then(function (c) {
      if (!c || !c.eligible) {
        log("not eligible" + (c && c.reason ? ": " + c.reason : "")
          + (c && c.reason === "demo_only" ? " (Demo mode is on: add ?vinpop=demo to the URL)" : ""));
        if (!VIN && !DEMO && c && NO_SITE_REASONS.indexOf(c.reason) !== -1) ssSet(NO_SITE_KEY, String(Date.now()));
        return;
      }
      CFG = c;
      // Memory key: the car for its own offer, the offer for a site-wide one.
      SKEY = c.placement === "site" ? "o" + c.offerId : VIN;
      // Demo / test mode: every page load starts with a fresh foil, so a
      // refresh shows the scratch card again (handy when showing a dealer).
      // Within one page, reopening from the tab still remembers the reveal.
      REVEALED = c.reveal !== "scratch" || (!TEST && !!ssGet("lp_promo_rev_" + SKEY));
      // Dashboard tab / color settings win over GTM. Applied before anything
      // is drawn, so the tab never shows in the wrong color or spot.
      applyLook(c.tab);
      var te = c.tab && typeof c.tab.enabled === "boolean" ? (c.tab.enabled ? "1" : "0") : "";
      ssSet("lp_promo_tab_srv", te);
      // Preload the offer graphic now so it's cached by the time the popup
      // opens (35s later by default). show() checks it actually loaded.
      if (c.imagePath) { IMG = new Image(); IMG.src = API + c.imagePath; }
      RULES = c.engagement || RULES;
      var why = clientSuppressed(SKEY, c.suppressDays);
      if (why) {
        log("suppressed: " + why);
        // Popup held back because they've already seen it on this car: show
        // just the tab (showTab applies its own submit / watch / closed checks).
        if (why === "shown_this_session" || why === "seen_recently") { shown = true; showTab(); }
        return;
      }
      // Who sees VinPop: with "engaged", wait until the shopper qualifies
      // (re-checked every 5s by the clock). Test mode skips the rules.
      if (!TEST && !qualifies(tally(), c.engagement)) {
        waitingForQualify = true;
        log("waiting: shopper hasn't met the rooftop's engagement rules yet");
        return;
      }
      armTriggers();
    }).catch(function (e) { log("config fetch failed (no popup):", e && e.message); });
  }

  var DETECT_MS = 0;
  function boot() {
    engUpdate();        // count the visit (every page, vehicle page or not)
    startClock();
    var tries = 0, bootAt = Date.now();
    (function attempt() {
      DETECT_MS = Date.now() - bootAt;
      var found = findVdpVin();
      if (found && found.srp) { classify("other"); startSite("listings"); return; }
      if (found && found.vin) { classify("vdp", found.vin); start(found); return; }
      // VDPs on some platforms render the VIN late; retry for ~6s like the
      // watch widget's anchor wait, then treat it as a non-vehicle page.
      if (tries++ < 12) setTimeout(attempt, 500);
      else { classify("other"); startSite(homeOrOther()); }
    })();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(boot, 600); });
  } else {
    setTimeout(boot, 600);
  }
})();
