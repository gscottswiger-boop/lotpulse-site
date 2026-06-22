// ════════════════════════════════════════════════════════════════════════════
// lotpulse-widget.js — production widget loader
// ════════════════════════════════════════════════════════════════════════════
// This is the script that goes in Google Tag Manager. It:
//   1. Detects the VIN on a vehicle detail page (VDP)
//   2. Calls the LotPulse API for that VIN's watcher count + deal intel
//   3. Injects the "Watch this car" widget into the page
//   4. Handles the phone capture + consent and posts the watch
//
// It is fully self-contained: all styles are scoped inside a shadow DOM so the
// host dealer site's CSS can never collide with ours (and ours can't leak out).
// Nothing here depends on the host page's framework.
//
// CONFIG: the dealer's public key and the API base are baked in at the bottom.
// ════════════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  // Guard against double-injection (GTM can fire twice on some sites).
  if (window.__lotpulseLoaded) return;
  window.__lotpulseLoaded = true;

  var CONFIG = window.__lotpulseConfig || {};
  var API = (CONFIG.apiBase || "").replace(/\/$/, "");
  var KEY = CONFIG.publicKey || "";
  var ANCHOR_SELECTOR = CONFIG.anchorSelector || null; // optional override

  if (!API || !KEY) {
    console.warn("[LotPulse] missing apiBase or publicKey; widget not loaded");
    return;
  }

  // ── VIN detection ──────────────────────────────────────────────────────────
  // Try the most reliable sources in order. A VIN is 17 alphanumeric chars,
  // excluding I/O/Q. We look in: JSON-LD vehicle schema, common data attributes,
  // meta tags, then a last-resort page-text regex.
  function findVin() {
    // 1. JSON-LD structured data (Dealer Inspire emits Vehicle schema)
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      try {
        var data = JSON.parse(scripts[i].textContent);
        var vin = scanJsonLdForVin(data);
        if (vin) return vin;
      } catch (e) { /* ignore malformed blocks */ }
    }
    // 2. Data attributes commonly present on VDPs
    var attrSel = "[data-vin],[data-vehicle-vin],[itemprop='vehicleIdentificationNumber']";
    var el = document.querySelector(attrSel);
    if (el) {
      var v = el.getAttribute("data-vin") ||
              el.getAttribute("data-vehicle-vin") ||
              el.getAttribute("content") ||
              el.textContent;
      v = cleanVin(v);
      if (v) return v;
    }
    // 3. Meta tags
    var meta = document.querySelector("meta[name='vin'],meta[property='vehicle:vin']");
    if (meta) {
      var mv = cleanVin(meta.getAttribute("content"));
      if (mv) return mv;
    }
    // 4. Last resort: a clean 17-char VIN token in the URL
    var urlMatch = window.location.href.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
    if (urlMatch) return urlMatch[1].toUpperCase();
    return null;
  }

  function scanJsonLdForVin(node) {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        var r = scanJsonLdForVin(node[i]);
        if (r) return r;
      }
      return null;
    }
    if (node.vehicleIdentificationNumber) {
      return cleanVin(node.vehicleIdentificationNumber);
    }
    for (var k in node) {
      if (typeof node[k] === "object") {
        var found = scanJsonLdForVin(node[k]);
        if (found) return found;
      }
    }
    return null;
  }

  function cleanVin(raw) {
    if (!raw) return null;
    var v = String(raw).toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "");
    return v.length === 17 ? v : null;
  }

  // ── API calls ──────────────────────────────────────────────────────────────
  function apiGet(path) {
    return fetch(API + path, { headers: { "x-lotpulse-key": KEY } })
      .then(function (r) { return r.json(); });
  }
  function apiPost(path, body) {
    return fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-lotpulse-key": KEY },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); });
  }

  // ── Build the widget UI inside a shadow root ───────────────────────────────
  function mountWidget(vin, demand) {
    var host = document.createElement("div");
    host.id = "lotpulse-widget-host";
    host.style.cssText = "display:block;margin:16px 0;";

    var anchor = pickAnchor();
    if (!anchor || !anchor.el || !anchor.el.parentNode) return;

    if (anchor.position === "before") {
      anchor.el.parentNode.insertBefore(host, anchor.el);
    } else if (anchor.position === "prepend") {
      anchor.el.insertBefore(host, anchor.el.firstChild);
    } else if (anchor.position === "append") {
      anchor.el.appendChild(host);
    } else {
      // default: after the anchor element
      anchor.el.parentNode.insertBefore(host, anchor.el.nextSibling);
    }

    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    root.innerHTML = widgetHtml(demand);

    wireWidget(root, vin, demand);
  }

  // Where to drop the widget: explicit selector override, else after the price,
  // else after the first H1 on the page.
  // Where to drop the widget. Priority order:
  //   1. Explicit anchorSelector from config (always wins if it matches)
  //   2. Dealer Inspire's purpose-built custom-HTML CTA slots (the right rail)
  //   3. The price-box CTA container itself
  //   4. Generic price element, then H1 — last-resort fallbacks
  // We also choose whether to insert BEFORE or AFTER the anchor via data flag.
  function pickAnchor() {
    if (ANCHOR_SELECTOR) {
      var custom = document.querySelector(ANCHOR_SELECTOR);
      if (custom) return { el: custom, position: CONFIG.anchorPosition || "after" };
    }
    // Dealer Inspire: dedicated injection slots in the pricing CTA stack.
    var diSlots = [
      "[data-testid='vehicle-cta-4']",
      "[data-testid='vehicle-cta-3']",
      "[data-testid='vehicle-cta-2']",
      "[data-testid='vehicle-cta-1']",
      ".vdp-price-box__cta",
      ".vdp-price-box"
    ];
    for (var i = 0; i < diSlots.length; i++) {
      var slot = document.querySelector(diSlots[i]);
      if (slot) return { el: slot, position: "after" };
    }
    // Generic fallbacks (other platforms / unknown layouts).
    var price = document.querySelector("[itemprop='price'],[data-price]");
    if (price) return { el: price, position: "after" };
    var h1 = document.querySelector("h1");
    return { el: h1 || document.body.firstElementChild, position: "after" };
  }

  function dollars(cents) {
    if (cents == null) return "";
    return "$" + (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function widgetHtml(demand) {
    var watchers = (demand && demand.watchers) || 0;
    var days = (demand && demand.daysOnLot != null) ? demand.daysOnLot : null;
    var tach = "";
    for (var i = 0; i < 14; i++) {
      var cls = i < watchers ? (i >= 5 ? "seg on hi" : "seg on") : "seg";
      tach += '<i class="' + cls + '"></i>';
    }
    var intelDays = days != null
      ? '<div class="cell"><div class="num">' + days + '</div><div class="lbl">Days listed</div></div>'
      : "";

    return ''
    + '<style>'
    + ':host,*{box-sizing:border-box}'
    + '.card{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
    +   'background:#fff;border:1px solid #E4E7E4;border-radius:14px;overflow:hidden;'
    +   'box-shadow:0 1px 2px rgba(20,24,29,.05),0 8px 28px rgba(20,24,29,.07);max-width:520px}'
    + '.intel{display:flex;border-bottom:1px solid #E4E7E4}'
    + '.cell{flex:1;padding:13px 8px;text-align:center}'
    + '.cell + .cell{border-left:1px solid #E4E7E4}'
    + '.num{font-weight:700;font-size:22px;line-height:1;color:#14181D}'
    + '.num.hot{color:#DE3730}'
    + '.lbl{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#5C6670;margin-top:5px}'
    + '.tachrow{display:flex;align-items:center;gap:12px;padding:15px 16px 4px}'
    + '.tach{display:flex;gap:3px;flex:1}'
    + '.seg{height:9px;flex:1;border-radius:2px;background:#E9ECE9}'
    + '.seg.on{background:#F5A300}.seg.on.hi{background:#DE3730}'
    + '.wc{display:flex;align-items:baseline;gap:6px;white-space:nowrap}'
    + '.wc .n{font-weight:700;font-size:24px;color:#DE3730}'
    + '.wc .t{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#5C6670}'
    + '.note{padding:2px 16px 0;font-size:12.5px;color:#5C6670}'
    + '.cta{padding:14px 16px 15px}'
    + '.btn{width:100%;border:0;cursor:pointer;background:#1F4FE0;color:#fff;border-radius:11px;'
    +   'padding:16px;font-size:17px;font-weight:700;font-family:inherit;'
    +   'display:flex;align-items:center;justify-content:center;gap:10px;transition:background .15s}'
    + '.btn:hover{background:#1740B8}'
    + '.btn.watching{background:#1E8E5A}'
    + '.sub{margin-top:9px;text-align:center;font-size:12px;color:#5C6670}'
    + '.brand{border-top:1px solid #E4E7E4;padding:8px 16px;text-align:center;'
    +   'font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#A6AEA8;font-weight:600}'
    // sheet
    + '.scrim{position:fixed;inset:0;background:rgba(16,20,24,.45);opacity:0;pointer-events:none;'
    +   'transition:opacity .2s;z-index:2147483646}'
    + '.scrim.open{opacity:1;pointer-events:auto}'
    + '.sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-width:520px;margin:0 auto;'
    +   'background:#fff;border-radius:20px 20px 0 0;padding:10px 20px 24px;'
    +   'transform:translateY(105%);transition:transform .26s cubic-bezier(.32,.72,.2,1);'
    +   'box-shadow:0 -12px 48px rgba(20,24,29,.18);font-family:inherit}'
    + '.sheet.open{transform:translateY(0)}'
    + '.grab{width:38px;height:4px;border-radius:2px;background:#E4E7E4;margin:0 auto 16px}'
    + '.sheet h3{font-size:21px;font-weight:700;color:#14181D;margin:0 0 5px}'
    + '.sheet p{font-size:14px;color:#5C6670;margin:0 0 16px}'
    + '.field{display:flex;align-items:center;gap:10px;border:1.5px solid #E4E7E4;border-radius:11px;'
    +   'padding:14px;margin-bottom:12px}'
    + '.field:focus-within{border-color:#1F4FE0}'
    + '.field .cc{font-weight:600;color:#5C6670;font-size:15px}'
    + '.field input{border:0;outline:0;flex:1;font-family:inherit;font-size:17px;font-weight:500;'
    +   'color:#14181D;background:transparent;min-width:0}'
    + '.fine{font-size:10.5px;line-height:1.5;color:#9AA29C;margin-top:11px}'
    + '.err{color:#DE3730;font-size:13px;margin-bottom:10px;display:none}'
    + '</style>'
    + '<div class="card">'
    +   '<div class="intel">'
    +     '<div class="cell"><div class="num hot" id="lp-wn">' + watchers + '</div><div class="lbl">Watching now</div></div>'
    +     intelDays
    +   '</div>'
    +   '<div class="tachrow"><div class="tach">' + tach + '</div>'
    +     '<div class="wc"><span class="n" id="lp-wn2">' + watchers + '</span><span class="t">watching</span></div></div>'
    +   '<div class="note">Get a text the moment the price drops.</div>'
    +   '<div class="cta">'
    +     '<button class="btn" id="lp-btn">'
    +       '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
    +       '<span id="lp-lbl">Watch this car</span>'
    +     '</button>'
    +     '<div class="sub" id="lp-sub">Free price-drop alerts by text. No calls.</div>'
    +   '</div>'
    +   '<div class="brand">Demand data · LotPulse</div>'
    + '</div>'
    + '<div class="scrim" id="lp-scrim"></div>'
    + '<div class="sheet" id="lp-sheet" role="dialog" aria-modal="true">'
    +   '<div class="grab"></div>'
    +   '<h3>Get a text when this price drops</h3>'
    +   '<p>Just your number. No salesperson will call you.</p>'
    +   '<div class="err" id="lp-err"></div>'
    +   '<div class="field"><span class="cc">+1</span>'
    +     '<input type="tel" inputmode="tel" placeholder="(555) 555-0134" id="lp-phone" autocomplete="tel"></div>'
    +   '<button class="btn" id="lp-confirm">'
    +     '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
    +     'Watch it</button>'
    +   '<div class="fine" id="lp-fine"></div>'
    + '</div>';
  }

  function wireWidget(root, vin, demand) {
    var btn = root.getElementById("lp-btn");
    var sheet = root.getElementById("lp-sheet");
    var scrim = root.getElementById("lp-scrim");
    var phone = root.getElementById("lp-phone");
    var confirm = root.getElementById("lp-confirm");
    var err = root.getElementById("lp-err");
    var fine = root.getElementById("lp-fine");
    var watching = false;

    // Consent fine print (kept in sync with what the server stores).
    fine.textContent =
      "By tapping Watch it, you agree to receive automated marketing texts about this "
      + "vehicle from this dealer. Consent is not a condition of purchase. Msg & data rates "
      + "may apply. Reply STOP to opt out, HELP for help.";

    function openSheet() { sheet.classList.add("open"); scrim.classList.add("open");
      setTimeout(function () { phone.focus(); }, 280); }
    function closeSheet() { sheet.classList.remove("open"); scrim.classList.remove("open"); }

    btn.addEventListener("click", function () { if (!watching) openSheet(); });
    scrim.addEventListener("click", closeSheet);

    phone.addEventListener("input", function (e) {
      var d = e.target.value.replace(/\D/g, "").slice(0, 10);
      var out = d;
      if (d.length > 6) out = "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
      else if (d.length > 3) out = "(" + d.slice(0, 3) + ") " + d.slice(3);
      e.target.value = out;
    });

    confirm.addEventListener("click", function () {
      err.style.display = "none";
      var raw = phone.value.replace(/\D/g, "");
      if (raw.length !== 10) {
        err.textContent = "Enter a valid 10-digit mobile number.";
        err.style.display = "block";
        return;
      }
      confirm.disabled = true;
      apiPost("/v1/watch", { vin: vin, phone: raw }).then(function (res) {
        confirm.disabled = false;
        if (!res.ok) {
          err.textContent = (res.json && res.json.error) || "Something went wrong. Try again.";
          err.style.display = "block";
          return;
        }
        watching = true;
        closeSheet();
        root.getElementById("lp-lbl").textContent = "Watching — alerts on";
        btn.classList.add("watching");
        root.getElementById("lp-sub").textContent = "We'll text you first. Reply STOP anytime.";
        var n = (res.json && res.json.watchers) != null ? res.json.watchers : (demand.watchers + 1);
        root.getElementById("lp-wn").textContent = n;
        root.getElementById("lp-wn2").textContent = n;
      }).catch(function () {
        confirm.disabled = false;
        err.textContent = "Network error. Try again.";
        err.style.display = "block";
      });
    });
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  function boot() {
    var vin = findVin();
    if (!vin) {
      // Not a VDP (or VIN not found) — do nothing, stay invisible.
      return;
    }
    apiGet("/v1/vehicle/" + vin + "/demand").then(function (demand) {
      mountWidget(vin, demand || { watchers: 0 });
    }).catch(function (e) {
      console.warn("[LotPulse] demand fetch failed:", e);
    });
  }

  // VDPs often render late (SPA-style). Wait for DOM, then give it a beat.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(boot, 400); });
  } else {
    setTimeout(boot, 400);
  }
})();
