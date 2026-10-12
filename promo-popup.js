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
  var ACCENT = /^#[0-9a-fA-F]{3,8}$/.test(CONFIG.accentColor || "") ? CONFIG.accentColor : "#1F2A44";
  var TEST = /[?&]lp_promo_test=1\b/.test(window.location.search);
  var TAB_ON = CONFIG.reopenTab !== false;
  var PRINT_ON = CONFIG.printButton !== false;
  var TAB_TOP = /^\d{1,4}(%|px|vh)$/.test(CONFIG.reopenTabTop || "") ? CONFIG.reopenTabTop : "50%";

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
  var lastFocus = null, savedOverflow = null, sheetWaits = 0;
  var tabHost = null, lastTrigger = "timed", offerGone = false, viaTab = false;

  function isDesktopPointer() {
    try { return window.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch (e) { return false; }
  }

  function clientSuppressed(vin, days) {
    if (TEST) return false;
    if (ssGet("lp_promo_shown_" + vin)) return "shown_this_session";
    if (ssGet("lp_watched_" + vin)) return "already_watched";
    if (days && withinDays(lsGet("lp_promo_seen_" + vin), days)) return "seen_recently";
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
      + "max-height:calc(100vh - 32px);overflow:auto;background:#fff;color:#14171F;border-radius:16px;"
      + "box-shadow:0 24px 60px rgba(0,0,0,.28);transform:translate(-50%,-46%);opacity:0;"
      + "transition:transform .22s ease,opacity .22s ease}"
      + ".box.in{transform:translate(-50%,-50%);opacity:1}"
      + "@media (max-width:560px){.box{left:0;right:0;top:auto;bottom:0;width:100%;max-height:92vh;"
      + "border-radius:18px 18px 0 0;transform:translateY(24px)}.box.in{transform:translateY(0)}}"
      + ".band{background:" + ACCENT + ";color:#fff;padding:22px 24px 20px;border-radius:16px 16px 0 0;position:relative}"
      + "@media (max-width:560px){.band{border-radius:18px 18px 0 0}}"
      + ".dealer{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;margin:0 32px 8px 0}"
      // The offer amount is the whole pitch, so it's the biggest thing on the
      // card: "$750" huge, "OFF" beside it, the vehicle / tagline underneath.
      + ".hl{margin:0 32px 0 0;font-weight:800;line-height:1}"
      + ".amt{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}"
      + ".amt .n{font-size:68px;letter-spacing:-.02em;line-height:.95}"
      + ".amt .off{font-size:34px;letter-spacing:.02em}"
      + ".subhl{display:block;font-size:19px;font-weight:600;line-height:1.3;margin-top:10px;opacity:.95}"
      + "@media (max-width:560px){.amt .n{font-size:58px}.amt .off{font-size:28px}.subhl{font-size:17px}}"
      // Image mode: the dealer's own graphic replaces the colored band. Shown
      // uncropped (contain), since offer art usually has text near the edges.
      + ".art{position:relative;background:" + ACCENT + ";border-radius:16px 16px 0 0;overflow:hidden;line-height:0}"
      + "@media (max-width:560px){.art{border-radius:18px 18px 0 0}}"
      + ".art img{display:block;width:100%;height:auto;max-height:46vh;object-fit:contain}"
      + ".art .x{background:rgba(0,0,0,.45)}.art .x:hover{background:rgba(0,0,0,.65)}"
      + ".sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}"
      + ".x{position:absolute;top:12px;right:12px;width:36px;height:36px;border:0;border-radius:50%;"
      + "background:rgba(255,255,255,.16);color:#fff;font-size:22px;line-height:36px;cursor:pointer;padding:0}"
      + ".x:hover{background:rgba(255,255,255,.28)}"
      + ".x:focus-visible,.go:focus-visible,.no:focus-visible,input:focus-visible{outline:3px solid #7AA7FF;outline-offset:2px}"
      + ".body{padding:20px 24px 22px}"
      + ".sub{font-size:15px;line-height:1.45;color:#3A4150;margin:0 0 16px}"
      + "label{display:block;font-size:13px;font-weight:600;color:#2A303C;margin:0 0 6px}"
      + "input{display:block;width:100%;font-size:16px;padding:12px 14px;border:1.5px solid #CDD2DB;"
      + "border-radius:10px;margin:0 0 12px;color:#14171F;background:#fff}"
      + "input:focus{border-color:" + ACCENT + ";outline:none}"
      + ".hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}"
      + ".err{display:none;background:#FDECEC;color:#9B1C1C;font-size:14px;padding:10px 12px;border-radius:8px;margin:0 0 12px}"
      + ".go{display:block;width:100%;border:0;border-radius:10px;padding:14px 16px;font-size:17px;font-weight:700;"
      + "color:#fff;background:" + ACCENT + ";cursor:pointer}"
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
      + ".done h3{font-size:20px;margin:0 0 8px}.done p{font-size:15px;color:#3A4150;line-height:1.45;margin:0 0 16px}";
  }

  function amountLabel() {
    return "$" + Math.round((CFG.offerCents || 0) / 100).toLocaleString("en-US");
  }

  // Line under the big amount. The agency's own line is shown as written. The
  // automatic one ("this 2024 Toyota RAV4") would just repeat the vehicle strip
  // directly below it, so it becomes "on this vehicle" and the strip names the car.
  function subheadText() {
    var sub = CFG.subhead || CFG.headline || "";
    if (CFG.vehicleLabel && sub === "this " + CFG.vehicleLabel) return "on this vehicle";
    return sub;
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
      +   '<span class="amt"><span class="n">' + esc(amountLabel()) + '</span><span class="off">OFF</span></span>'
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
      + '<div class="box" id="box" role="dialog" aria-modal="true" aria-labelledby="hl">'
      +   headerHtml(useImage)
      +   vehicleHtml()
      +   '<div class="body">'
      +     '<form id="form" novalidate>'
      +       '<p class="sub">Enter your info and ' + (dealer || "our team") + ' will reach out with your offer'
      +         ' on this vehicle.</p>'
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
    if (!TEST && ssGet("lp_watched_" + VIN)) { log("skip: watched this VIN during delay"); return; }
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
    ssSet("lp_promo_shown_" + VIN, "1");
    ssSet("lp_promo_shown_any", "1");
    lsSet("lp_promo_seen_" + VIN, String(Date.now()));

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
    requestAnimationFrame(function () {
      root.getElementById("scrim").classList.add("in");
      root.getElementById("box").classList.add("in");
      setTimeout(function () { var n = root.getElementById("n"); if (n) n.focus(); }, 240);
    });

    if (reopen) {
      promoEvent("lp_promo_reopened", {
        item_id: VIN, page_type: "item", element_type: "popup",
        event_action_result: "popup",
        offer_amount: CFG.offerCents ? Math.round(CFG.offerCents / 100) : null,
        page_location: window.location.href,
      });
      log("reopened from tab");
      return;
    }
    apiPost("/v1/promo/impression", { vin: VIN, offerId: CFG.offerId }).catch(function () {});
    beat();
    promoEvent("lp_promo_view", {
      item_id: VIN, page_type: "item", element_type: "popup",
      event_action_result: "popup", trigger_type: trigger,
      offer_amount: CFG.offerCents ? Math.round(CFG.offerCents / 100) : null,
      creative: useImage ? "image" : "text",
      page_location: window.location.href,
    });
    log("shown (" + trigger + ", " + (useImage ? "image" : "text") + ")");
  }

  function hide(reason) {
    if (!host) return;
    var box = root.getElementById("box"), scrim = root.getElementById("scrim");
    box.classList.remove("in"); scrim.classList.remove("in");
    document.documentElement.style.overflow = savedOverflow || "";
    document.removeEventListener("keydown", onKey, true);
    var h = host; host = null;
    setTimeout(function () { if (h && h.parentNode) h.parentNode.removeChild(h); }, 250);
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
    if (reason) {
      promoEvent("lp_promo_dismissed", {
        item_id: VIN, page_type: "item", element_type: "popup",
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
    if (ssGet("lp_promo_tab_closed_" + VIN)) return true;
    return withinDays(lsGet("lp_promo_tab_closed_" + VIN), (CFG && CFG.suppressDays) || 7);
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
        || ssGet("lp_watched_" + VIN))) return;
    if (tabClosed()) return;

    var amount = amountLabel();
    tabHost = document.createElement("div");
    tabHost.id = "lp-promo-tab-host";
    var r = tabHost.attachShadow ? tabHost.attachShadow({ mode: "open" }) : tabHost;
    r.innerHTML = "<style>"
      + ":host{all:initial}"
      + "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}"
      + ".wrap{position:fixed;right:0;top:" + TAB_TOP + ";z-index:2147483000;transform:translate(110%,-50%);"
      + "transition:transform .35s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 4px 10px rgba(0,0,0,.28))}"
      + ".wrap.in{transform:translate(0,-50%)}"
      // Bookmark shape: flat on the page edge, V-notch on the side facing in.
      + ".tab{display:flex;flex-direction:column;align-items:center;justify-content:center;border:0;cursor:pointer;"
      + "background:" + ACCENT + ";color:#fff;padding:10px 12px 10px 24px;min-width:86px;line-height:1;"
      + "clip-path:polygon(0 0,100% 0,100% 100%,0 100%,13px 50%);transition:padding .15s}"
      + ".tab:hover{padding-right:18px}"
      + ".tab:focus-visible{outline:3px solid #7AA7FF;outline-offset:-3px}"
      + ".n{font-size:22px;font-weight:800;letter-spacing:-.01em}"
      + ".o{font-size:11px;font-weight:800;letter-spacing:.12em;margin-top:3px}"
      + ".tx{position:absolute;top:-9px;left:6px;width:22px;height:22px;border-radius:50%;border:2px solid #fff;"
      + "background:#2A303C;color:#fff;font-size:14px;line-height:17px;padding:0;cursor:pointer;text-align:center}"
      + ".tx:hover{background:#000}"
      + ".tx:focus-visible{outline:3px solid #7AA7FF}"
      + "@media (max-width:560px){.tab{min-width:74px;padding:8px 9px 8px 21px}.n{font-size:19px}.o{font-size:10px}}"
      + "@media (prefers-reduced-motion:reduce){.wrap{transition:none}}"
      + "@media print{.wrap{display:none}}"
      + "</style>"
      + '<div class="wrap" id="w">'
      +   '<button class="tab" id="t" type="button" aria-label="Reopen offer: ' + esc(amount) + ' off">'
      +     '<span class="n">' + esc(amount) + '</span><span class="o">OFF</span></button>'
      +   '<button class="tx" id="tx" type="button" aria-label="Hide this offer">&times;</button>'
      + '</div>';
    document.body.appendChild(tabHost);
    requestAnimationFrame(function () { var w = r.getElementById("w"); if (w) w.classList.add("in"); });

    r.getElementById("t").addEventListener("click", function () { show(lastTrigger, true); });
    r.getElementById("tx").addEventListener("click", function () {
      ssSet("lp_promo_tab_closed_" + VIN, "1");
      lsSet("lp_promo_tab_closed_" + VIN, String(Date.now()));
      removeTab();
      promoEvent("lp_promo_tab_dismissed", { item_id: VIN, page_type: "item", page_location: window.location.href });
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
    function row(label, val) {
      return val ? '<tr><th>' + label + '</th><td>' + esc(val) + '</td></tr>' : "";
    }
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>' + esc(amount + " off — " + (v.dealerName || "Offer")) + '</title><style>'
      + '*{box-sizing:border-box}body{margin:0;padding:28px 18px;background:#fff;color:#14171F;'
      + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
      + '-webkit-print-color-adjust:exact;print-color-adjust:exact}'
      + '.v{max-width:620px;margin:0 auto;border:3px dashed #14171F;border-radius:14px;padding:26px 28px}'
      + '.d{font-size:13px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;color:#3A4150}'
      + '.a{font-size:68px;font-weight:800;line-height:1;margin:10px 0 2px;color:' + ACCENT + ';letter-spacing:-.02em}'
      + '.a small{font-size:30px;letter-spacing:.02em;margin-left:8px}'
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
      + 'font-size:17px;font-weight:700;color:#fff;background:' + ACCENT + ';cursor:pointer}'
      + '@media print{body{padding:0}.pb{display:none}}'
      + '</style></head><body><div class="v">'
      + '<div class="d">' + esc(v.dealerName || "") + '</div>'
      + '<div class="a">' + esc(amount) + '<small>OFF</small></div>'
      + (title ? '<div class="c">' + esc(title) + '</div>' : "")
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
      item_id: VIN, page_type: "item", element_type: "form",
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

  function wire(trigger) {
    var form = root.getElementById("form"), err = root.getElementById("err"), go = root.getElementById("go");
    var name = root.getElementById("n"), email = root.getElementById("e"), phone = root.getElementById("p");

    root.getElementById("x").addEventListener("click", function () { hide(submitted ? null : "close_button"); });
    root.getElementById("no").addEventListener("click", function () { hide("no_thanks"); });
    root.getElementById("scrim").addEventListener("click", function () { hide(submitted ? null : "backdrop"); });
    root.getElementById("ok").addEventListener("click", function () { hide(null); });
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
        pageUrl: window.location.href, company: root.getElementById("hp").value,
        // Anonymous visitor id: links this lead to the "Live now" viewer row.
        vid: STORAGE_OK && ENG ? ENG.vid : null,
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
        lsSet("lp_promo_submitted", String(Date.now()));
        ssSet("lp_promo_submitted_s", "1");
        removeTab();
        beat();
        form.style.display = "none";
        var first = nm.split(/\s+/)[0];
        root.getElementById("doneH").textContent = "Thanks, " + first + "!";
        root.getElementById("doneP").textContent =
          (CFG.dealerName || "The dealer") + " has your request and will reach out about your offer.";
        root.getElementById("done").style.display = "block";
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
          item_id: VIN, page_type: "item", element_type: "form", form_type: "offer",
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
    setTimeout(function () { show("timed"); }, delay * 1000);

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
  function start(found) {
    VIN = found.vin;
    // Session-level checks first: they need no config, and skipping the API
    // call on repeat pageviews keeps load off the server.
    var pre = clientSuppressed(VIN, 0);
    // Normally a session-suppressed page stops here without calling the API.
    // The exception: the shopper already saw (and closed) the popup on this
    // car. Then we still fetch the offer so the reopen TAB can come back —
    // otherwise a reload would make the offer unreachable.
    var tabOnly = pre === "shown_this_session" && TAB_ON
      && !ssGet("lp_promo_submitted_s") && !ssGet("lp_promo_tab_closed_" + VIN);
    if (pre && !tabOnly) { log("suppressed: " + pre); return; }

    apiGet("/v1/promo/config?vin=" + encodeURIComponent(VIN)).then(function (c) {
      if (!c || !c.eligible) { log("not eligible" + (c && c.reason ? ": " + c.reason : "")); return; }
      CFG = c;
      // Preload the offer graphic now so it's cached by the time the popup
      // opens (35s later by default). show() checks it actually loaded.
      if (c.imagePath) { IMG = new Image(); IMG.src = API + c.imagePath; }
      RULES = c.engagement || RULES;
      var why = clientSuppressed(VIN, c.suppressDays);
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

  function boot() {
    engUpdate();        // count the visit (every page, vehicle page or not)
    startClock();
    var tries = 0;
    (function attempt() {
      var found = findVdpVin();
      if (found && found.srp) { classify("other"); log("listing page — promo not shown"); return; }
      if (found && found.vin) { classify("vdp", found.vin); start(found); return; }
      // VDPs on some platforms render the VIN late; retry for ~6s like the
      // watch widget's anchor wait, then treat it as a non-vehicle page.
      if (tries++ < 12) setTimeout(attempt, 500);
      else classify("other");
    })();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(boot, 600); });
  } else {
    setTimeout(boot, 600);
  }
})();
