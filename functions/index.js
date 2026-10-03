const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const sharp = require("sharp");

admin.initializeApp({
  databaseURL: "https://aele-mock-exam-hub-default-rtdb.asia-southeast1.firebasedatabase.app",
});

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
