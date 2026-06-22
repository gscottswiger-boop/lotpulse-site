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
      // stagger the fill animation per segment
      tach += '<i class="' + cls + '" style="--d:' + (i * 38) + 'ms"></i>';
    }
    var intelDays = days != null
      ? '<div class="cell"><div class="num">' + days + '</div><div class="lbl">Days listed</div></div>'
      : "";

    return ''
    + '<style>'
    + ':host,*{box-sizing:border-box}'
    + '.card{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
    +   'background:#fff;border:1px solid #E6E9EE;border-radius:18px;overflow:hidden;'
    +   'box-shadow:0 1px 2px rgba(20,24,29,.04),0 12px 32px rgba(31,79,224,.10);max-width:520px;'
    +   'animation:lpRise .5s cubic-bezier(.2,.7,.2,1) both}'
    + '@keyframes lpRise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}'
    // trust header strip
    + '.hd{display:flex;align-items:center;gap:8px;padding:13px 16px;'
    +   'background:linear-gradient(180deg,#F5F8FF,#fff);border-bottom:1px solid #EDF1F7}'
    + '.hd .spark{width:26px;height:26px;border-radius:8px;background:#1F4FE0;flex-shrink:0;'
    +   'display:flex;align-items:center;justify-content:center}'
    + '.hd .hdt{font-weight:700;font-size:14.5px;color:#14181D;letter-spacing:-.01em}'
    + '.hd .hds{font-size:11.5px;color:#5C6670;margin-top:1px}'
    + '.intel{display:flex;border-bottom:1px solid #EDF1F7}'
    + '.cell{flex:1;padding:13px 8px;text-align:center}'
    + '.cell + .cell{border-left:1px solid #EDF1F7}'
    + '.num{font-weight:800;font-size:23px;line-height:1;color:#14181D;letter-spacing:-.02em}'
    + '.num.hot{color:#1F4FE0}'
    + '.lbl{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#5C6670;margin-top:5px}'
    + '.tachrow{display:flex;align-items:center;gap:12px;padding:16px 16px 6px}'
    + '.tach{display:flex;gap:3px;flex:1}'
    + '.seg{height:10px;flex:1;border-radius:3px;background:#EAEDF2;transform:scaleY(.6);'
    +   'animation:lpSeg .4s ease both;animation-delay:var(--d,0ms)}'
    + '@keyframes lpSeg{to{transform:scaleY(1)}}'
    + '.seg.on{background:#F5A300}.seg.on.hi{background:#1F4FE0}'
    + '.wc{display:flex;align-items:baseline;gap:6px;white-space:nowrap}'
    + '.wc .n{font-weight:800;font-size:25px;color:#1F4FE0;letter-spacing:-.02em}'
    + '.wc .t{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#5C6670}'
    + '.note{padding:2px 16px 0;font-size:13px;color:#5C6670;font-weight:500}'
    + '.cta{padding:14px 16px 16px}'
    + '.btn{width:100%;border:0;cursor:pointer;background:#1F4FE0;color:#fff;border-radius:13px;'
    +   'padding:17px;font-size:17px;font-weight:700;font-family:inherit;letter-spacing:-.01em;'
    +   'display:flex;align-items:center;justify-content:center;gap:10px;'
    +   'box-shadow:0 4px 14px rgba(31,79,224,.32);transition:transform .12s,box-shadow .15s,background .15s}'
    + '.btn:hover{background:#1740B8;box-shadow:0 6px 20px rgba(31,79,224,.4)}'
    + '.btn:active{transform:translateY(1px) scale(.995)}'
    + '.btn.watching{background:#1E8E5A;box-shadow:0 4px 14px rgba(30,142,90,.3)}'
    // reassurance row under button — the no-pressure promise, made loud
    + '.promise{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:11px;flex-wrap:wrap}'
    + '.promise span{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#3A434D;font-weight:600}'
    + '.promise svg{flex-shrink:0;color:#1E8E5A}'
    + '.sub{margin-top:9px;text-align:center;font-size:12px;color:#5C6670;display:none}'
    + '.brand{border-top:1px solid #EDF1F7;padding:9px 16px;text-align:center;'
    +   'font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#AEB6BF;font-weight:600}'
    // sheet
    + '.scrim{position:fixed;inset:0;background:rgba(13,18,28,.5);opacity:0;pointer-events:none;'
    +   'transition:opacity .22s;z-index:2147483646}'
    + '.scrim.open{opacity:1;pointer-events:auto}'
    + '.sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-width:520px;margin:0 auto;'
    +   'background:#fff;border-radius:24px 24px 0 0;padding:10px 22px 26px;'
    +   'transform:translateY(105%);transition:transform .3s cubic-bezier(.32,.72,.2,1);'
    +   'box-shadow:0 -16px 56px rgba(13,18,28,.22);font-family:inherit}'
    + '.sheet.open{transform:translateY(0)}'
    + '.grab{width:40px;height:4px;border-radius:2px;background:#E4E7E4;margin:0 auto 18px}'
    + '.sheet h3{font-size:23px;font-weight:800;color:#14181D;margin:0 0 6px;letter-spacing:-.02em;line-height:1.15}'
    + '.sheet .psub{font-size:14px;color:#5C6670;margin:0 0 16px}'
    + '.perks{list-style:none;margin:0 0 18px;padding:0}'
    + '.perks li{display:flex;gap:11px;align-items:center;font-size:14px;color:#2A323A;padding:6px 0}'
    + '.perks .pk{width:30px;height:30px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;'
    +   'justify-content:center;background:#EAF1FF;color:#1F4FE0}'
    + '.field{display:flex;align-items:center;gap:10px;border:1.5px solid #E4E7E4;border-radius:13px;'
    +   'padding:15px 15px;margin-bottom:12px;transition:border-color .15s,box-shadow .15s}'
    + '.field:focus-within{border-color:#1F4FE0;box-shadow:0 0 0 4px rgba(31,79,224,.12)}'
    + '.field .cc{font-weight:700;color:#5C6670;font-size:15px}'
    + '.field input{border:0;outline:0;flex:1;font-family:inherit;font-size:17px;font-weight:600;'
    +   'color:#14181D;background:transparent;min-width:0}'
    + '.fine{font-size:10.5px;line-height:1.5;color:#9AA29C;margin-top:12px}'
    + '.err{color:#DE3730;font-size:13px;font-weight:600;margin-bottom:10px;display:none}'
    + '</style>'
    + '<div class="card">'
    +   '<div class="hd"><div class="spark">'
    +     '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 13 6 13 9 5 14 19 17 13 22 13"/></svg>'
    +   '</div><div><div class="hdt">Track this price</div><div class="hds">No haggling. No salesperson. Just a text.</div></div></div>'
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
    +     '<div class="promise" id="lp-promise">'
    +       '<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>No calls</span>'
    +       '<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>No spam</span>'
    +       '<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Cancel anytime</span>'
    +     '</div>'
    +     '<div class="sub" id="lp-sub"></div>'
    +   '</div>'
    +   '<div class="brand">Powered by LotPulse</div>'
    + '</div>'
    + '<div class="scrim" id="lp-scrim"></div>'
    + '<div class="sheet" id="lp-sheet" role="dialog" aria-modal="true">'
    +   '<div class="grab"></div>'
    +   '<h3>Get a text when this price drops</h3>'
    +   '<p class="psub">Drop your number. No salesperson will ever call you.</p>'
    +   '<ul class="perks">'
    +     '<li><span class="pk"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></span>Price drops — you hear first, before the listing updates</li>'
    +     '<li><span class="pk"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></span>Demand alerts — know when others start watching</li>'
    +     '<li><span class="pk"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Sold notice — never chase a car that\'s already gone</li>'
    +   '</ul>'
    +   '<div class="err" id="lp-err"></div>'
    +   '<div class="field"><span class="cc">+1</span>'
    +     '<input type="tel" inputmode="tel" placeholder="(555) 555-0134" id="lp-phone" autocomplete="tel" name="tel"></div>'
    +   '<button class="btn" id="lp-confirm">'
    +     '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
    +     'Start watching</button>'
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
        root.getElementById("lp-lbl").textContent = "Watching — we'll text you";
        btn.classList.add("watching");
        var promiseEl = root.getElementById("lp-promise");
        if (promiseEl) promiseEl.style.display = "none";
        var subEl = root.getElementById("lp-sub");
        if (subEl) { subEl.style.display = "block"; subEl.textContent = "You're all set. Reply STOP anytime."; }
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
      mountWhenAnchorReady(vin, demand || { watchers: 0 });
    }).catch(function (e) {
      console.warn("[LotPulse] demand fetch failed:", e);
    });
  }

  // Some Dealer Inspire pages build the right-rail CTA slots late. Rather than
  // mount once and give up, watch the DOM for up to ~6s and inject the moment
  // the anchor exists. This makes placement robust across new/used/slow pages.
  function mountWhenAnchorReady(vin, demand) {
    if (document.getElementById("lotpulse-widget-host")) return; // already mounted
    var anchor = pickAnchor();
    if (anchor && anchor.el && anchor.el.parentNode) {
      mountWidget(vin, demand);
      return;
    }
    var tries = 0;
    var obs = new MutationObserver(function () {
      if (document.getElementById("lotpulse-widget-host")) { obs.disconnect(); return; }
      var a = pickAnchor();
      if (a && a.el && a.el.parentNode) {
        obs.disconnect();
        mountWidget(vin, demand);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    // Safety stop after ~6s so we don't observe forever.
    var iv = setInterval(function () {
      tries++;
      if (document.getElementById("lotpulse-widget-host") || tries > 12) {
        clearInterval(iv); obs.disconnect();
      }
    }, 500);
  }

  // VDPs often render late (SPA-style). Wait for DOM, then give it a beat.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(boot, 400); });
  } else {
    setTimeout(boot, 400);
  }
})();
