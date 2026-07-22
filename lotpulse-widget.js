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
    // 2. Data attributes commonly present on VDPs. Dealer.com exposes the VIN
    // as a hidden <input name="vin" value="..."> rather than a data attribute,
    // and its VDP URLs carry an item-id hash instead of the VIN — so without
    // this the DDC path leans entirely on JSON-LD.
    var attrSel = "[data-vin],[data-vehicle-vin],[itemprop='vehicleIdentificationNumber'],input[name='vin']";
    var el = document.querySelector(attrSel);
    if (el) {
      var v = el.getAttribute("data-vin") ||
              el.getAttribute("data-vehicle-vin") ||
              el.getAttribute("content") ||
              el.getAttribute("value") ||
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

  // Collect EVERY distinct VIN in the page's JSON-LD. A single Vehicle schema
  // means a VDP; an ItemList with many vehicles means a LISTING page — even
  // when the per-card markup doesn't match any pattern we know. This is the
  // platform-independent tiebreaker: Dealer.com SRPs carry no per-card VIN
  // attributes at all, so the card scan finds ~nothing, VDP mode kicked in,
  // and the widget mounted for whatever vehicle happened to be FIRST in the
  // JSON-LD — a watch card for a random car the shopper never opened.
  function findAllJsonLdVins() {
    var seen = {};
    var out = [];
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i]); return; }
      if (node.vehicleIdentificationNumber) {
        var v = cleanVin(node.vehicleIdentificationNumber);
        if (v && !seen[v]) { seen[v] = true; out.push(v); }
      }
      for (var k in node) { if (typeof node[k] === "object") walk(node[k]); }
    }
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var s = 0; s < scripts.length; s++) {
      try { walk(JSON.parse(scripts[s].textContent)); } catch (e) { /* ignore */ }
    }
    return out;
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
  var VDP_ROOT = null; // kept so a late-arriving demand fetch can update counts

  // Walk up from an element looking for a scroll-capped ancestor: a container
  // with overflow-y auto/scroll AND a bounded height (a max-height cap, or
  // content already taller than its box). Anything mounted inside one of
  // these can sit below the container's INTERNAL fold — rendered perfectly,
  // logged as mounted, and invisible unless the shopper scrolls the little
  // box. Confirmed real on Herndon Chevrolet's Dealer Inspire theme, where
  // #vdp-sidebar-wrapper caps the sticky right rail at
  // max-height: calc(100vh - 454px) with internal scroll — a layout Big O's
  // DI theme doesn't use, which is why this never surfaced there.
  function scrollTrapAncestor(el) {
    var node = el;
    for (var i = 0; i < 12 && node && node !== document.body && node !== document.documentElement; i++) {
      var cs = window.getComputedStyle(node);
      var oy = cs.overflowY;
      if (oy === "auto" || oy === "scroll") {
        var capped = cs.maxHeight !== "none" || node.scrollHeight > node.clientHeight + 4;
        if (capped) return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function mountWidget(vin, demand) {
    var host = document.createElement("div");
    host.id = "lotpulse-widget-host";
    host.style.cssText = "display:block;margin:16px 0;";

    var anchor = pickAnchor();
    if (!anchor || !anchor.el || !anchor.el.parentNode) return;

    // If the chosen anchor lives inside a scroll-capped container, do NOT
    // mount inside it — the widget would be buried below the container's
    // internal fold. And do NOT mount as a sibling inside the sticky wrapper
    // either: confirmed on Herndon's DI theme that the sticky engine actively
    // sizes/positions the children it owns, and an uninvited sibling falls
    // out of the rail's managed layout (rendered 1260px wide, colliding with
    // page text). The only safe escape is PAST the whole sticky apparatus:
    // climb from the scroll container to its enclosing <section> (vdp-hero on
    // DI — gallery + rail together) and mount after that, in normal document
    // flow, centered. Overlap-proof: normal flow pushes what follows down.
    // An explicit anchorSelector from config bypasses this escape entirely.
    if (!anchor.explicit) {
      var trap = scrollTrapAncestor(anchor.el);
      if (trap && trap.parentNode) {
        var flowTarget = trap;
        var climb = trap.parentElement;
        for (var ci = 0; ci < 6 && climb && climb !== document.body; ci++) {
          flowTarget = climb;
          if (climb.tagName === "SECTION") break;
          climb = climb.parentElement;
        }
        if (flowTarget && flowTarget.parentNode) {
          console.log("[LotPulse] anchor sits inside a scroll-capped container ("
            + (trap.id || trap.className || trap.tagName)
            + ") — escaping past the sticky apparatus, mounting after <"
            + flowTarget.tagName.toLowerCase()
            + (flowTarget.className ? " class=\"" + flowTarget.className + "\"" : "")
            + "> in normal flow");
          // The rail column's left edge = the anchor's left edge (the anchor
          // is a CTA slot inside the rail). Measure it BEFORE mounting, then
          // size the band to fill the gallery column and stop short of the
          // rail — a hard-coded width spills under the rail's overlay.
          var anchorRect = anchor.el.getBoundingClientRect();
          host.style.cssText = "display:flex;justify-content:flex-start;margin:20px 12px;pointer-events:none;";
          flowTarget.parentNode.insertBefore(host, flowTarget.nextSibling);
          // The sticky rail is absolutely positioned, so the hero section's
          // height doesn't include it — on themes where the rail is TALLER
          // than the gallery (Herndon), the rail overhangs the hero's bottom
          // edge and our band slides up underneath it. Measure the actual
          // rendered overlap and push the band below it. Themes with no
          // overhang (Heyward) measure zero and stay put.
          var trapRect = trap.getBoundingClientRect();
          var hostRect = host.getBoundingClientRect();
          if (trapRect.bottom > hostRect.top) {
            var push = Math.round(trapRect.bottom - hostRect.top) + 24;
            host.style.marginTop = push + "px";
            console.log("[LotPulse] sticky rail overhangs the hero by ~"
              + (push - 24) + "px — pushing the widget band below it");
          }
          var root0 = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
          root0.innerHTML = widgetHtml(demand);
          // Available width = from the band's left edge to the rail column's
          // left edge, minus breathing room. Wide layout only if that leaves
          // real room; otherwise keep the vertical card, left-aligned under
          // the gallery. If the measurement is degenerate (hidden anchor),
          // skip the constraint rather than trusting a bad number.
          var hostRect0 = host.getBoundingClientRect();
          // The escaped host spans the hero's full-bleed width, so "left of
          // host" is the PAGE edge, not the gallery's. Anchor the card's left
          // edge to the gallery column itself when it's findable; fall back
          // to a small inset otherwise.
          var leftEdge = hostRect0.left + 12;
          var galleryEl = document.querySelector(".vdp-gallery-wrap");
          if (galleryEl) {
            var gr = galleryEl.getBoundingClientRect();
            if (gr.width > 200) leftEdge = gr.left;
          }
          var availW = Math.floor(anchorRect.left - leftEdge - 24);
          var cardEl0 = root0.querySelector(".card");
          if (cardEl0) {
            cardEl0.style.marginLeft = Math.max(0, Math.round(leftEdge - hostRect0.left)) + "px";
          }
          if (cardEl0 && availW >= 760) {
            cardEl0.classList.add("wide");
            cardEl0.style.maxWidth = availW + "px";
            console.log("[LotPulse] wide band — horizontal layout, " + availW
              + "px wide, left edge at " + Math.round(leftEdge)
              + "px (" + (galleryEl ? "gallery-aligned" : "host-inset") + "), stops short of the rail");
          } else if (cardEl0 && availW >= 320) {
            console.log("[LotPulse] band width " + availW
              + "px — keeping vertical card, gallery-aligned, clear of the rail");
          }
          VDP_ROOT = root0;
          wireWidget(root0, vin, demand);
          return;
        }
      }
    }

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
    VDP_ROOT = root;

    wireWidget(root, vin, demand);
  }

  // Update the mounted widget's numbers when demand data arrives after mount.
  // (The widget mounts immediately with zeros so a slow or cold API never
  // leaves the page blank; this fills the real values in when they land.)
  function hydrateDemand(demand) {
    if (!VDP_ROOT) return;
    var w = (demand && demand.watchers) || 0;
    var wn = VDP_ROOT.getElementById("lp-wn");
    var wn2 = VDP_ROOT.getElementById("lp-wn2");
    if (wn) wn.textContent = w;
    if (wn2) wn2.textContent = w;
    var segs = VDP_ROOT.querySelectorAll(".seg");
    for (var i = 0; i < segs.length; i++) {
      segs[i].className = i < w ? (i >= 5 ? "seg on hi" : "seg on") : "seg";
    }
    if (demand && demand.daysOnLot != null) {
      var cell = VDP_ROOT.getElementById("lp-days-cell");
      var num = VDP_ROOT.getElementById("lp-days");
      if (num) num.textContent = demand.daysOnLot;
      if (cell) cell.style.display = "";
    }
  }

  // Where to drop the widget. Priority order:
  //   1. Explicit anchorSelector from config (always wins if it matches)
  //   2. Dealer Inspire's purpose-built custom-HTML CTA slots (the right rail)
  //   3. The price-box CTA container itself
  //   4. Generic price element, then H1 — last-resort fallbacks
  // We also choose whether to insert BEFORE or AFTER the anchor via data flag.
  function pickAnchor() {
    if (ANCHOR_SELECTOR) {
      var custom = document.querySelector(ANCHOR_SELECTOR);
      if (custom) return { el: custom, position: CONFIG.anchorPosition || "after", explicit: true };
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
    // Dealer.com (DDC): the VDP right rail is assembled from data-name'd page
    // sections. Confirmed identical on two live DDC rooftops (Mall of Georgia
    // CDJR and Kia Mall of Georgia). Mounting BEFORE the CTA stack rather than
    // after it: "Estimate financing" expands an inline Capital One calculator
    // (credit range, sliders, Check availability, disclosures) INSIDE that
    // same container on MAGC — mounting after it buried the widget below the
    // whole calculator there, while Kia (calculator not expanded on load)
    // looked fine with the same anchor. Anchoring above the price breakdown
    // avoids depending on how much a given store's CTA block expands to.
    // Slot directly into the DDC CTA button stack itself, between the 2nd
    // button (KBB Value Your Trade) and 3rd (Estimate financing / Capital
    // One) — confirmed via the .price-btn children of .vehicle-ctas
    // (indexed cst-btn-0/1/2...) on a live DDC rooftop. :scope keeps this to
    // DIRECT children only, so it can't grab a nested button by accident.
    var ddcCtas = document.querySelector("[data-name='vdp-vehicle-ctas-container-1'] .vehicle-ctas");
    if (ddcCtas) {
      var priceBtns = ddcCtas.querySelectorAll(":scope > [class*='price-btn']");
      if (priceBtns.length >= 2) {
        return { el: priceBtns[1], position: "after" };
      }
    }
    // Second DDC shape (confirmed on Kia Mall of Georgia): the KBB button
    // isn't a .price-btn inside .vehicle-ctas at all — it's a standalone
    // widget (data-web-api-id="kbb-leaddriver") sitting as its own stack
    // item next to Capital One's. .closest(".mb-3") grabs its stack-level
    // wrapper on either shape without assuming which one nests inside which.
    var kbbWidget = document.querySelector("[data-web-api-id='kbb-leaddriver']");
    if (kbbWidget) {
      var kbbStackItem = kbbWidget.closest(".mb-3") || kbbWidget;
      return { el: kbbStackItem, position: "after" };
    }
    var ddcSlots = [
      { sel: "[data-name='vdp-detailed-pricing-container-1']", position: "before" },
      { sel: "[data-name='vdp-vehicle-ctas-container-1']", position: "before" },
      { sel: "[data-name='vdp-sidebar-container-1']", position: "prepend" }
    ];
    for (var d = 0; d < ddcSlots.length; d++) {
      var ddcEl = document.querySelector(ddcSlots[d].sel);
      if (ddcEl) return { el: ddcEl, position: ddcSlots[d].position };
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
    var intelDays =
      '<div class="cell" id="lp-days-cell"' + (days == null ? ' style="display:none"' : '') + '>'
      + '<div class="num" id="lp-days">' + (days != null ? days : "") + '</div>'
      + '<div class="lbl">Days listed</div></div>';

    return ''
    + '<style>'
    + ':host,*{box-sizing:border-box}'
    + '.card{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
    +   'pointer-events:auto;'
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
    + '.btn:disabled{background:#C7D3EE;cursor:not-allowed;box-shadow:none}'
    + '.btn:disabled:hover{background:#C7D3EE}'
    // Explicit, unchecked-by-default consent checkbox (carrier requirement).
    // The real <input> is fully hidden (not just restyled) and a plain <span>
    // draws the visible box — appearance:none on a native checkbox isn't
    // reliably honored in every browser (privacy-hardened engines especially),
    // so this avoids depending on that entirely.
    + '.consent{display:flex;align-items:flex-start;gap:10px;margin:4px 0 14px;cursor:pointer;position:relative}'
    + '.consent input[type=checkbox]{position:absolute;left:0;top:0;width:23px;height:23px;'
    +   'margin:0;opacity:0;cursor:pointer;z-index:2}'
    + '.consent .cbx{width:23px;height:23px;flex-shrink:0;border:2.5px solid #8A93A3;border-radius:6px;'
    +   'background:#fff;box-shadow:0 1px 2px rgba(20,24,29,.08);position:relative;'
    +   'transition:background .12s,border-color .12s}'
    + '.consent input[type=checkbox]:checked + .cbx{background:#1F4FE0;border-color:#1F4FE0}'
    + '.consent input[type=checkbox]:checked + .cbx::after{content:"";position:absolute;left:6px;top:2px;'
    +   'width:6px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}'
    + '.consent label{font-size:13px;line-height:1.45;color:#3A434D;cursor:pointer}'
    + '.btn.watching{background:#1E8E5A;box-shadow:0 4px 14px rgba(30,142,90,.3)}'
    // reassurance row under button — the no-pressure promise, made loud
    + '.promise{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:11px;flex-wrap:wrap}'
    + '.promise span{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#3A434D;font-weight:600}'
    + '.promise svg{flex-shrink:0;color:#1E8E5A}'
    + '.sub{margin-top:9px;text-align:center;font-size:12px;color:#5C6670;display:none}'
    + '.brand{border-top:1px solid #EDF1F7;padding:9px 16px;text-align:center;'
    +   'font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#AEB6BF;font-weight:600}'
    // ── Wide mode ─────────────────────────────────────────────────────────────
    // Applied when the widget lands in a full-width escaped band (scroll-trap
    // themes) with room to breathe: the same elements reflow horizontally —
    // header left, stats + tach middle, CTA right — so the band is filled
    // instead of hosting a lonely vertical card. Activated at mount time when
    // the host is >= 760px wide; narrower hosts keep the vertical card.
    + '.card.wide{max-width:1100px;width:100%;display:flex;align-items:stretch}'
    + '.wide .hd{flex:0 0 240px;border-bottom:0;border-right:1px solid #EDF1F7;'
    +   'flex-direction:column;align-items:flex-start;justify-content:center;gap:10px;padding:18px;'
    +   'background:linear-gradient(135deg,#F5F8FF,#fff)}'
    + '.wide .mid{flex:1;display:flex;flex-direction:column;justify-content:center;min-width:0}'
    + '.wide .intel{border-bottom:1px solid #EDF1F7}'
    + '.wide .tachrow{padding:12px 16px 4px}'
    + '.wide .note{padding:0 16px 12px}'
    + '.wide .cta{flex:0 0 300px;display:flex;flex-direction:column;justify-content:center;'
    +   'border-left:1px solid #EDF1F7;padding:16px}'
    + '.wide .brand{display:none}'
    + '.wide-only{display:none}'
    + '.wide .wide-only{display:block;margin-top:10px;text-align:center;'
    +   'font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#AEB6BF;font-weight:600}'
    // sheet
    + '.scrim{position:fixed;inset:0;background:rgba(13,18,28,.5);opacity:0;pointer-events:none;'
    +   'transition:opacity .22s;z-index:2147483646}'
    + '.scrim.open{opacity:1;pointer-events:auto}'
    + '.sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-width:520px;margin:0 auto;pointer-events:auto;'
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
    +   '<div class="mid">'
    +   '<div class="intel">'
    +     '<div class="cell"><div class="num hot" id="lp-wn">' + watchers + '</div><div class="lbl">Watching now</div></div>'
    +     intelDays
    +   '</div>'
    +   '<div class="tachrow"><div class="tach">' + tach + '</div>'
    +     '<div class="wc"><span class="n" id="lp-wn2">' + watchers + '</span><span class="t">watching</span></div></div>'
    +   '<div class="note">Get a text the moment the price drops.</div>'
    +   '</div>'
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
    +     '<div class="wide-only">Powered by LotPulse</div>'
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
    +   '<div class="consent" id="lp-consent-row">'
    +     '<input type="checkbox" id="lp-consent">'
    +     '<span class="cbx" aria-hidden="true"></span>'
    +     '<label for="lp-consent" id="lp-consent-label"></label>'
    +   '</div>'
    +   '<button class="btn" id="lp-confirm">'
    +     '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
    +     'Start watching</button>'
    +   '<div class="fine" id="lp-fine"></div>'
    +   '<div class="fine" style="margin-top:4px">'
    +     '<a href="https://lotpulse.io/privacy.html" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">Privacy Policy</a>'
    +     ' &nbsp;·&nbsp; '
    +     '<a href="https://lotpulse.io/terms.html" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">SMS Terms</a>'
    +   '</div>'
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
    var consent = root.getElementById("lp-consent");
    var consentLabel = root.getElementById("lp-consent-label");
    var watching = false;

    // Watching this car and consenting to texts are two SEPARATE, genuinely
    // optional choices — the button below is NEVER gated by this checkbox.
    // (A2P/carrier review requires this: bundling "use the feature" with
    // "agree to be texted" is forced consent, error 30923.) Unchecked by
    // default either way, per the earlier 30925 requirement.
    consentLabel.textContent =
      "Optional: also text me when the price drops. I agree to receive automated "
      + "marketing text messages about this vehicle from this dealer at the number "
      + "above. Consent is not a condition of purchase.";
    fine.textContent = "Msg & data rates may apply. Msg frequency varies. Reply STOP to opt out, HELP for help.";

    function openSheet() {
      sheet.classList.add("open"); scrim.classList.add("open");
      // Reset every time the sheet opens — never silently pre-checked, and
      // never left disabled from a previous in-flight submission.
      consent.checked = false;
      confirm.disabled = false;
      setTimeout(function () { phone.focus(); }, 280);
    }
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
      var smsConsent = consent.checked;
      confirm.disabled = true;
      apiPost("/v1/watch", { vin: vin, phone: raw, smsConsent: smsConsent }).then(function (res) {
        confirm.disabled = false;
        if (!res.ok) {
          err.textContent = (res.json && res.json.error) || "Something went wrong. Try again.";
          err.style.display = "block";
          return;
        }
        watching = true;
        closeSheet();
        var smsEnabled = !!(res.json && res.json.smsEnabled);
        root.getElementById("lp-lbl").textContent = smsEnabled ? "Watching — we'll text you" : "Watching this car";
        btn.classList.add("watching");
        var promiseEl = root.getElementById("lp-promise");
        if (promiseEl) promiseEl.style.display = "none";
        var subEl = root.getElementById("lp-sub");
        if (subEl) {
          subEl.style.display = "block";
          subEl.textContent = smsEnabled
            ? "You're all set. Reply STOP anytime."
            : "You're all set — no texts will be sent.";
        }
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

  // ════════════════════════════════════════════════════════════════════════
  // SRP (search-results / inventory-listing) mode
  // ════════════════════════════════════════════════════════════════════════
  // Activates ONLY when boot() finds no single VDP-style VIN. Renders a small
  // "Watch" icon over each vehicle card instead of the full VDP widget, and
  // every icon shares ONE bottom sheet (rather than one sheet per card) so a
  // 30-listing page doesn't end up with 30 duplicate sheets in the DOM.
  //
  // HONEST CAVEAT: this is a v1 written without having inspected a real Big O
  // search-results page yet (same situation the VDP widget was in before we
  // saw an actual price-box layout — and that took two rounds to place
  // correctly). It anchors only to vehicles exposed via data-vin-style
  // attributes per card, because that's the only signal that also gives us a
  // DOM element to attach near. If the real SRP turns out to expose VINs only
  // via a JSON-LD ItemList with no per-card attribute, this needs a follow-up
  // pass once we see the actual markup — same as VDP's anchor logic did.
  // ════════════════════════════════════════════════════════════════════════

  // True if walking up from el reaches a <div class="hit"> ancestor — the
  // real card boundary. Used below to prefer well-anchored discoveries.
  function hasHitAncestor(el) {
    var node = el;
    for (var i = 0; i < 8 && node; i++) {
      if (node.classList && node.classList.contains("hit")) return true;
      node = node.parentElement;
    }
    return false;
  }

  function findAllVins() {
    var out = [], indexOf = {}; // vin -> index in out[]

    // Some Big O pages emit the SAME vin twice: once on a sibling wrapper
    // (data-vehicle-vin, NOT inside .hit — a bad anchor) and once as plain
    // text properly nested inside .hit (a good anchor). Whichever method
    // below runs first must not "lock in" a bad anchor and block the good
    // one from ever overriding it — so dedup by quality, not by arrival order.
    function consider(vin, el) {
      if (!vin) return;
      var verified = hasHitAncestor(el);
      if (indexOf.hasOwnProperty(vin)) {
        var idx = indexOf[vin];
        if (verified && !out[idx].verified) out[idx] = { vin: vin, el: el, verified: true };
        return;
      }
      indexOf[vin] = out.length;
      out.push({ vin: vin, el: el, verified: verified });
    }

    // Method 1: grid-view template — VIN sits in a real attribute.
    var els = document.querySelectorAll("[data-vin],[data-vehicle-vin],[itemprop='vehicleIdentificationNumber']");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var raw = el.getAttribute("data-vin") || el.getAttribute("data-vehicle-vin") ||
                el.getAttribute("content") || el.textContent;
      consider(cleanVin(raw), el);
    }
    // Method 2: Dealer Inspire's list-view template (confirmed on a real Big
    // O mobile page) prints "VIN: <vin>" as plain text inside
    // [data-testid='vin-number'] instead of an attribute. No attribute to
    // read here — pull the VIN out of the text itself.
    var vinTextEls = document.querySelectorAll("[data-testid='vin-number']");
    for (var k = 0; k < vinTextEls.length; k++) {
      var m = (vinTextEls[k].textContent || "").match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
      consider(m ? cleanVin(m[1]) : null, vinTextEls[k]);
    }
    return out;
  }

  // Walk up from a VIN's source element to find the card boundary. Dealer
  // Inspire's listing template wraps each result in <div class="hit"> —
  // confirmed against a real Big O search-results page — so prefer that.
  // Other platforms won't have it, so fall back to the generic "nearest
  // ancestor with a photo" heuristic, same proxy logic as before.
  // How many DISTINCT vehicles does this subtree describe? Counting distinct
  // VINs (not VIN-bearing elements) matters because one card often carries the
  // same VIN twice — an attribute on a wrapper and the plain text inside.
  function distinctVinCount(root) {
    if (!root || !root.querySelectorAll) return 0;
    var els = root.querySelectorAll(
      "[data-vin],[data-vehicle-vin],[itemprop='vehicleIdentificationNumber'],[data-testid='vin-number']");
    var seen = {}, n = 0;
    for (var i = 0; i < els.length; i++) {
      var raw = els[i].getAttribute("data-vin") || els[i].getAttribute("data-vehicle-vin")
              || els[i].getAttribute("content") || els[i].textContent || "";
      var m = String(raw).toUpperCase().match(/[A-HJ-NPR-Z0-9]{17}/);
      if (m && !seen[m[0]]) { seen[m[0]] = true; n++; }
    }
    return n;
  }

  function findCardContainer(el) {
    var node = el;
    for (var i = 0; i < 8 && node; i++) {
      if (node.classList && node.classList.contains("hit")) return node;
      node = node.parentElement;
    }
    // Platform-independent boundary: climb while the ancestor still describes
    // exactly ONE vehicle, and stop the level before it starts swallowing
    // sibling cards. This replaced a "nearest ancestor containing an <img>"
    // heuristic that broke on Dealer.com, where promotional banners sit inside
    // the card region — the walk latched onto the banner and parked the watch
    // icon on ad creative instead of the vehicle.
    //
    // Second-order fix: a promo tile carries ZERO vins, so it never trips the
    // distinctVinCount>1 break — the climb happily grows past the true card
    // boundary and merges in the neighboring ad tile, which is exactly what
    // put the watch icon over promotional banner content on a live DDC SRP.
    // Once a level already contains the card's own CTA stack (DDC's
    // .vehicle-ctas, or DI's per-card markers), that level structurally IS
    // the card — stop there regardless of what 0-VIN siblings sit beyond it.
    var best = el, cur = el.parentElement;
    for (var j = 0; j < 10 && cur && cur !== document.body; j++) {
      if (distinctVinCount(cur) > 1) break;
      best = cur;
      if (cur.querySelector && cur.querySelector(
        ".vehicle-ctas, [data-testid^='vehicle-cta-'], .hit-additional-ctas")) break;
      cur = cur.parentElement;
    }
    return best;
  }

  // True if an element is genuinely rendered on screen right now — not just
  // present in the DOM. display:none, visibility:hidden, or a hidden
  // ancestor all fail this. Needed because some dealer templates keep a
  // SECOND, hidden copy of the CTA stack in the DOM (for a different
  // breakpoint), and a plain querySelector can't tell the two apart.
  function isVisible(el) {
    if (!el) return false;
    var cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
  }

  // Within a card, find its native CTA button stack if it has one — Dealer
  // Inspire's is `.hit-additional-ctas`, holding "Get Your Lowest Price" /
  // "View Details" as full-width stacked buttons. Joining that stack with a
  // matching button looks native and stays compact; falling back to a
  // floating icon (below) is for templates with no such stack.
  //
  // IMPORTANT: a card can contain MORE THAN ONE element matching this
  // selector (e.g. a hidden duplicate for another breakpoint) — picking the
  // first match blindly can land our button in a container that's never
  // actually shown, which mounts cleanly with zero errors and is still
  // invisible. So this checks every match and returns the first VISIBLE one.
  function findCtaStack(cardEl) {
    // Dealer.com: confirmed via live DOM inspection that SRP cards carry the
    // same .vehicle-ctas button stack as the VDP (price-btn children). Join
    // it the same way — a real full-width button matching the surrounding
    // CTAs beats the floating icon overlay below, which exists for platforms
    // with no recognizable native stack at all.
    var ddcStack = cardEl.querySelector(".vehicle-ctas");
    if (ddcStack && isVisible(ddcStack)) return ddcStack;
    var stacks = cardEl.querySelectorAll(".hit-additional-ctas");
    for (var i = 0; i < stacks.length; i++) {
      if (isVisible(stacks[i])) return stacks[i];
    }
    var ctaEls = cardEl.querySelectorAll("[data-testid^='vehicle-cta-']");
    for (var j = 0; j < ctaEls.length; j++) {
      var parent = ctaEls[j].parentElement;
      if (parent && isVisible(parent)) return parent;
    }
    return null; // nothing usable — caller falls back to the icon overlay
  }

  var srpSheetHost = null;
  var srpActiveVin = null;

  function ensureSrpSheet() {
    if (srpSheetHost) return srpSheetHost;
    var host = document.createElement("div");
    host.id = "lotpulse-srp-sheet-host";
    document.body.appendChild(host);
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    root.innerHTML = srpSheetHtml();
    wireSrpSheet(root, host);
    srpSheetHost = host;
    return host;
  }

  function srpSheetHtml() {
    // Same visual language and consent pattern as the VDP sheet — optional,
    // unchecked-by-default checkbox that never gates the submit button.
    return ''
      + '<style>'
      + ':host,*{box-sizing:border-box}'
      + '.scrim{position:fixed;inset:0;background:rgba(13,18,28,.5);opacity:0;pointer-events:none;'
      +   'transition:opacity .22s;z-index:2147483646}'
      + '.scrim.open{opacity:1;pointer-events:auto}'
      + '.sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-width:480px;margin:0 auto;'
      +   'background:#fff;border-radius:24px 24px 0 0;padding:10px 22px 26px;'
      +   'transform:translateY(105%);transition:transform .3s cubic-bezier(.32,.72,.2,1);'
      +   'box-shadow:0 -16px 56px rgba(13,18,28,.22);'
      +   'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}'
      + '.sheet.open{transform:translateY(0)}'
      + '.grab{width:40px;height:4px;border-radius:2px;background:#E4E7E4;margin:0 auto 18px}'
      + 'h3{font-size:21px;font-weight:800;color:#14181D;margin:0 0 6px;letter-spacing:-.02em}'
      + '.psub{font-size:14px;color:#5C6670;margin:0 0 16px}'
      + '.perks{list-style:none;margin:0 0 18px;padding:0}'
      + '.perks li{display:flex;gap:11px;align-items:center;font-size:14px;color:#2A323A;padding:6px 0}'
      + '.perks .pk{width:30px;height:30px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;'
      +   'justify-content:center;background:#EAF1FF;color:#1F4FE0}'
      + '.field{display:flex;align-items:center;gap:10px;border:1.5px solid #E4E7E4;border-radius:13px;'
      +   'padding:15px;margin-bottom:12px}'
      + '.field:focus-within{border-color:#1F4FE0;box-shadow:0 0 0 4px rgba(31,79,224,.12)}'
      + '.cc{font-weight:700;color:#5C6670;font-size:15px}'
      + 'input{border:0;outline:0;flex:1;font-family:inherit;font-size:17px;font-weight:600;'
      +   'color:#14181D;background:transparent;min-width:0}'
      + '.consent{display:flex;align-items:flex-start;gap:10px;margin:4px 0 14px;cursor:pointer;position:relative}'
      + '.consent input[type=checkbox]{position:absolute;left:0;top:0;width:23px;height:23px;'
      +   'margin:0;opacity:0;cursor:pointer;z-index:2}'
      + '.consent .cbx{width:23px;height:23px;flex-shrink:0;border:2.5px solid #8A93A3;border-radius:6px;'
      +   'background:#fff;box-shadow:0 1px 2px rgba(20,24,29,.08);position:relative}'
      + '.consent input[type=checkbox]:checked + .cbx{background:#1F4FE0;border-color:#1F4FE0}'
      + '.consent input[type=checkbox]:checked + .cbx::after{content:"";position:absolute;left:6px;top:2px;'
      +   'width:6px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}'
      + '.consent label{font-size:13px;line-height:1.45;color:#3A434D;cursor:pointer}'
      + '.btn{width:100%;border:0;cursor:pointer;background:#1F4FE0;color:#fff;border-radius:13px;'
      +   'padding:16px;font-size:16px;font-weight:700;font-family:inherit}'
      + '.btn:disabled{background:#C7D3EE;cursor:not-allowed}'
      + '.fine{font-size:10.5px;line-height:1.5;color:#9AA29C;margin-top:11px}'
      + '.err{color:#DE3730;font-size:13px;font-weight:600;margin-bottom:10px;display:none}'
      + '</style>'
      + '<div class="scrim" id="s-scrim"></div>'
      + '<div class="sheet" id="s-sheet" role="dialog" aria-modal="true">'
      +   '<div class="grab"></div>'
      +   '<h3>Get a text when this price drops</h3>'
      +   '<p class="psub">Drop your number. No salesperson will ever call you.</p>'
      +   '<ul class="perks">'
      +     '<li><span class="pk"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></span>Price drops — you hear first, before the listing updates</li>'
      +     '<li><span class="pk"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></span>Demand alerts — know when others start watching</li>'
      +     '<li><span class="pk"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Sold notice — never chase a car that\'s already gone</li>'
      +   '</ul>'
      +   '<div class="err" id="s-err"></div>'
      +   '<div class="field"><span class="cc">+1</span>'
      +     '<input type="tel" inputmode="tel" placeholder="(555) 555-0134" id="s-phone" autocomplete="tel" name="tel"></div>'
      +   '<div class="consent"><input type="checkbox" id="s-consent">'
      +     '<span class="cbx" aria-hidden="true"></span>'
      +     '<label for="s-consent" id="s-consent-label"></label></div>'
      +   '<button class="btn" id="s-confirm">Start watching</button>'
      +   '<div class="fine" id="s-fine"></div>'
      +   '<div class="fine" style="margin-top:4px">'
      +     '<a href="https://lotpulse.io/privacy.html" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">Privacy Policy</a>'
      +     ' &nbsp;·&nbsp; '
      +     '<a href="https://lotpulse.io/terms.html" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">SMS Terms</a>'
      +   '</div>'
      + '</div>';
  }

  function wireSrpSheet(root, host) {
    var scrim = root.getElementById("s-scrim");
    var sheet = root.getElementById("s-sheet");
    var phone = root.getElementById("s-phone");
    var consent = root.getElementById("s-consent");
    var consentLabel = root.getElementById("s-consent-label");
    var confirm = root.getElementById("s-confirm");
    var err = root.getElementById("s-err");
    var fine = root.getElementById("s-fine");

    // Watching this car and consenting to texts are two SEPARATE, genuinely
    // optional choices — confirm is NEVER gated by this checkbox (A2P error
    // 30923, forced consent). Unchecked by default either way (30925).
    consentLabel.textContent =
      "Optional: also text me when the price drops. I agree to receive automated "
      + "marketing text messages about this vehicle from this dealer at the number "
      + "above. Consent is not a condition of purchase.";
    fine.textContent = "Msg & data rates may apply. Msg frequency varies. Reply STOP to opt out, HELP for help.";

    function open() {
      sheet.classList.add("open"); scrim.classList.add("open");
      consent.checked = false;
      confirm.disabled = false;
      err.style.display = "none"; phone.value = "";
      setTimeout(function () { phone.focus(); }, 280);
    }
    function close() { sheet.classList.remove("open"); scrim.classList.remove("open"); }
    host._lpOpen = open; // exposed so per-card icon clicks can trigger this shared sheet

    scrim.addEventListener("click", close);
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
      if (!srpActiveVin) return;
      var smsConsent = consent.checked;
      confirm.disabled = true;
      apiPost("/v1/watch", { vin: srpActiveVin, phone: raw, smsConsent: smsConsent }).then(function (res) {
        close();
        var smsEnabled = !!(res && res.json && res.json.smsEnabled);
        var el = document.querySelector('[data-lp-srp="' + srpActiveVin + '"]');
        if (el) {
          el.style.background = "#1E8E5A";
          if (el.getAttribute("data-lp-mode") === "button") {
            el.textContent = smsEnabled ? "\u2713 Watching \u2014 We'll text you" : "\u2713 Watching this car";
          } else {
            el.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" '
              + 'stroke-width="3" stroke-linecap="round" stroke-linejoin="round">'
              + '<polyline points="20 6 9 17 4 12"/></svg>';
          }
        }
      }).catch(function (e) {
        confirm.disabled = false;
        err.textContent = (e && e.message) || "Something went wrong. Try again.";
        err.style.display = "block";
      });
    });
  }

  function mountSrpButton(vin, cardEl) {
    if (cardEl.querySelector('[data-lp-srp="' + vin + '"]')) return false; // already mounted

    var stack = findCtaStack(cardEl);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-lp-srp", vin);

    if (stack) {
      // Join the card's own CTA button stack — same width/rhythm as "Get
      // Your Lowest Price" / "View Details", so it reads as part of the
      // page instead of a foreign overlay. This is the slim, compelling
      // version: one clear line, no extra height.
      btn.setAttribute("data-lp-mode", "button");
      btn.textContent = "\uD83D\uDC41 Watch \u2014 Get Price Alerts";
      btn.style.cssText =
        "display:block;width:100%;flex-shrink:0;flex-basis:auto;border:0;cursor:pointer;"
        + "background:#1F4FE0;color:#fff;"
        + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
        + "font-size:13px;font-weight:700;letter-spacing:.01em;padding:10px 12px;"
        + "border-radius:2px;margin-top:1px;transition:background .15s;";
      btn.addEventListener("mouseenter", function () { btn.style.background = "#1740B8"; });
      btn.addEventListener("mouseleave", function () { btn.style.background = "#1F4FE0"; });
      // This stack is sized by Dealer Inspire to fit exactly the 2 buttons
      // it ships with — confirmed by measuring it at ~95px tall, almost
      // exactly 2 buttons' worth. Adding a 3rd button without forcing the
      // container to grow gets silently clipped or squashed to nothing,
      // which is consistent with everything mounting correctly (per the
      // console logs) while staying invisible on screen.
      stack.style.height = "auto";
      stack.style.maxHeight = "none";
      stack.style.overflow = "visible";
      stack.appendChild(btn);
    } else {
      // No native CTA stack on this template — fall back to a small
      // floating icon over the photo rather than guessing at button styling.
      btn.setAttribute("data-lp-mode", "icon");
      btn.setAttribute("title", "Watch this car \u2014 get a text if the price drops");
      btn.style.cssText =
        "position:absolute;top:10px;right:10px;z-index:50;width:38px;height:38px;border-radius:50%;"
        + "background:rgba(20,24,29,.78);display:flex;align-items:center;justify-content:center;"
        + "cursor:pointer;backdrop-filter:blur(4px);transition:transform .12s,background .15s;padding:0;";
      btn.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" '
        + 'stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/>'
        + '<circle cx="12" cy="12" r="3"/></svg>';
      btn.addEventListener("mouseenter", function () { btn.style.transform = "scale(1.08)"; });
      btn.addEventListener("mouseleave", function () { btn.style.transform = "scale(1)"; });
      var cs = window.getComputedStyle(cardEl);
      if (cs.position === "static") cardEl.style.position = "relative";
      cardEl.appendChild(btn);
    }

    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation(); // don't follow the card's own link-through
      srpActiveVin = vin;
      var sheetHost = ensureSrpSheet();
      if (sheetHost._lpOpen) sheetHost._lpOpen();
    });
    return true;
  }

  // Reports the button's actual rendered state — removes the need to keep
  // guessing at CSS causes. Tells us in one line whether it's collapsed to
  // zero size, actively hidden via display/visibility/opacity, or visible
  // but clipped by a specific named ancestor with overflow:hidden.
  function reportGeometry(vin, btn) {
    var rect = btn.getBoundingClientRect();
    var cs = window.getComputedStyle(btn);
    var clipper = null;
    var node = btn.parentElement;
    for (var i = 0; i < 10 && node; i++) {
      var ncs = window.getComputedStyle(node);
      var nRect = node.getBoundingClientRect();
      var hidesOverflow = ncs.overflow === "hidden" || ncs.overflowY === "hidden";
      var ancestorBottom = nRect.top + nRect.height;
      var btnBottom = rect.top + rect.height;
      if (hidesOverflow && ancestorBottom < btnBottom - 1) {
        clipper = (node.className || node.tagName) + " (ancestor h=" + Math.round(nRect.height) + "px, overflow=" + ncs.overflow + ")";
        break;
      }
      node = node.parentElement;
    }
    console.log("[LotPulse] geometry for " + vin + ": "
      + "w=" + Math.round(rect.width) + " h=" + Math.round(rect.height)
      + " display=" + cs.display + " visibility=" + cs.visibility + " opacity=" + cs.opacity
      + (clipper ? " | CLIPPED BY: " + clipper : " | no clipping ancestor found in first 10 levels"));
  }

  function mountAllSrp(found) {
    found.forEach(function (entry) {
      var card = findCardContainer(entry.el);
      var hadHit = card && card.classList && card.classList.contains("hit");
      var didMount = mountSrpButton(entry.vin, card);
      if (didMount) {
        console.log("[LotPulse] mounted on " + entry.vin
          + " (card boundary: " + (hadHit ? ".hit" : "generic-fallback") + ")");
        var mountedBtn = card.querySelector('[data-lp-srp="' + entry.vin + '"]');
        if (mountedBtn) reportGeometry(entry.vin, mountedBtn);
      }
    });
  }

  // Some listing grids render cards a beat after our first check (lazy
  // load), and a single VDP never needs this, so this is bounded — same
  // ~6s safety window as the VDP anchor-wait, not an indefinite observer.
  var srpWatchStarted = false;
  function watchSrpForLateCards() {
    if (srpWatchStarted) return;
    srpWatchStarted = true;
    var tries = 0;
    var everFound = false;
    var iv = setInterval(function () {
      tries++;
      var found = findAllVins();
      if (found.length) { everFound = true; mountAllSrp(found); }
      // ~12s window — longer than the VDP anchor-wait, since listing grids
      // are more likely to lazy-load and mobile may render a beat slower.
      if (tries > 24) {
        clearInterval(iv);
        if (!everFound) {
          console.warn("[LotPulse] gave up after 12s — found 0 vehicles on this page. "
            + "Either this isn't an inventory page, or the VIN markup here doesn't "
            + "match any known pattern yet.");
        }
      }
    }, 500);
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  function boot() {
    // Check for a LISTING page (many vehicles) before a single VDP. A real
    // VDP only ever has one VIN-bearing element; a listing grid has many.
    // Checking multiplicity FIRST is the fix for a real bug: findVin()'s
    // single-result early-return was grabbing just the page's FIRST card and
    // mounting the full VDP widget into that one card's CTA slot on
    // search-results pages — because Dealer Inspire reuses the same
    // `vehicle-cta-N` naming on SRP cards that it uses on VDP price boxes.
    var initial = findAllVins();
    var ldVins = findAllJsonLdVins();
    console.log("[LotPulse] initial page scan: " + initial.length + " vehicle element(s), "
      + ldVins.length + " distinct VIN(s) in JSON-LD");
    if (initial.length >= 2 || ldVins.length >= 2) {
      console.log("[LotPulse] SRP mode active"
        + (initial.length < 2
          ? " (via JSON-LD multiplicity — cards not in the DOM yet; VDP mode suppressed so we can't mount a watch card for an arbitrary vehicle. Watching for cards to lazy-load.)"
          : ""));
      mountAllSrp(initial);
      watchSrpForLateCards();
      return;
    }

    var vin = findVin();
    if (vin) {
      console.log("[LotPulse] VDP mode active, vin=" + vin);
      // Mount IMMEDIATELY with placeholder counts — never gate rendering on
      // the API. A cold-starting or slow backend previously meant no widget
      // at all (only a console.warn), which is invisible to a normal visitor
      // and fatal to an A2P reviewer. Real numbers hydrate when the fetch
      // resolves; wireWidget shares this same object so it sees them too.
      var demand = { watchers: 0 };
      mountWhenAnchorReady(vin, demand);
      apiGet("/v1/vehicle/" + vin + "/demand").then(function (d) {
        if (d && typeof d === "object" && !d.error) {
          for (var k in d) demand[k] = d[k];
          hydrateDemand(demand);
          console.log("[LotPulse] demand hydrated: " + (demand.watchers || 0) + " watcher(s)");
        }
      }).catch(function (e) {
        console.warn("[LotPulse] demand fetch failed (widget still active):", e);
      });
      return;
    }

    // Neither matched yet — could be a slow-loading listing page whose cards
    // haven't rendered. Give it a bounded retry instead of giving up.
    console.log("[LotPulse] no VIN found yet — watching for late-loading cards");
    watchSrpForLateCards();
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
