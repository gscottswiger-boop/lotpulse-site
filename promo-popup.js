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
// isn't live for this dealer/VIN, nothing shows, test mode or not.
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

  // ── Analytics → dealer's own dataLayer (same approach as the watch widget) ─
  function promoEvent(name, params) {
    try {
      window.dataLayer = window.dataLayer || [];
      var payload = { event: name, event_owner: "lotpulse", product_name: "LotPulse Promo" };
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
      + ".done{display:none;text-align:center;padding:8px 0 4px}"
      + ".check{width:52px;height:52px;border-radius:50%;background:#E7F6EE;color:#1E8E5A;display:flex;"
      + "align-items:center;justify-content:center;margin:0 auto 12px;font-size:28px}"
      + ".done h3{font-size:20px;margin:0 0 8px}.done p{font-size:15px;color:#3A4150;line-height:1.45;margin:0 0 16px}";
  }

  function amountLabel() {
    return "$" + Math.round((CFG.offerCents || 0) / 100).toLocaleString("en-US");
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
      +   '<span class="subhl">' + esc(CFG.subhead || CFG.headline || "") + '</span>'
      + '</h2>'
      + close + '</div>';
  }

  function html(useImage) {
    var dealer = esc(CFG.dealerName || "");
    return ""
      + '<div class="scrim" id="scrim"></div>'
      + '<div class="box" id="box" role="dialog" aria-modal="true" aria-labelledby="hl">'
      +   headerHtml(useImage)
      +   '<div class="body">'
      +     '<form id="form" novalidate>'
      +       '<p class="sub">Enter your info and ' + (dealer || "our team") + ' will reach out with your offer'
      +         (CFG.vehicleLabel ? ' on this ' + esc(CFG.vehicleLabel) : '') + '.</p>'
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
        form.style.display = "none";
        var first = nm.split(/\s+/)[0];
        root.getElementById("doneH").textContent = "Thanks, " + first + "!";
        root.getElementById("doneP").textContent =
          (CFG.dealerName || "The dealer") + " has your request and will reach out about your offer.";
        root.getElementById("done").style.display = "block";
        root.getElementById("ok").focus();
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
      var why = clientSuppressed(VIN, c.suppressDays);
      if (why) {
        log("suppressed: " + why);
        // Popup held back because they've already seen it on this car: show
        // just the tab (showTab applies its own submit / watch / closed checks).
        if (why === "shown_this_session" || why === "seen_recently") { shown = true; showTab(); }
        return;
      }
      armTriggers();
    }).catch(function (e) { log("config fetch failed (no popup):", e && e.message); });
  }

  function boot() {
    var tries = 0;
    (function attempt() {
      var found = findVdpVin();
      if (found && found.srp) { log("listing page — promo not shown"); return; }
      if (found && found.vin) { start(found); return; }
      // VDPs on some platforms render the VIN late; retry for ~6s like the
      // watch widget's anchor wait, then give up quietly.
      if (tries++ < 12) setTimeout(attempt, 500);
    })();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(boot, 600); });
  } else {
    setTimeout(boot, 600);
  }
})();
