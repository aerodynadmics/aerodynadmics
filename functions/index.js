const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { defineSecret } = require("firebase-functions/params");
const sharp = require("sharp");

admin.initializeApp({
  databaseURL: "https://aele-mock-exam-hub-default-rtdb.asia-southeast1.firebasedatabase.app",
});
const db = admin.database();

const NS = "aerodynadmics-aele";
const SITE = "https://aerodynadmics.com";
const DEFAULT_IMAGE = SITE + "/preview-v2.jpg";

// Only fetch avatar photos from Firebase Storage (never an arbitrary URL).
const AVATAR_HOSTS = new Set(["firebasestorage.googleapis.com", "storage.googleapis.com"]);

// Same rule the app uses (presenceKey): RTDB keys cannot contain . # $ [ ] /
const keyFor = (n) => String(n).replace(/[.#$\[\]/]/g, "_");
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function lookup(raw) {
  const out = { nick: raw, avatar: "", bio: "", found: false };
  if (!raw) return out;
  try {
    const db = admin.database();
    let snap = await db.ref(NS + "/nicknames/" + keyFor(raw)).get();
    if (!snap.exists() && raw !== raw.toLowerCase()) {
      snap = await db.ref(NS + "/nicknames/" + keyFor(raw.toLowerCase())).get();
    }
    const roster = snap.val();
    if (roster) {
      out.found = true;
      out.nick = roster.nickname || raw;
      out.avatar = roster.avatar || "";
      const p = (await db.ref(NS + "/profiles/" + keyFor(out.nick)).get()).val() || {};
      out.bio = p.bio || "";
    }
  } catch (e) {
    console.error("profilePreview lookup failed", e);
  }
  return out;
}

// True when the avatar is a real photo (not an emoji).
function isPhoto(avatar) {
  if (/^data:image\/(png|jpe?g|webp);base64,/i.test(avatar)) return true;
  try {
    const u = new URL(avatar);
    return u.protocol === "https:" && AVATAR_HOSTS.has(u.hostname);
  } catch (e) {
    return false;
  }
}

async function loadAvatarBuffer(avatar) {
  if (/^data:image\//i.test(avatar)) {
    const buf = Buffer.from(avatar.split(",")[1] || "", "base64");
    return buf.length > 0 && buf.length <= 3e6 ? buf : null;
  }
  const r = await fetch(avatar, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length <= 5e6 ? buf : null;
}

// Builds a 1200x630 card: blurred copy of the photo as the backdrop and the
// photo as a circle in the middle, never enlarged more than needed.
async function buildCard(buf) {
  const W = 1200, H = 630, RING = 10;
  const meta = await sharp(buf).metadata();
  const native = Math.min(meta.width || 256, meta.height || 256);
  const D = Math.max(240, Math.min(420, Math.round(native * 1.4)));
  const ringD = D + RING * 2;

  const bg = await sharp(buf)
    .resize(W, H, { fit: "cover" })
    .blur(30)
    .modulate({ brightness: 0.7 })
    .toBuffer();

  const mask = Buffer.from(
    `<svg width="${D}" height="${D}"><circle cx="${D / 2}" cy="${D / 2}" r="${D / 2}"/></svg>`);
  const face = await sharp(buf)
    .resize(D, D, { fit: "cover" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();

  const ring = Buffer.from(
    `<svg width="${ringD}" height="${ringD}"><circle cx="${ringD / 2}" cy="${ringD / 2}" r="${ringD / 2}" fill="#ffffff"/></svg>`);

  return sharp(bg)
    .composite([
      { input: ring, left: Math.round((W - ringD) / 2), top: Math.round((H - ringD) / 2) },
      { input: face, left: Math.round((W - D) / 2), top: Math.round((H - D) / 2) },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

exports.buildCard = buildCard;

exports.profilePreview = onRequest(
  { region: "asia-southeast1", memory: "512MiB", timeoutSeconds: 30 },
  async (req, res) => {
    const parts = req.path.split("/").filter(Boolean); // ["engineer", "<nick>", "card.jpg"?]
    let raw = "";
    try { raw = decodeURIComponent(parts[1] || "").trim().slice(0, 40); } catch (e) {}
    const wantsCard = parts[2] === "card.jpg";
    const info = await lookup(raw);

    // ---- /engineer/<nick>/card.jpg : the 1200x630 preview picture ----
    if (wantsCard) {
      try {
        if (info.avatar && isPhoto(info.avatar)) {
          const buf = await loadAvatarBuffer(info.avatar);
          if (buf) {
            const jpg = await buildCard(buf);
            res.set("Content-Type", "image/jpeg");
            res.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
            res.status(200).send(jpg);
            return;
          }
        }
      } catch (e) {
        console.error("card build failed", e);
      }
      res.set("Cache-Control", "public, max-age=300");
      res.redirect(302, DEFAULT_IMAGE);
      return;
    }

    // ---- /engineer/<nick> : the page Facebook/Messenger reads ----
    const nick = info.nick || "Engineer";
    const title = nick + " on aerodynadmics";
    const desc = info.bio.trim()
      ? info.bio.trim().slice(0, 180)
      : "View " + nick + "'s profile on aerodynadmics, a platform for Aeronautical Engineering students and graduates.";
    const appUrl = SITE + "/#/engineer/" + encodeURIComponent(info.nick || raw);
    const shareUrl = SITE + "/engineer/" + encodeURIComponent(info.nick || raw);

    let image = DEFAULT_IMAGE;
    if (info.avatar && isPhoto(info.avatar)) {
      // the ?v= changes whenever the avatar changes, so Facebook refetches it
      const v = crypto.createHash("sha1").update(info.avatar).digest("hex").slice(0, 10);
      image = shareUrl + "/card.jpg?v=" + v;
    }

    res.set("Cache-Control", "public, max-age=300, s-maxage=300");
    res.status(200).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:site_name" content="aerodynadmics">
<meta property="og:type" content="profile">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:url" content="${esc(shareUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${esc(appUrl)}">
</head><body><script>location.replace(${JSON.stringify(appUrl).replace(/</g, "\\u003c")});</script>
<a href="${esc(appUrl)}">Open profile</a></body></html>`);
  }
);


// =====================================================================
// Wings checkout (PayMongo). Both functions stay in us-central1 (the default
// region) so their URLs do not change.
// =====================================================================
const PAYMONGO_SECRET_KEY = defineSecret("PAYMONGO_SECRET_KEY");
const PAYMONGO_WEBHOOK_SECRET = defineSecret("PAYMONGO_WEBHOOK_SECRET");

// Everything the app stores lives under NS (same as nsRef() in the page), so
// pending purchases, wallets and transactions must be read/written there too.
const nsRef = (path) => db.ref(NS + "/" + path);

// Mirror of WINGS_PACKS in the page, kept server-side on purpose: never trust
// a price sent up from the browser. Update both if you change a pack.
const WINGS_PACKS = {
  pack1: { wings: 100, price: 39 },
  pack2: { wings: 200, price: 59 },
  pack3: { wings: 500, price: 109 },
  pack4: { wings: 1000, price: 199 },
  pack5: { wings: 5000, price: 899 },
};

const ALLOWED_ORIGINS = ["https://aerodynadmics.com"];

// v2 is tried first (PayMongo documents both). If it ever answers with a
// non-JSON page, v1 is tried before giving up.
const PAYMONGO_CHECKOUT_URLS = [
  "https://api.paymongo.com/v2/checkout_sessions",
  "https://api.paymongo.com/v1/checkout_sessions",
];

function setCors(req, res) {
  const origin = req.get("origin");
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

const createWingsCheckoutHandler = async (req, res) => {
    setCors(req, res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

    const origin = req.get("origin") || req.get("referer") || "";
    if (!ALLOWED_ORIGINS.some((allowed) => origin.startsWith(allowed))) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }

    const { nickname, packId } = req.body || {};
    const pack = WINGS_PACKS[packId];
    if (!nickname || typeof nickname !== "string" || !pack) {
      res.status(400).json({ error: "Invalid nickname or packId" });
      return;
    }

    try {
      // Unique token = PayMongo reference_number; the webhook uses it to find
      // who to credit without trusting the browser.
      const pendingRef = nsRef("pendingWingsPurchases").push();
      const token = pendingRef.key;

      const payload = JSON.stringify({
        data: {
          attributes: {
            line_items: [
              {
                name: pack.wings.toLocaleString("en-US") + " Wings top-up",
                amount: pack.price * 100, // centavos
                currency: "PHP",
                quantity: 1,
              },
            ],
            payment_method_types: ["gcash", "card", "paymaya", "qrph"],
            success_url: origin,
            cancel_url: origin,
            reference_number: token,
            description: pack.wings + " Wings for " + nickname,
          },
        },
      });
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "aerodynadmics-wings/1.0",
        Authorization: "Basic " + Buffer.from(PAYMONGO_SECRET_KEY.value().trim() + ":").toString("base64"),
      };

      let paymongoRes = null;
      let paymongoData = null;
      for (const url of PAYMONGO_CHECKOUT_URLS) {
        const r = await fetch(url, { method: "POST", headers, body: payload });
        const raw = await r.text();
        try {
          paymongoData = JSON.parse(raw);
          paymongoRes = r;
          break;
        } catch (e) {
          // This is the line to read in the logs if checkout fails again.
          console.error("PayMongo non-JSON response", url, r.status, raw.slice(0, 2000));
        }
      }

      if (!paymongoRes) {
        res.status(502).json({ error: "Payment provider unavailable" });
        return;
      }
      if (!paymongoRes.ok) {
        console.error("PayMongo checkout session error:", paymongoRes.status, JSON.stringify(paymongoData));
        res.status(502).json({ error: "Could not create checkout session" });
        return;
      }

      const session = paymongoData.data;
      await pendingRef.set({
        nickname,
        packId,
        wings: pack.wings,
        price: pack.price,
        status: "pending",
        checkoutSessionId: session.id,
        createdAt: admin.database.ServerValue.TIMESTAMP,
      });

      res.status(200).json({ checkoutUrl: session.attributes.checkout_url, token });
    } catch (err) {
      console.error("createWingsCheckout error:", err);
      res.status(500).json({ error: "Internal error" });
    }
};

// Original (us-central1) and a second copy in Singapore. PayMongo's CDN blocks
// some Google Cloud addresses; the Singapore copy uses different ones.
exports.createWingsCheckout = onRequest({ secrets: [PAYMONGO_SECRET_KEY] }, createWingsCheckoutHandler);
exports.createWingsCheckoutSG = onRequest(
  { region: "asia-southeast1", secrets: [PAYMONGO_SECRET_KEY] },
  createWingsCheckoutHandler
);

// PayMongo webhook (event: checkout_session.payment.paid). Needs the RAW body
// for signature checking. Protected by the HMAC signature, not by origin.
exports.paymongoWebhook = onRequest(
  { secrets: [PAYMONGO_WEBHOOK_SECRET] },
  async (req, res) => {
    const signatureHeader = req.get("Paymongo-Signature") || "";
    const rawBody = req.rawBody ? req.rawBody.toString("utf8") : "";

    // t=<timestamp>,te=<test signature>,li=<live signature>
    const parts = {};
    signatureHeader.split(",").forEach((kv) => {
      const [k, v] = kv.split("=");
      if (k && v) parts[k.trim()] = v.trim();
    });

    if (!parts.t || (!parts.te && !parts.li)) {
      res.status(400).send("Missing signature");
      return;
    }

    const expected = crypto
      .createHmac("sha256", PAYMONGO_WEBHOOK_SECRET.value().trim())
      .update(parts.t + "." + rawBody)
      .digest("hex");

    const candidate = parts.li || parts.te;
    const isValid =
      candidate &&
      candidate.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));

    if (!isValid) {
      console.warn("PayMongo webhook signature mismatch");
      res.status(400).send("Invalid signature");
      return;
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (err) {
      res.status(400).send("Bad JSON");
      return;
    }

    const evAttrs = event && event.data && event.data.attributes;
    const eventType = evAttrs && evAttrs.type;
    const sessionAttrs = (evAttrs && evAttrs.data && evAttrs.data.attributes) || evAttrs;
    const referenceNumber = sessionAttrs && sessionAttrs.reference_number;

    if (eventType === "checkout_session.payment.paid" && referenceNumber) {
      try {
        const pendingRef = nsRef("pendingWingsPurchases/" + referenceNumber);
        const pending = (await pendingRef.once("value")).val();

        // Guards against double-crediting if PayMongo retries the event.
        if (pending && pending.status === "pending") {
          await nsRef("wallets/" + keyFor(pending.nickname) + "/wings")
            .transaction((current) => (current || 0) + pending.wings);
          await pendingRef.update({ status: "paid", paidAt: admin.database.ServerValue.TIMESTAMP });

          await nsRef("transactions/" + keyFor(pending.nickname)).push({
            note: "Bought " + pending.wings.toLocaleString("en-US") + " Wings pack (\u20b1" + pending.price + ")",
            amount: pending.wings,
            ts: admin.database.ServerValue.TIMESTAMP,
          });
        }
      } catch (err) {
        console.error("Error crediting wings from webhook:", err);
        res.status(500).send("Error processing event");
        return;
      }
    }

    res.status(200).json({ received: true });
  }
);
