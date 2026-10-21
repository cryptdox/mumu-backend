/**
 * End-to-end API tests over HTTP + socket.io against LOCAL throwaway infra
 * (.env.test: docker Postgres "mu_test", docker Redis db 2, local image storage,
 * a fake MUMU RTC token server). crypt-iam is simulated by writing the realm
 * secret and permission profile it would cache into the test Redis.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { io as ioClient, type Socket } from "socket.io-client";

const dbUrl = new URL(process.env.DATABASE_URL ?? "");
const redisUrl = new URL(process.env.IAM_REDIS_URL ?? "");
const LOCAL = ["127.0.0.1", "localhost", "::1"];
// The suite wipes every table — refuse to run anywhere but local infra.
if (!LOCAL.includes(dbUrl.hostname) || !LOCAL.includes(redisUrl.hostname)) {
  throw new Error(`Tests must run against local infra (db=${dbUrl.hostname}, redis=${redisUrl.hostname}). Use .env.test.`);
}

import app from "../src/app";
import prisma from "../src/prisma/client";
import iamRedis, { ConnectIamRedis } from "../src/utils/iam.redis";
import { wipeAllTables } from "../src/utils/bootstrap";
import { attachRealtime, closeRealtime } from "../src/realtime/socket";
import { sweepCalls } from "../src/modules/call/call.service";
import { IAM_CLIENT_ID } from "../src/utils/consts";

const matrix = JSON.parse(fs.readFileSync(path.join(__dirname, "../scripts/role-matrix.json"), "utf8"));
const ACTIONS = ["CREATE", "READ", "READ_ALL", "UPDATE", "DELETE"];
const grantsOf = (role: string) =>
  Object.entries(matrix[role] as Record<string, string | string[]>).flatMap(([res, a]) => (a === "*" ? ACTIONS : a).map((x) => `${res}:${x}`));

const REALM_ID = "test-realm";
const REALM_SECRET = "test-realm-secret";

let server: Server;
let base: string;
let rtcServer: Server;
let rtcMode: "ok" | "quota" = "ok";
const rtcCalls: any[] = [];
const sockets: Socket[] = [];

type User = { token: string; userId: string; personalId: string; handle: string };

/** Sign in like crypt-iam would: cache realm secret + permissions, sign a JWT. */
async function login(userId: string, role = "USER", extra: string[] = []): Promise<User> {
  const permissions = [...grantsOf(role), ...extra].map((g) => `${IAM_CLIENT_ID.toUpperCase()}:${g}:API_ENDPOINT`);
  await iamRedis.set(`realm:${REALM_ID}:secret`, JSON.stringify(REALM_SECRET));
  await iamRedis.set(`user:${userId}:permissions`, JSON.stringify({ userId, permissions }));
  const token = jwt.sign({ userId, email: `${userId}@test.local`, realmId: REALM_ID, sessionId: `s-${userId}` }, REALM_SECRET, { algorithm: "HS256", expiresIn: "1h" });
  const me = await api("GET", "/api/me", { token });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  const personal = me.body.data.profiles.find((p: any) => p.kind === "PERSONAL");
  return { token, userId, personalId: personal.profileId, handle: personal.handle };
}

async function api(method: string, url: string, opts: { token?: string; body?: unknown; as?: string; form?: FormData; device?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.device) headers["x-device-id"] = opts.device;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.as) headers["x-profile-id"] = opts.as;
  let body: any;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(base + url, { method, headers, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const ok = (r: { status: number; body: any }, status = 200) => {
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data;
};

function connect(user: User): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { auth: { token: user.token }, transports: ["websocket"], forceNew: true });
    sockets.push(s);
    s.once("connect", () => resolve(s));
    s.once("connect_error", reject);
  });
}

function next(socket: Socket, event: string, filter: (p: any) => boolean = () => true, ms = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`no "${event}" within ${ms} ms`));
    }, ms);
    const handler = (p: any) => {
      if (!filter(p)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(p);
    };
    socket.on(event, handler);
  });
}

// A real 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
function imageForm(buf: Buffer, name = "a.png", type = "image/png") {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type }), name);
  return form;
}

before(async () => {
  await ConnectIamRedis();
  await iamRedis.flushDb();
  await wipeAllTables();

  // Fake MUMU RTC: POST /api/server/token
  rtcServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      rtcCalls.push({ key: req.headers["x-api-key"], ...body });
      res.setHeader("content-type", "application/json");
      if (rtcMode === "quota") {
        res.statusCode = 402;
        return res.end(JSON.stringify({ success: false, message: "Monthly minutes used up", errors: { code: "QUOTA_EXCEEDED" } }));
      }
      res.end(JSON.stringify({ success: true, data: { token: `rtc.${body.channelName}.${body.role}.${body.externalUserId}`, expiresAt: new Date(Date.now() + 3600e3).toISOString() } }));
    });
  });
  await new Promise<void>((r) => rtcServer.listen(Number(new URL(process.env.MUMU_RTC_URL!).port), "127.0.0.1", r));

  server = http.createServer(app);
  attachRealtime(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const s of sockets) s.disconnect();
  await closeRealtime();
  await new Promise((r) => server.close(r));
  await new Promise((r) => rtcServer.close(r));
  await prisma.$disconnect();
  await iamRedis.quit();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("auth & profiles", () => {
  test("no token → 401; bad token → 401; another client's permissions don't count", async () => {
    assert.equal((await api("GET", "/api/me")).status, 401);
    assert.equal((await api("GET", "/api/me", { token: "x.y.z" })).status, 401);

    await iamRedis.set(`realm:${REALM_ID}:secret`, JSON.stringify(REALM_SECRET));
    await iamRedis.set(`user:outsider:permissions`, JSON.stringify({ permissions: ["MUMU-RTC:MU_POST:READ:API_ENDPOINT"] }));
    const token = jwt.sign({ userId: "outsider", email: "o@test.local", realmId: REALM_ID }, REALM_SECRET, { algorithm: "HS256" });
    assert.equal((await api("GET", "/api/posts/feed", { token })).status, 403);
  });

  test("first sign-in creates one personal profile; handle from the email", async () => {
    const a = await login("alice");
    const again = ok(await api("GET", "/api/me", { token: a.token }));
    assert.equal(again.profiles.length, 1);
    assert.equal(a.handle, "alice");
    // A second account whose email maps to the same handle gets a suffix.
    await iamRedis.set(`user:alice2:permissions`, JSON.stringify({ permissions: grantsOf("USER").map((g) => `MU:${g}:API_ENDPOINT`) }));
    const token = jwt.sign({ userId: "alice2", email: "alice@other.test", realmId: REALM_ID }, REALM_SECRET, { algorithm: "HS256" });
    const other = ok(await api("GET", "/api/me", { token }));
    assert.match(other.profiles[0].handle, /^alice\d+$/);
  });

  test("business profiles: create, act as with x-profile-id, members, can't act as others'", async () => {
    const bob = await login("bob");
    const carol = await login("carol");
    const shop = ok(await api("POST", "/api/profiles", { token: bob.token, body: { handle: "Bobs.Bakery", displayName: "Bob's Bakery", category: "Bakery" } }), 201);
    assert.equal(shop.handle, "bobs.bakery");
    assert.equal(shop.kind, "BUSINESS");
    assert.equal((await api("POST", "/api/profiles", { token: carol.token, body: { handle: "bobs.bakery", displayName: "x" } })).status, 409);
    assert.equal((await api("POST", "/api/profiles", { token: carol.token, body: { handle: "admin", displayName: "x" } })).status, 400);

    assert.equal((await api("GET", "/api/posts/feed", { token: carol.token, as: shop.profileId })).status, 403);
    ok(await api("POST", `/api/profiles/${shop.profileId}/members`, { token: bob.token, body: { handle: "carol", role: "EDITOR" } }));
    ok(await api("GET", "/api/posts/feed", { token: carol.token, as: shop.profileId }));
    const me = ok(await api("GET", "/api/me", { token: carol.token }));
    assert.deepEqual(me.profiles.map((p: any) => [p.kind, p.role]), [["PERSONAL", "OWNER"], ["BUSINESS", "EDITOR"]]);
    // Editors can't manage the page.
    assert.equal((await api("PATCH", `/api/profiles/${shop.profileId}`, { token: carol.token, body: { bio: "x" } })).status, 403);
    const patched = ok(await api("PATCH", `/api/profiles/${shop.profileId}`, { token: bob.token, body: { bio: "Fresh bread daily" } }));
    assert.equal(patched.bio, "Fresh bread daily");

    const byHandle = ok(await api("GET", "/api/profiles/@bobs.bakery", { token: carol.token }));
    assert.equal(byHandle.profileId, shop.profileId);
    const found = ok(await api("GET", "/api/profiles/search?q=bob", { token: carol.token }));
    assert.ok(found.some((p: any) => p.handle === "bobs.bakery"));
  });
});

describe("connections", () => {
  test("connect request → accept; reciprocal request auto-accepts; providers can connect too", async () => {
    const dan = await login("dan");
    const eve = await login("eve");
    const fay = await login("fay");
    assert.deepEqual(ok(await api("POST", `/api/connections/friends/${eve.personalId}`, { token: dan.token })), { friendStatus: "REQUEST_SENT" });
    assert.equal((await api("POST", `/api/connections/friends/${eve.personalId}`, { token: dan.token })).status, 409);
    const incoming = ok(await api("GET", "/api/connections/friend-requests?direction=in", { token: eve.token }));
    assert.equal(incoming[0].profile.handle, "dan");
    assert.deepEqual(ok(await api("POST", `/api/connections/friends/${dan.personalId}/accept`, { token: eve.token })), { friendStatus: "FRIENDS" });

    ok(await api("POST", `/api/connections/friends/${fay.personalId}`, { token: eve.token }));
    assert.deepEqual(ok(await api("POST", `/api/connections/friends/${eve.personalId}`, { token: fay.token })), { friendStatus: "FRIENDS" });

    const view = ok(await api("GET", `/api/profiles/${eve.personalId}`, { token: dan.token }));
    assert.equal(view.relationship.friendStatus, "FRIENDS");
    assert.equal(view.counts.friends, 2);

    const shop = ok(await api("POST", "/api/profiles", { token: dan.token, body: { handle: "danshop", displayName: "Dan Shop" } }), 201);
    // Providers connect with providers (and anyone).
    const eveShop = ok(await api("POST", "/api/profiles", { token: eve.token, body: { handle: "eveshop", displayName: "Eve Shop" } }), 201);
    ok(await api("POST", `/api/connections/friends/${shop.profileId}`, { token: eve.token, as: eveShop.profileId }));
    assert.deepEqual(ok(await api("POST", `/api/connections/friends/${eveShop.profileId}/accept`, { token: dan.token, as: shop.profileId })), { friendStatus: "FRIENDS" });
    ok(await api("POST", `/api/connections/follows/${shop.profileId}`, { token: eve.token }));
    const followers = ok(await api("GET", `/api/connections/${shop.profileId}/followers`, { token: eve.token }));
    assert.deepEqual(followers.map((p: any) => p.handle), ["eve"]);
    const notes = ok(await api("GET", "/api/notifications", { token: dan.token, as: shop.profileId }));
    assert.equal(notes.items[0].type, "NEW_FOLLOWER");
  });

  test("blocking hides the profile, ends the friendship and stops messages", async () => {
    const gus = await login("gus");
    const hal = await login("hal");
    ok(await api("POST", `/api/connections/friends/${hal.personalId}`, { token: gus.token }));
    ok(await api("POST", `/api/connections/friends/${gus.personalId}/accept`, { token: hal.token }));
    const chat = ok(await api("POST", "/api/conversations/direct", { token: gus.token, body: { profileId: hal.personalId } }));

    ok(await api("POST", `/api/connections/blocks/${gus.personalId}`, { token: hal.token }));
    assert.equal((await api("GET", `/api/profiles/${hal.personalId}`, { token: gus.token })).status, 404);
    assert.equal((await api("POST", `/api/connections/friends/${hal.personalId}`, { token: gus.token })).status, 404);
    assert.equal((await api("POST", `/api/conversations/${chat.conversationId}/messages`, { token: gus.token, body: { text: "hi?" } })).status, 403);
    ok(await api("DELETE", `/api/connections/blocks/${gus.personalId}`, { token: hal.token }));
    ok(await api("POST", `/api/conversations/${chat.conversationId}/messages`, { token: gus.token, body: { text: "hi again" } }), 201);
  });
});

describe("media", () => {
  test("one image ≤ 1 MB, real image types only, served publicly", async () => {
    const ivy = await login("ivy");
    const media = ok(await api("POST", "/api/media", { token: ivy.token, form: imageForm(PNG) }), 201);
    assert.equal(media.mime, "image/png");
    assert.equal(media.width, 1);
    assert.match(media.url, /\/media\/.+\.png$/);
    const file = await fetch(base + new URL(media.url).pathname); // local driver; Supabase in production
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);

    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    assert.equal((await api("POST", "/api/media", { token: ivy.token, form: imageForm(big) })).status, 413);
    assert.equal((await api("POST", "/api/media", { token: ivy.token, form: imageForm(Buffer.from("<script>alert(1)</script>....."), "x.png") })).status, 400);
    const two = imageForm(PNG);
    two.append("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "b.png");
    assert.equal((await api("POST", "/api/media", { token: ivy.token, form: two })).status, 400);

    // Someone else's image can't be attached.
    const jon = await login("jon");
    assert.equal((await api("POST", "/api/posts", { token: jon.token, body: { mediaId: media.mediaId } })).status, 400);
  });
});

describe("feed", () => {
  test("500-character limit (emoji count as one); text or image required", async () => {
    const kim = await login("kim");
    assert.equal((await api("POST", "/api/posts", { token: kim.token, body: { text: "x".repeat(501) } })).status, 400);
    ok(await api("POST", "/api/posts", { token: kim.token, body: { text: "😀".repeat(500) } }), 201);
    assert.equal((await api("POST", "/api/posts", { token: kim.token, body: { text: "   " } })).status, 400);
  });

  test("audience: public / friends / followers / only me, in feeds and profile pages", async () => {
    const lea = await login("lea"); // author
    const max = await login("max"); // lea's friend
    const ned = await login("ned"); // stranger
    ok(await api("POST", `/api/connections/friends/${max.personalId}`, { token: lea.token }));
    ok(await api("POST", `/api/connections/friends/${lea.personalId}/accept`, { token: max.token }));

    const pub = ok(await api("POST", "/api/posts", { token: lea.token, body: { text: "hello world" } }), 201);
    const friendsOnly = ok(await api("POST", "/api/posts", { token: lea.token, body: { text: "friends only", audience: "CONNECTIONS" } }), 201);
    const secret = ok(await api("POST", "/api/posts", { token: lea.token, body: { text: "diary", audience: "ONLY_ME" } }), 201);

    const ids = (list: any[]) => list.map((p) => p.postId);
    assert.deepEqual(ids(ok(await api("GET", `/api/posts/by/${lea.personalId}`, { token: lea.token }))), [secret.postId, friendsOnly.postId, pub.postId]);
    assert.deepEqual(ids(ok(await api("GET", `/api/posts/by/${lea.personalId}`, { token: max.token }))), [friendsOnly.postId, pub.postId]);
    assert.deepEqual(ids(ok(await api("GET", `/api/posts/by/${lea.personalId}`, { token: ned.token }))), [pub.postId]);
    assert.equal((await api("GET", `/api/posts/${friendsOnly.postId}`, { token: ned.token })).status, 404);

    const maxFeed = ids(ok(await api("GET", "/api/posts/feed", { token: max.token })));
    assert.ok(maxFeed.includes(friendsOnly.postId) && maxFeed.includes(pub.postId) && !maxFeed.includes(secret.postId));
    assert.deepEqual(ok(await api("GET", "/api/posts/feed", { token: ned.token })), []);
    const explore = ids(ok(await api("GET", "/api/posts/feed?tab=explore", { token: ned.token })));
    assert.ok(explore.includes(pub.postId) && !explore.includes(friendsOnly.postId));

    // Business CONNECTIONS = followers.
    const brand = ok(await api("POST", "/api/profiles", { token: lea.token, body: { handle: "leabrand", displayName: "Lea Brand" } }), 201);
    const vip = ok(await api("POST", "/api/posts", { token: lea.token, as: brand.profileId, body: { text: "for followers", audience: "CONNECTIONS" } }), 201);
    assert.equal(vip.author.handle, "leabrand");
    assert.equal((await api("GET", `/api/posts/${vip.postId}`, { token: ned.token })).status, 404);
    ok(await api("POST", `/api/connections/follows/${brand.profileId}`, { token: ned.token }));
    ok(await api("GET", `/api/posts/${vip.postId}`, { token: ned.token }));
    assert.ok(ids(ok(await api("GET", "/api/posts/feed", { token: ned.token }))).includes(vip.postId));
  });

  test("reactions, comments, replies, counts and notifications", async () => {
    const ola = await login("ola");
    const pam = await login("pam");
    const post = ok(await api("POST", "/api/posts", { token: ola.token, body: { text: "rate my bread" } }), 201);
    assert.deepEqual(ok(await api("PUT", `/api/posts/${post.postId}/reactions`, { token: pam.token, body: { type: "LOVE" } })), { myReaction: "LOVE", reactionCount: 1 });
    assert.deepEqual(ok(await api("PUT", `/api/posts/${post.postId}/reactions`, { token: pam.token, body: { type: "WOW" } })), { myReaction: "WOW", reactionCount: 1 });
    const c1 = ok(await api("POST", `/api/posts/${post.postId}/comments`, { token: pam.token, body: { text: "looks great" } }), 201);
    const reply = ok(await api("POST", `/api/posts/${post.postId}/comments`, { token: ola.token, body: { text: "thanks!", parentId: c1.commentId } }), 201);
    assert.equal(reply.parentId, c1.commentId);
    const p = ok(await api("GET", `/api/posts/${post.postId}`, { token: pam.token }));
    assert.equal(p.commentCount, 2);
    assert.equal(p.myReaction, "WOW");
    const notes = ok(await api("GET", "/api/notifications", { token: ola.token }));
    assert.deepEqual(notes.items.map((n: any) => n.type).sort(), ["POST_COMMENT", "POST_REACTION"]);
    assert.equal(notes.unread, 2);
    ok(await api("POST", "/api/notifications/read", { token: ola.token, body: {} }));
    assert.equal(ok(await api("GET", "/api/notifications", { token: ola.token })).unread, 0);
    ok(await api("DELETE", `/api/posts/${post.postId}/reactions`, { token: pam.token }));
    assert.equal(ok(await api("GET", `/api/posts/${post.postId}`, { token: pam.token })).reactionCount, 0);
  });

  test("only the author edits; author or moderator deletes", async () => {
    const quin = await login("quin");
    const rex = await login("rex");
    const mod = await login("mod", "MANAGER");
    const post = ok(await api("POST", "/api/posts", { token: quin.token, body: { text: "v1" } }), 201);
    assert.equal((await api("PATCH", `/api/posts/${post.postId}`, { token: rex.token, body: { text: "hacked" } })).status, 403);
    const edited = ok(await api("PATCH", `/api/posts/${post.postId}`, { token: quin.token, body: { text: "v2" } }));
    assert.ok(edited.editedAt);
    assert.equal((await api("DELETE", `/api/posts/${post.postId}`, { token: rex.token })).status, 403);
    ok(await api("DELETE", `/api/posts/${post.postId}`, { token: mod.token }));
    assert.equal((await api("GET", `/api/posts/${post.postId}`, { token: quin.token })).status, 404);
  });
});

describe("chats", () => {
  test("direct chat: open is idempotent, live messages, unread, read receipts, edit, delete", async () => {
    const sam = await login("sam");
    const tia = await login("tia");
    const tiaSocket = await connect(tia);
    const samSocket = await connect(sam);

    const chat = ok(await api("POST", "/api/conversations/direct", { token: sam.token, body: { profileId: tia.personalId } }));
    const same = ok(await api("POST", "/api/conversations/direct", { token: tia.token, body: { profileId: sam.personalId } }));
    assert.equal(chat.conversationId, same.conversationId);
    assert.equal(chat.title, "Tia");

    const arriving = next(tiaSocket, "message:new");
    const sent = ok(await api("POST", `/api/conversations/${chat.conversationId}/messages`, { token: sam.token, body: { text: "hey tia 👋" } }), 201);
    const pushed = await arriving;
    assert.equal(pushed.messageId, sent.messageId);
    assert.equal(pushed.sender.handle, "sam");

    const typing = next(tiaSocket, "typing");
    samSocket.emit("typing", { conversationId: chat.conversationId, profileId: sam.personalId });
    assert.deepEqual(await typing, { conversationId: chat.conversationId, profileId: sam.personalId });

    let list = ok(await api("GET", "/api/conversations", { token: tia.token }));
    assert.equal(list[0].unread, 1);
    assert.equal(list[0].lastMessage.text, "hey tia 👋");
    assert.equal(list[0].partner.online, true);

    const receipt = next(samSocket, "read");
    ok(await api("POST", `/api/conversations/${chat.conversationId}/read`, { token: tia.token, body: {} }));
    assert.equal((await receipt).profileId, tia.personalId);
    list = ok(await api("GET", "/api/conversations", { token: tia.token }));
    assert.equal(list[0].unread, 0);

    const reply = ok(await api("POST", `/api/conversations/${chat.conversationId}/messages`, { token: tia.token, body: { text: "hi!", replyToId: sent.messageId } }), 201);
    assert.equal(reply.replyTo.text, "hey tia 👋");

    assert.equal((await api("PATCH", `/api/conversations/messages/${sent.messageId}`, { token: tia.token, body: { text: "nope" } })).status, 403);
    const updated = next(tiaSocket, "message:updated");
    ok(await api("PATCH", `/api/conversations/messages/${sent.messageId}`, { token: sam.token, body: { text: "hey Tia 👋" } }));
    assert.equal((await updated).text, "hey Tia 👋");
    ok(await api("DELETE", `/api/conversations/messages/${sent.messageId}`, { token: sam.token }));
    const history = ok(await api("GET", `/api/conversations/${chat.conversationId}/messages`, { token: tia.token }));
    const deleted = history.find((m: any) => m.messageId === sent.messageId);
    assert.ok(deleted.deletedAt);
    assert.equal(deleted.text, null);

    const uma = await login("uma");
    assert.equal((await api("GET", `/api/conversations/${chat.conversationId}/messages`, { token: uma.token })).status, 404);
    assert.equal((await api("POST", `/api/conversations/${chat.conversationId}/messages`, { token: sam.token, body: { text: "y".repeat(501) } })).status, 400);
  });

  test("a business inbox: messages to a page reach every member of it", async () => {
    const vic = await login("vic");
    const wes = await login("wes");
    const xan = await login("xan");
    const shop = ok(await api("POST", "/api/profiles", { token: vic.token, body: { handle: "vicshop", displayName: "Vic Shop" } }), 201);
    ok(await api("POST", `/api/profiles/${shop.profileId}/members`, { token: vic.token, body: { handle: "wes", role: "EDITOR" } }));
    const wesSocket = await connect(wes);
    const chat = ok(await api("POST", "/api/conversations/direct", { token: xan.token, body: { profileId: shop.profileId } }));
    const arriving = next(wesSocket, "message:new");
    ok(await api("POST", `/api/conversations/${chat.conversationId}/messages`, { token: xan.token, body: { text: "Is the shop open?" } }), 201);
    assert.equal((await arriving).text, "Is the shop open?");
    const answer = ok(await api("POST", `/api/conversations/${chat.conversationId}/messages`, { token: wes.token, as: shop.profileId, body: { text: "Yes, till 8!" } }), 201);
    assert.equal(answer.sender.handle, "vicshop");
  });

  test("groups: create, add, remove, leave; last admin leaving promotes someone", async () => {
    const [ann, ben, cat, dee] = await Promise.all(["ann", "ben", "cat", "dee"].map((u) => login(u)));
    const g = ok(await api("POST", "/api/conversations/group", { token: ann.token, body: { title: "Book club", memberIds: [ben.personalId, cat.personalId] } }), 201);
    assert.equal(g.memberCount, 3);
    assert.equal(g.myRole, "ADMIN");
    assert.equal((await api("POST", `/api/conversations/${g.conversationId}/members`, { token: ben.token, body: { profileIds: [dee.personalId] } })).status, 403);
    ok(await api("POST", `/api/conversations/${g.conversationId}/members`, { token: ann.token, body: { profileIds: [dee.personalId] } }));
    ok(await api("DELETE", `/api/conversations/${g.conversationId}/members/${cat.personalId}`, { token: ann.token }));
    assert.equal((await api("GET", `/api/conversations/${g.conversationId}`, { token: cat.token })).status, 404);
    ok(await api("DELETE", `/api/conversations/${g.conversationId}/members/${ann.personalId}`, { token: ann.token }));
    const view = ok(await api("GET", `/api/conversations/${g.conversationId}`, { token: ben.token }));
    assert.equal(view.myRole, "ADMIN"); // ben joined first after ann
    const msgs = ok(await api("GET", `/api/conversations/${g.conversationId}/messages`, { token: ben.token }));
    assert.deepEqual(msgs.filter((m: any) => m.kind === "SYSTEM").map((m: any) => m.text).reverse(), ['created the group "Book club"', "added Dee", "removed Cat", "left the group"]);
    const notes = ok(await api("GET", "/api/notifications", { token: dee.token }));
    assert.equal(notes.items[0].type, "ADDED_TO_GROUP");
  });
});

describe("calls (MUMU RTC)", () => {
  test("start rings the other side, answer, hang up; tokens come from MUMU RTC", async () => {
    const eli = await login("eli");
    const flo = await login("flo");
    const floSocket = await connect(flo);
    const chat = ok(await api("POST", "/api/conversations/direct", { token: eli.token, body: { profileId: flo.personalId } }));

    const ringing = next(floSocket, "call:ring");
    const started = ok(await api("POST", "/api/calls", { token: eli.token, body: { conversationId: chat.conversationId, type: "VIDEO" } }), 201);
    assert.equal(started.call.status, "RINGING");
    assert.equal(started.rtc.channel, `c_${chat.conversationId}`);
    assert.equal(started.rtc.role, "PUBLISHER");
    assert.equal(started.rtc.apiUrl, process.env.MUMU_RTC_URL);
    assert.equal(rtcCalls.at(-1).key, "mk_test");
    assert.equal(rtcCalls.at(-1).externalUserId, eli.personalId);
    const ring = await ringing;
    assert.equal(ring.callId, started.call.callId);
    assert.equal(ring.to, flo.personalId);

    // Starting again while it rings returns the same call.
    const again = ok(await api("POST", "/api/calls", { token: eli.token, body: { conversationId: chat.conversationId } }), 201);
    assert.equal(again.call.callId, started.call.callId);

    const answered = ok(await api("POST", `/api/calls/${started.call.callId}/join`, { token: flo.token }));
    assert.equal(answered.call.status, "ONGOING");
    assert.equal(ok(await api("GET", "/api/calls/active", { token: flo.token })).length, 1);
    const ended = ok(await api("POST", `/api/calls/${started.call.callId}/end`, { token: flo.token }));
    assert.equal(ended.status, "ENDED");
    const bubble = ok(await api("GET", `/api/conversations/${chat.conversationId}/messages`, { token: eli.token })).find((m: any) => m.kind === "CALL");
    assert.equal(bubble.call.status, "ENDED");

    const gil = await login("gil");
    assert.equal((await api("POST", `/api/calls/${started.call.callId}/join`, { token: gil.token })).status, 404);
  });

  test("unanswered calls become MISSED; plan limits come back as 402", async () => {
    const hob = await login("hob");
    const ida = await login("ida");
    const chat = ok(await api("POST", "/api/conversations/direct", { token: hob.token, body: { profileId: ida.personalId } }));
    const { call } = ok(await api("POST", "/api/calls", { token: hob.token, body: { conversationId: chat.conversationId, type: "AUDIO" } }), 201);
    await prisma.call.update({ where: { callId: call.callId }, data: { startedAt: new Date(Date.now() - 120_000) } });
    await sweepCalls();
    assert.equal(ok(await api("GET", `/api/calls/${call.callId}`, { token: ida.token })).status, "MISSED");
    assert.equal(ok(await api("GET", "/api/notifications", { token: ida.token })).items[0].type, "MISSED_CALL");

    rtcMode = "quota";
    try {
      const refused = await api("POST", "/api/calls", { token: hob.token, body: { conversationId: chat.conversationId } });
      assert.equal(refused.status, 402);
      assert.equal(refused.body.errors.code, "QUOTA_EXCEEDED");
      assert.equal(await prisma.call.count({ where: { conversationId: chat.conversationId, status: "RINGING" } }), 0);
    } finally {
      rtcMode = "ok";
    }
  });
});

describe("live (MUMU RTC)", () => {
  test("host goes live, followers are told, viewers watch as AUDIENCE, end", async () => {
    const jay = await login("jay");
    const kai = await login("kai");
    const lou = await login("lou");
    const studio = ok(await api("POST", "/api/profiles", { token: jay.token, body: { handle: "jaystudio", displayName: "Jay Studio" } }), 201);
    ok(await api("POST", `/api/connections/follows/${studio.profileId}`, { token: kai.token }));
    const kaiSocket = await connect(kai);

    const announced = next(kaiSocket, "live:updated");
    const live = ok(await api("POST", "/api/live", { token: jay.token, as: studio.profileId, body: { title: "Baking live", audience: "CONNECTIONS" } }), 201);
    assert.equal(live.rtc.role, "HOST");
    assert.equal(live.rtc.channel, `live_${studio.profileId}`);
    assert.equal((await announced).liveStreamId, live.stream.liveStreamId);
    assert.equal(ok(await api("GET", "/api/notifications", { token: kai.token })).items[0].type, "LIVE_STARTED");
    const again = await api("POST", "/api/live", { token: jay.token, as: studio.profileId, body: { title: "again" } });
    assert.equal(again.status, 409);
    assert.equal(again.body.errors.code, "ALREADY_LIVE");
    assert.equal(again.body.errors.title, "Baking live");

    // Followers-only: kai sees it, lou doesn't.
    assert.deepEqual(ok(await api("GET", "/api/live", { token: kai.token })).map((s: any) => s.title), ["Baking live"]);
    assert.deepEqual(ok(await api("GET", "/api/live", { token: lou.token })), []);
    assert.equal((await api("POST", `/api/live/${live.stream.liveStreamId}/watch`, { token: lou.token })).status, 404);

    const sid = live.stream.liveStreamId;
    const counted = (n: number) => next(kaiSocket, "live:updated", (s) => s.liveStreamId === sid && s.viewerCount === n);
    let update = counted(1);
    kaiSocket.emit("live:watch", { liveStreamId: sid });
    const watch = ok(await api("POST", `/api/live/${sid}/watch`, { token: kai.token }));
    assert.equal(watch.rtc.role, "AUDIENCE");
    assert.equal((await update).viewerCount, 1);
    // Reloading / a second tab of the same person doesn't count twice…
    const kaiTab2 = await connect(kai);
    kaiTab2.emit("live:watch", { liveStreamId: sid });
    kaiTab2.disconnect();
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(ok(await api("GET", `/api/live/${sid}`, { token: kai.token })).viewerCount, 1);
    // …and the host's own screen isn't a viewer.
    const jaySocket = await connect(jay);
    jaySocket.emit("live:watch", { liveStreamId: sid });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(ok(await api("GET", `/api/live/${sid}`, { token: kai.token })).viewerCount, 1);
    // Leaving (unwatch, or the socket dropping) takes them off the count; the host sees it live.
    const hostSees0 = next(jaySocket, "live:updated", (s) => s.liveStreamId === sid && s.viewerCount === 0);
    kaiSocket.emit("live:unwatch", { liveStreamId: sid });
    assert.equal((await hostSees0).viewerCount, 0);
    update = counted(1);
    kaiSocket.emit("live:watch", { liveStreamId: sid });
    await update;
    const post = ok(await api("GET", `/api/posts/${live.stream.postId}`, { token: kai.token }));
    assert.equal(post.liveStream.status, "LIVE");

    // Live chat = comments on the live's post: pushed to viewers, kept on the post afterwards,
    // and no notification per message for the host while on air.
    const pushed = next(kaiSocket, "live:comment", (c) => c.text === "Love this stream!");
    const said = ok(await api("POST", `/api/posts/${live.stream.postId}/comments`, { token: kai.token, body: { text: "Love this stream!" } }), 201);
    assert.equal((await pushed).commentId, said.commentId);
    assert.equal((await pushed).author.handle, "kai");
    const studioNotes = ok(await api("GET", "/api/notifications", { token: jay.token, as: studio.profileId }));
    assert.ok(!studioNotes.items.some((n: any) => n.type === "POST_COMMENT"), "no comment notifications while live");
    // Reactions float for everyone and stay on the live's post; tapping fast is capped.
    const floated = next(kaiSocket, "live:reaction");
    ok(await api("POST", `/api/live/${live.stream.liveStreamId}/react`, { token: kai.token, body: { type: "LOVE" } }));
    assert.deepEqual(await floated, { liveStreamId: live.stream.liveStreamId, type: "LOVE", profileId: kai.personalId });
    const taps = await Promise.all(Array.from({ length: 10 }, () => api("POST", `/api/live/${live.stream.liveStreamId}/react`, { token: kai.token, body: { type: "LOVE" } })));
    assert.ok(taps.filter((t) => t.body.data.floated).length <= 6, "taps beyond ~6/s are dropped");
    const reacted = ok(await api("GET", `/api/posts/${live.stream.postId}`, { token: kai.token }));
    assert.equal(reacted.myReaction, "LOVE");
    assert.equal(reacted.reactionCount, 1);

    const removed = next(kaiSocket, "live:comment-removed");
    ok(await api("DELETE", `/api/posts/comments/${said.commentId}`, { token: kai.token }));
    assert.equal((await removed).commentId, said.commentId);
    ok(await api("POST", `/api/posts/${live.stream.postId}/comments`, { token: kai.token, body: { text: "Stays on the post" } }), 201);

    assert.equal((await api("POST", `/api/live/${live.stream.liveStreamId}/end`, { token: kai.token })).status, 403);
    const ended = next(kaiSocket, "live:updated", (s) => s.status === "ENDED");
    ok(await api("POST", `/api/live/${live.stream.liveStreamId}/end`, { token: jay.token, as: studio.profileId }));
    assert.equal((await ended).status, "ENDED");
    assert.equal((await api("POST", `/api/live/${live.stream.liveStreamId}/watch`, { token: kai.token })).status, 400);
    // Replacing: confirm → the running live ends and a new one starts.
    const first = ok(await api("POST", "/api/live", { token: jay.token, as: studio.profileId, body: { title: "Take one" } }), 201);
    const second = ok(await api("POST", "/api/live", { token: jay.token, as: studio.profileId, body: { title: "Take two", replace: true } }), 201);
    assert.equal(ok(await api("GET", `/api/live/${first.stream.liveStreamId}`, { token: jay.token, as: studio.profileId })).status, "ENDED");
    assert.equal(second.stream.status, "LIVE");
    ok(await api("POST", `/api/live/${second.stream.liveStreamId}/end`, { token: jay.token, as: studio.profileId }));
    // After the live, the chat is the post's comments in the feed.
    const kept = ok(await api("GET", `/api/posts/${live.stream.postId}/comments`, { token: kai.token }));
    assert.deepEqual(kept.map((c: any) => c.text), ["Stays on the post"]);
    assert.equal(ok(await api("GET", `/api/posts/${live.stream.postId}`, { token: kai.token })).commentCount, 1);
  });
});

describe("moderation", () => {
  test("anyone reports; only moderators review; actioning takes the content down", async () => {
    const mia = await login("mia");
    const nia = await login("nia");
    const mod = await login("mod2", "MANAGER");
    const post = ok(await api("POST", "/api/posts", { token: mia.token, body: { text: "spam spam" } }), 201);
    const report = ok(await api("POST", "/api/reports", { token: nia.token, body: { targetType: "POST", targetId: post.postId, reason: "Spam" } }), 201);
    assert.equal((await api("GET", "/api/reports", { token: nia.token })).status, 403);
    const queue = ok(await api("GET", "/api/reports", { token: mod.token }));
    assert.equal(queue.items[0].reportId, report.reportId);
    ok(await api("PATCH", `/api/reports/${report.reportId}`, { token: mod.token, body: { status: "ACTIONED" } }));
    assert.equal((await api("GET", `/api/posts/${post.postId}`, { token: mia.token })).status, 404);
    assert.equal((await api("POST", "/api/reports", { token: nia.token, body: { targetType: "POST", targetId: "nope", reason: "x" } })).status, 404);
  });
});

describe("devices", () => {
  test("at most 3 devices; a 4th can list and sign one out; signed-out devices are told and blocked", async () => {
    const vee = await login("vee");
    const dev = (n: number) => `device-vee-${n}`;
    for (const n of [1, 2, 3]) ok(await api("GET", "/api/me", { token: vee.token, device: dev(n) }));
    const fourth = await api("GET", "/api/posts/feed", { token: vee.token, device: dev(4) });
    assert.equal(fourth.status, 403);
    assert.equal(fourth.body.errors.code, "DEVICE_LIMIT");
    assert.equal(fourth.body.errors.devices.length, 3);
    // Requests without a device id (scripts, Swagger) aren't limited.
    ok(await api("GET", "/api/posts/feed", { token: vee.token }));

    // The blocked device can still see the list and sign another device out.
    const list = ok(await api("GET", "/api/me/devices", { token: vee.token, device: dev(4) }));
    assert.equal(list.devices.length, 3);
    const s1 = await connect(vee);
    const told = next(s1, "device:signed-out");
    ok(await api("DELETE", `/api/me/devices/${dev(1)}`, { token: vee.token, device: dev(4) }));
    assert.equal((await told).deviceId, dev(1));
    ok(await api("GET", "/api/posts/feed", { token: vee.token, device: dev(4) }));
    const blocked = await api("GET", "/api/posts/feed", { token: vee.token, device: dev(1) });
    assert.equal(blocked.status, 401);
    assert.equal(blocked.body.errors.code, "DEVICE_SIGNED_OUT");

    // Signing in again on device 1 (a newer token) counts as a new device → over the limit.
    const fresh = jwt.sign({ userId: "vee", email: "vee@test.local", realmId: REALM_ID, iat: Math.floor(Date.now() / 1000) + 5 }, REALM_SECRET, { algorithm: "HS256" });
    const again = await api("GET", "/api/me", { token: fresh, device: dev(1) });
    assert.equal(again.body.errors.code, "DEVICE_LIMIT");
    ok(await api("DELETE", `/api/me/devices/${dev(2)}`, { token: vee.token, device: dev(3) }));
    ok(await api("GET", "/api/me", { token: fresh, device: dev(1) }));
  });

  test("a host opening their live on another device is asked first, and can take it over", async () => {
    const wyn = await login("wyn");
    const [phone, laptop] = ["device-wyn-phone", "device-wyn-laptop"];
    const live = ok(await api("POST", "/api/live", { token: wyn.token, device: phone, body: { title: "From my phone" } }), 201);
    const sid = live.stream.liveStreamId;
    assert.equal(ok(await api("POST", `/api/live/${sid}/watch`, { token: wyn.token, device: phone })).rtc.role, "HOST");

    const elsewhere = await api("POST", `/api/live/${sid}/watch`, { token: wyn.token, device: laptop });
    assert.equal(elsewhere.status, 409);
    assert.equal(elsewhere.body.errors.code, "LIVE_ON_OTHER_DEVICE");

    const phoneSocket = await connect(wyn);
    const moved = next(phoneSocket, "live:takeover");
    const taken = ok(await api("POST", `/api/live/${sid}/watch`, { token: wyn.token, device: laptop, body: { takeover: true } }));
    assert.equal(taken.rtc.role, "HOST");
    assert.deepEqual(await moved, { liveStreamId: sid, deviceId: laptop });
    // Now the phone is the "other device".
    assert.equal((await api("POST", `/api/live/${sid}/watch`, { token: wyn.token, device: phone })).status, 409);
    ok(await api("POST", `/api/live/${sid}/end`, { token: wyn.token, device: laptop }));
  });
});

describe("admin", () => {
  test("only admins; categories feed the provider dropdown; settings; suspending a profile", async () => {
    const boss = await login("boss", "ADMIN");
    const plain = await login("plainuser");
    assert.equal((await api("GET", "/api/admin/overview", { token: plain.token })).status, 403);
    const meAdmin = ok(await api("GET", "/api/me", { token: boss.token }));
    assert.equal(meAdmin.isAdmin, true);
    assert.equal(meAdmin.needsSetup, true); // no provider profile yet
    assert.equal(ok(await api("GET", "/api/me", { token: plain.token })).isAdmin, false);

    const bakery = ok(await api("POST", "/api/admin/categories", { token: boss.token, body: { name: "Bakery" } }), 201);
    const hidden = ok(await api("POST", "/api/admin/categories", { token: boss.token, body: { name: "Hidden" } }), 201);
    ok(await api("PATCH", `/api/admin/categories/${hidden.categoryId}`, { token: boss.token, body: { isActive: false } }));
    const publicList = ok(await api("GET", "/api/categories"));
    assert.ok(publicList.some((c: any) => c.name === "Bakery") && !publicList.some((c: any) => c.name === "Hidden"));

    assert.equal((await api("POST", "/api/profiles", { token: plain.token, body: { handle: "nocat", displayName: "x", categoryId: hidden.categoryId } })).status, 400);
    const shop = ok(await api("POST", "/api/profiles", { token: plain.token, body: { handle: "plainbakes", displayName: "Plain Bakes", categoryId: bakery.categoryId } }), 201);
    assert.equal(shop.category, "Bakery");
    assert.equal(ok(await api("GET", "/api/me", { token: plain.token })).needsSetup, false);
    assert.equal((await api("DELETE", `/api/admin/categories/${bakery.categoryId}`, { token: boss.token })).status, 400); // in use

    ok(await api("PUT", "/api/admin/settings", { token: boss.token, body: { liveEnabled: false } }));
    assert.equal((await api("POST", "/api/live", { token: plain.token, as: shop.profileId, body: { title: "nope" } })).status, 403);
    ok(await api("PUT", "/api/admin/settings", { token: boss.token, body: { liveEnabled: true } }));

    ok(await api("PATCH", `/api/admin/profiles/${shop.profileId}`, { token: boss.token, body: { suspended: true, isVerified: true } }));
    const blocked = await api("GET", "/api/posts/feed", { token: plain.token, as: shop.profileId });
    assert.equal(blocked.body.errors.code, "PROFILE_SUSPENDED");
    assert.ok(!ok(await api("GET", "/api/profiles/search?q=plainbakes", { token: boss.token })).length);
    const suspendedList = ok(await api("GET", "/api/admin/profiles?status=suspended", { token: boss.token }));
    assert.equal(suspendedList.items[0].handle, "plainbakes");
    ok(await api("PATCH", `/api/admin/profiles/${shop.profileId}`, { token: boss.token, body: { suspended: false } }));
    ok(await api("GET", "/api/posts/feed", { token: plain.token, as: shop.profileId }));
    assert.ok(ok(await api("GET", "/api/admin/overview", { token: boss.token })).providers >= 1);
  });
});

describe("account deletion", () => {
  test("deleting your MuMu account removes your profiles and their content; others are untouched", async () => {
    const zed = await login("zed");
    const yan = await login("yan");
    const shop = ok(await api("POST", "/api/profiles", { token: zed.token, body: { handle: "zedshop", displayName: "Zed Shop" } }), 201);
    const post = ok(await api("POST", "/api/posts", { token: zed.token, as: shop.profileId, body: { text: "bye" } }), 201);
    const chat = ok(await api("POST", "/api/conversations/direct", { token: yan.token, body: { profileId: zed.personalId } }));
    ok(await api("POST", `/api/conversations/${chat.conversationId}/messages`, { token: zed.token, body: { text: "hi yan" } }), 201);
    const yanPost = ok(await api("POST", "/api/posts", { token: yan.token, body: { text: "still here" } }), 201);
    ok(await api("POST", `/api/posts/${yanPost.postId}/comments`, { token: zed.token, body: { text: "nice" } }), 201);

    const res = ok(await api("DELETE", "/api/me", { token: zed.token }));
    assert.equal(res.deletedProfiles, 2); // consumer + provider
    assert.equal(await prisma.profile.count({ where: { profileId: { in: [zed.personalId, shop.profileId] } } }), 0);
    assert.equal(await prisma.post.count({ where: { postId: post.postId } }), 0);
    assert.equal(await prisma.message.count({ where: { senderProfileId: zed.personalId } }), 0);
    assert.equal(await prisma.profileMember.count({ where: { userId: "zed" } }), 0);
    // Yan's things stay (minus Zed's comment).
    const kept = ok(await api("GET", `/api/posts/${yanPost.postId}`, { token: yan.token }));
    assert.equal(kept.text, "still here");
    assert.equal(kept.commentCount, 0);
    assert.equal(ok(await api("GET", `/api/posts/${yanPost.postId}/comments`, { token: yan.token })).length, 0);
  });
});
