const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://aele-mock-exam-hub-default-rtdb.asia-southeast1.firebasedatabase.app",
});

const NS = "aerodynadmics-aele";
const SITE = "https://aerodynadmics.com";
const DEFAULT_IMAGE = SITE + "/preview-v2.jpg";

// Same rule the app uses (presenceKey): RTDB keys cannot contain . # $ [ ] /
const keyFor = (n) => String(n).replace(/[.#$\[\]/]/g, "_");
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

exports.profilePreview = onRequest({ region: "asia-southeast1" }, async (req, res) => {
  let raw = "";
  try { raw = decodeURIComponent((req.path.split("/")[2] || "").trim()); } catch (e) {}
  raw = raw.slice(0, 40);

  let nick = raw, avatar = "", bio = "";
  try {
    if (raw) {
      const db = admin.database();
      let snap = await db.ref(NS + "/nicknames/" + keyFor(raw)).get();
      if (!snap.exists() && raw !== raw.toLowerCase()) {
        snap = await db.ref(NS + "/nicknames/" + keyFor(raw.toLowerCase())).get();
      }
      const roster = snap.val();
      if (roster) {
        nick = roster.nickname || raw;
        avatar = roster.avatar || "";
        const p = (await db.ref(NS + "/profiles/" + keyFor(nick)).get()).val() || {};
        bio = p.bio || "";
      }
    }
  } catch (e) {
    console.error("profilePreview lookup failed", e);
  }

  // Avatars are emoji by default. Only a real https image can be an og:image.
  const image = /^https:\/\//.test(avatar) ? avatar : DEFAULT_IMAGE;
  const title = (nick || "Engineer") + " on aerodynadmics";
  const desc = bio.trim()
    ? bio.trim().slice(0, 180)
    : "View " + (nick || "this engineer") + "'s profile on aerodynadmics, a platform for Aeronautical Engineering students and graduates.";
  const appUrl = SITE + "/#/engineer/" + encodeURIComponent(nick || raw);
  const shareUrl = SITE + "/u/" + encodeURIComponent(nick || raw);

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
<meta property="og:url" content="${esc(shareUrl)}">
<meta name="twitter:card" content="${image === DEFAULT_IMAGE ? "summary_large_image" : "summary"}">
<meta http-equiv="refresh" content="0;url=${esc(appUrl)}">
</head><body><script>location.replace(${JSON.stringify(appUrl).replace(/</g, "\\u003c")});</script>
<a href="${esc(appUrl)}">Open profile</a></body></html>`);
});
