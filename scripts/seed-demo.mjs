#!/usr/bin/env node
/**
 * Fill a LOCAL MuMu API with demo people, businesses, friendships, posts (with
 * photos), comments, reactions and chats — through the API, like real users.
 * crypt-iam is simulated: the realm secret and each user's permissions are
 * written to the local Redis and JWTs are signed here. Never use on live infra.
 *
 *   set -a; . ./.env.demo; set +a      # local DB + local Redis (refuses anything else)
 *   RESET_DB=true pnpm dev &           # empty API on $PORT
 *   node scripts/seed-demo.mjs         # → prints sign-in sessions for the web app
 *
 * Writes demo-sessions.json next to this script (gitignored): paste a session into
 * the web app's localStorage key "mu.session" to sign in as that person.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");
const { createClient } = require("redis");

const DIR = path.dirname(fileURLToPath(import.meta.url));
const API = `http://localhost:${process.env.PORT ?? 4101}`;
const LOCAL = ["127.0.0.1", "localhost", "::1"];
for (const [name, url] of [["DATABASE_URL", process.env.DATABASE_URL], ["IAM_REDIS_URL", process.env.IAM_REDIS_URL]]) {
  if (!url || !LOCAL.includes(new URL(url).hostname)) throw new Error(`${name} must point at local infra (source .env.demo first)`);
}

const REALM_ID = "demo-realm";
const REALM_SECRET = "demo-realm-secret";
const CLIENT = (process.env.IAM_CLIENT_ID ?? "mu").toUpperCase();
const matrix = JSON.parse(fs.readFileSync(path.join(DIR, "role-matrix.json"), "utf8"));
const ACTIONS = ["CREATE", "READ", "READ_ALL", "UPDATE", "DELETE"];
const grants = (role) => Object.entries(matrix[role]).flatMap(([res, a]) => (a === "*" ? ACTIONS : a).map((x) => `${CLIENT}:${res}:${x}:API_ENDPOINT`));

const redis = createClient({ url: process.env.IAM_REDIS_URL });
await redis.connect();
await redis.set(`realm:${REALM_ID}:secret`, JSON.stringify(REALM_SECRET));

// ── tiny PNG encoder (diagonal gradient + soft circles) ─────────────────────
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function png(w, h, from, to, dots = 3) {
  const [a, b] = [hex(from), hex(to)];
  const circles = Array.from({ length: dots }, (_, i) => ({ x: ((i * 0.37 + 0.2) % 1) * w, y: ((i * 0.61 + 0.3) % 1) * h, r: (0.12 + (i % 3) * 0.07) * Math.min(w, h) }));
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      let px = a.map((v, i) => v + (b[i] - v) * t);
      for (const c of circles) if ((x - c.x) ** 2 + (y - c.y) ** 2 < c.r ** 2) px = px.map((v) => v + (255 - v) * 0.22);
      raw.set(px.map(Math.round), y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function call(user, method, url, body, as) {
  const headers = { authorization: `Bearer ${user.token}`, ...(as && { "x-profile-id": as }) };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(API + url, { method, headers, body: payload });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} as ${user.handle} → ${res.status} ${json?.message} ${JSON.stringify(json?.errors ?? "")}`);
  return json?.data;
}

async function person(userId, email, name, role = "USER") {
  await redis.set(`user:${userId}:permissions`, JSON.stringify({ userId, permissions: grants(role) }));
  const token = jwt.sign({ userId, email, realmId: REALM_ID, sessionId: `demo-${userId}` }, REALM_SECRET, { algorithm: "HS256", expiresIn: "30d" });
  const u = { userId, email, name, token };
  const me = await call(u, "GET", "/api/me");
  u.profileId = me.profiles[0].profileId;
  u.handle = me.profiles[0].handle;
  await call(u, "PATCH", `/api/profiles/${u.profileId}`, { displayName: name });
  return u;
}

async function upload(user, buf, as) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "image/png" }), "photo.png");
  return (await call(user, "POST", "/api/media", form, as)).mediaId;
}
const post = (u, text, opts = {}) => call(u, "POST", "/api/posts", { text, audience: opts.audience ?? "PUBLIC", mediaId: opts.mediaId }, opts.as);
const msg = (u, conversationId, text, opts = {}) => call(u, "POST", `/api/conversations/${conversationId}/messages`, { text, ...opts.extra }, opts.as);

// ── People & businesses ─────────────────────────────────────────────────────
console.log(`Seeding ${API} …`);
const ayesha = await person("demo-ayesha", "ayesha@demo.mu", "Ayesha Rahman");
const rafi = await person("demo-rafi", "rafi@demo.mu", "Rafi Hasan");
const nadia = await person("demo-nadia", "nadia@demo.mu", "Nadia Islam");
const tanvir = await person("demo-tanvir", "tanvir@demo.mu", "Tanvir Ahmed");
const mim = await person("demo-mim", "mim@demo.mu", "Mim Chowdhury");
const sara = await person("demo-sara", "sara.mod@demo.mu", "Sara (Moderator)", "MANAGER");

for (const [u, from, to, bio] of [
  [ayesha, "#00a8ff", "#9c88ff", "Product designer · coffee & sketchbooks ☕"],
  [rafi, "#fbc531", "#e84118", "Running Dhaka Bites 🍜 · weekend cyclist"],
  [nadia, "#4cd137", "#0097e6", "Founder @pixelstudio · type nerd"],
  [tanvir, "#487eb0", "#192a56", "Engineer. Photos of streets and skies."],
  [mim, "#9c88ff", "#e84118", "Student · books · cats"],
]) {
  const avatarMediaId = await upload(u, png(256, 256, from, to, 2));
  await call(u, "PATCH", `/api/profiles/${u.profileId}`, { bio, avatarMediaId });
}

const bites = await call(rafi, "POST", "/api/profiles", { handle: "dhakabites", displayName: "Dhaka Bites", category: "Restaurant", bio: "Street food, done right. Open 11am–11pm, delivery across Dhaka.", website: "https://dhakabites.example" });
await call(rafi, "PATCH", `/api/profiles/${bites.profileId}`, { avatarMediaId: await upload(rafi, png(256, 256, "#e84118", "#fbc531", 3), bites.profileId), coverMediaId: await upload(rafi, png(900, 300, "#fbc531", "#e84118", 5), bites.profileId) });
await call(rafi, "POST", `/api/profiles/${bites.profileId}/members`, { handle: ayesha.handle, role: "EDITOR" });

const studio = await call(nadia, "POST", "/api/profiles", { handle: "pixelstudio", displayName: "Pixel Studio", category: "Design agency", bio: "Brand identity & product design for bold teams." });
await call(nadia, "PATCH", `/api/profiles/${studio.profileId}`, { avatarMediaId: await upload(nadia, png(256, 256, "#192a56", "#00a8ff", 2), studio.profileId) });

// ── Connections ─────────────────────────────────────────────────────────────
const friends = async (a, b) => {
  await call(a, "POST", `/api/connections/friends/${b.profileId}`);
  await call(b, "POST", `/api/connections/friends/${a.profileId}/accept`);
};
await friends(ayesha, rafi);
await friends(ayesha, nadia);
await friends(rafi, tanvir);
await friends(nadia, tanvir);
await call(mim, "POST", `/api/connections/friends/${ayesha.profileId}`); // pending for Ayesha
for (const u of [ayesha, tanvir, mim, nadia]) await call(u, "POST", `/api/connections/follows/${bites.profileId}`);
for (const u of [ayesha, tanvir]) await call(u, "POST", `/api/connections/follows/${studio.profileId}`);

// ── Posts ───────────────────────────────────────────────────────────────────
const p1 = await post(ayesha, "Sunday sketches at the lake. The light at 5pm is unreal 🌅", { mediaId: await upload(ayesha, png(800, 600, "#fbc531", "#9c88ff", 4)) });
const p2 = await post(rafi, "New on the menu: smoky beef chui jhal 🌶️ First 50 orders today get free borhani!", { as: bites.profileId, mediaId: await upload(rafi, png(800, 800, "#e84118", "#fbc531", 3), bites.profileId) });
const p3 = await post(nadia, "Hiring: a junior product designer who loves type and grids. DM @pixelstudio ✨", { as: studio.profileId });
const p4 = await post(tanvir, "Rain over Hatirjheel, shot on my phone.", { mediaId: await upload(tanvir, png(900, 600, "#487eb0", "#192a56", 6)) });
const p5 = await post(ayesha, "Friends only: who's in for the trip to Sreemangal next month? 🍃", { audience: "CONNECTIONS" });
const p6 = await post(rafi, "Followers only — secret menu password this week is 'mango' 🥭", { as: bites.profileId, audience: "CONNECTIONS" });
await post(mim, "Finished 'Pather Panchali' today. What should I read next? 📚");
await post(nadia, "Note to self: kern the logo again tomorrow.", { audience: "ONLY_ME" });

for (const [u, p, type] of [[rafi, p1, "LOVE"], [nadia, p1, "LIKE"], [tanvir, p1, "WOW"], [ayesha, p2, "LOVE"], [tanvir, p2, "LIKE"], [mim, p2, "HAHA"], [ayesha, p4, "LIKE"], [nadia, p4, "LOVE"], [rafi, p5, "LIKE"]]) {
  await call(u, "PUT", `/api/posts/${p.postId}/reactions`, { type });
}
const c1 = await call(rafi, "POST", `/api/posts/${p1.postId}/comments`, { text: "Gorgeous colours! Frame this one." });
await call(ayesha, "POST", `/api/posts/${p1.postId}/comments`, { text: "Thank you 🥹 maybe I will!", parentId: c1.commentId });
await call(tanvir, "POST", `/api/posts/${p2.postId}/comments`, { text: "Ordering right now 😋" });
await call(nadia, "POST", `/api/posts/${p5.postId}/comments`, { text: "Count me in!" });
await call(ayesha, "POST", `/api/posts/${p3.postId}/comments`, { text: "Sharing with my old classmates 🙌" });

// ── Chats ───────────────────────────────────────────────────────────────────
const dm = await call(ayesha, "POST", "/api/conversations/direct", { profileId: rafi.profileId });
const hi = await msg(ayesha, dm.conversationId, "Hey Rafi! Are you coming to the design meetup on Thursday?");
await msg(rafi, dm.conversationId, "Yes! Can I bring some samosas for everyone? 😄");
await msg(ayesha, dm.conversationId, "Haha absolutely, people will love you forever", { extra: { replyToId: hi.messageId } });
await msg(rafi, dm.conversationId, "Here's the new menu card I made", { extra: { mediaId: await upload(rafi, png(600, 800, "#fbc531", "#e84118", 3)) } });
await call(ayesha, "POST", `/api/conversations/${dm.conversationId}/read`, {});
await msg(rafi, dm.conversationId, "Thoughts? Be honest 🙏");

const group = await call(ayesha, "POST", "/api/conversations/group", { title: "Sreemangal trip 🍃", memberIds: [rafi.profileId, nadia.profileId, tanvir.profileId] });
await msg(ayesha, group.conversationId, "Okay team — dates? I'm free 14–16th.");
await msg(nadia, group.conversationId, "14–16 works for me!");
await msg(tanvir, group.conversationId, "Same. I'll book the bungalow 🏡");
await msg(rafi, group.conversationId, "I'll bring food, obviously.");

const shop = await call(tanvir, "POST", "/api/conversations/direct", { profileId: bites.profileId });
await msg(tanvir, shop.conversationId, "Hi! Do you deliver to Gulshan 2?");
await msg(rafi, shop.conversationId, "Hi Tanvir! Yes — 30–40 minutes to Gulshan 2. Free delivery over ৳800 🛵", { as: bites.profileId });
await msg(tanvir, shop.conversationId, "Perfect, ordering now!");

const dm2 = await call(nadia, "POST", "/api/conversations/direct", { profileId: ayesha.profileId });
await msg(nadia, dm2.conversationId, "Loved your lake sketch! Want to do a collab poster for the studio?");

// ── Moderation queue ────────────────────────────────────────────────────────
await call(mim, "POST", "/api/reports", { targetType: "POST", targetId: p4.postId, reason: "Testing the report flow" });

// ── Sessions for the web app ────────────────────────────────────────────────
const sessions = Object.fromEntries(
  [ayesha, rafi, nadia, tanvir, mim, sara].map((u) => [
    u.handle,
    { accessToken: u.token, refreshToken: "demo", user: { userId: u.userId, email: u.email, name: u.name, isEmailVerified: true } },
  ]),
);
fs.writeFileSync(path.join(DIR, "demo-sessions.json"), JSON.stringify(sessions, null, 2));
console.log(`✔ Seeded. Sessions for: ${Object.keys(sessions).join(", ")} → scripts/demo-sessions.json`);
console.log(`  In the web app's devtools: localStorage.setItem("mu.session", JSON.stringify(<session>)); location.reload()`);
await redis.quit();
