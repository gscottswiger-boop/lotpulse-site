# LotPulse — Hosting & GTM Deploy Guide

This bundle contains two things that go on the web:

```
index.html            → the dealer dashboard (becomes your dashboard URL)
lotpulse-widget.js    → the shopper widget (loaded by the GTM tag)
GTM-TAG.html          → the snippet to paste into Big O's Google Tag Manager
```

You'll host `index.html` + `lotpulse-widget.js` on a Render Static Site, then
point Big O's GTM at the widget. Two parts below.

---

## PART 1 — Host the dashboard + widget (Render Static Site)

This puts the dashboard on a real URL AND makes the widget file reachable for GTM.

1. Put these two files in a GitHub repo. Easiest: create a new repo called
   `lotpulse-site` and upload `index.html` and `lotpulse-widget.js` to its root.
   (Or add a `/site` folder to your existing repo — either works.)

2. In Render: **New +** → **Static Site** → connect that repo.
   - **Publish directory:** leave blank (or `.` ) since the files are at the root
   - No build command needed
   - Click **Create Static Site**

3. Render gives you a URL like `https://lotpulse-site-xxxx.onrender.com`.
   - The **dashboard** is at that URL directly (it serves index.html)
   - The **widget** is at `https://lotpulse-site-xxxx.onrender.com/lotpulse-widget.js`

4. Test the dashboard: open the Render URL on your phone. You should see Big O's
   live demand board. That's your shareable dashboard link.

> Note: the dashboard is public to anyone with the link. Fine for a pilot demo.
> If you want it gated later, we can add a simple access code.

---

## PART 2 — Put the widget on a Big O test page (GTM)

The widget detects the VIN on a vehicle detail page (VDP), calls your API, and
renders the Watch button. We deploy it carefully: test-only trigger first,
GTM Preview mode before publishing, never publish-first.

### Step 1 — Update the tag snippet
Open `GTM-TAG.html`. On the second `<script>` line, replace
`YOUR-STATIC-SITE.onrender.com` with your real Render static site URL from Part 1.
The apiBase and publicKey are already correct for Big O.

### Step 2 — Create the tag in GTM
In Big O's GTM container:
1. **Tags** → **New** → **Tag Configuration** → **Custom HTML**
2. Paste the (updated) contents of `GTM-TAG.html`
3. Name it `LotPulse Widget`

### Step 3 — Create a TEST-ONLY trigger
This is the safety step — the widget only appears when YOU add a test parameter,
so no real shopper sees it during testing.

1. **Triggering** → **New** → **Page View** (use "DOM Ready" type if available)
2. Set it to fire on **Some Page Views**
3. Condition: **Page URL** → **contains** → `lotpulse=test`
4. Name it `VDP Test — lotpulse param`
5. Attach it to the `LotPulse Widget` tag, Save

Now the widget only loads when a URL has `?lotpulse=test` in it.

### Step 4 — Test in GTM Preview (nothing goes public yet)
1. In GTM, click **Preview** (top right)
2. Enter a real Big O VDP URL, but add the test parameter, e.g.
   `https://www.bigododge.com/inventory/some-vehicle/?lotpulse=test`
3. The site opens with your unpublished tag active, visible only to you
4. Confirm:
   - The Watch widget appears on the page
   - The watcher count loads (0 for a fresh VIN)
   - Tapping Watch + a TEST phone number works
   - The watch shows up in your dashboard
   (Texts won't send until A2P is approved — expected.)

### Step 5 — Verify VIN detection
If the widget appears but shows no data, the VIN may not have been detected on
Big O's real page structure. Open the browser console (F12) and look for
`[LotPulse]` messages. If VIN detection fails, send me a screenshot of the VDP's
page source (or just tell me) and I'll adjust the detection for Dealer Inspire's
exact markup.

### Step 6 — Go live (only when ready)
Once preview testing passes AND A2P is approved:
- You can publish the GTM container with the test-param trigger still in place
  (controlled rollout), OR
- Switch the trigger to fire on all VDP pages for the full pilot.

Until A2P clears, keep it on the test parameter so no real phone numbers are
captured that you can't yet text.

---

## Quick reference

| Thing | URL |
|-------|-----|
| API | https://lotpulse-q249.onrender.com |
| Dashboard | https://YOUR-STATIC-SITE.onrender.com |
| Widget file | https://YOUR-STATIC-SITE.onrender.com/lotpulse-widget.js |
| Big O public key | 8e85ffebcf92f4d24ae834f1 |
| Test parameter | ?lotpulse=test |
