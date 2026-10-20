# MuMu API (mumu-backend)

Messaging-first social app on **MUMU RTC**: chats (1:1, groups, business inboxes), short posts
with one photo, reactions and comments, voice/video calls and live streams. Sign-in is
**crypt-iam** (client `mu`). Express 5 · Prisma 7 · Postgres · socket.io.

## Concepts

| Term | Meaning |
| --- | --- |
| Account | An IAM user |
| Personal profile | The consumer side — one per account, created on first sign-in |
| Business profile | The producer side — any number per account; members are OWNER / ADMIN / EDITOR |
| Active profile | Everything is done *as* a profile: send `x-profile-id` (default: your personal profile) |
| Friends / Followers | Friends are mutual (personal ↔ personal); anyone can follow anyone |
| Audience | `PUBLIC`, `CONNECTIONS` (friends of a person, followers of a business), `ONLY_ME` — posts and lives |

Limits: text ≤ 500 characters (emoji count as one), one image (JPEG/PNG/WebP/GIF, ≤ 1 MB) per post or message.

## Run

```bash
cp example.env .env          # DATABASE_URL, IAM_REDIS_URL, SUPABASE_*, MUMU_RTC_*
pnpm install
pnpm migrate:deploy
pnpm dev                     # http://localhost:4100 — Swagger at /api/docs
```

On boot the public Supabase bucket (`STORAGE_BUCKET`, 1 MB, images only) is created if missing.

## IAM (client `mu`)

Resources `MU_PROFILE, MU_CONNECTION, MU_POST, MU_COMMENT, MU_REACTION, MU_MEDIA, MU_CONVERSATION,
MU_MESSAGE, MU_CALL, MU_LIVE, MU_NOTIFICATION, MU_REPORT` (API_ENDPOINT, CRUD + READ_ALL).
`READ_ALL` on a content resource = moderator. Role grants: `scripts/role-matrix.json`.

```bash
node scripts/iam-setup.mjs            # dry run — shows what's missing
node scripts/iam-setup.mjs --apply    # creates resources, grants the 5 roles (additive only)
```

New sign-ups get the client's `USER` role automatically (crypt-iam register).

## Realtime (socket.io, same port)

Connect with `auth: { token: <IAM access token> }`. Events: `message:new`, `message:updated`,
`conversation:updated`, `read`, `typing`, `presence`, `call:ring` (with `to` = which of your
profiles is called), `call:updated`, `call:declined`, `notification`, `live:updated`.
Send `typing { conversationId, profileId }`, `live:watch` / `live:unwatch { liveStreamId }`.

## Calls & live

The API keeps the MUMU RTC project key/secret and hands browsers `{ apiUrl, token }` for the
`mumu-rtc` SDK. Calls use channel `c_<conversationId>` (PUBLISHER); lives use `live_<hostProfileId>`
(HOST publishes, viewers AUDIENCE). No recording. 402 = the RTC plan's limit — give the project
owner a plan with enough channels/participants in the MUMU RTC admin.

## Tests

```bash
pnpm test:local  # 17 end-to-end API + socket tests on local docker infra (.env.test)
```

Demo data on a local API: `set -a; . ./.env.demo; set +a; RESET_DB=true pnpm dev` then
`node scripts/seed-demo.mjs` (people, businesses, posts with photos, chats; sign-in sessions in
`scripts/demo-sessions.json`).
