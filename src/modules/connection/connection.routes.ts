import express, { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { actorMiddleware } from "../../middlewares/actor.middleware";
import { writeLimiter } from "../../middlewares/rateLimit.middleware";
import { asyncHandler } from "../../utils/errors";
import { guard, R, A } from "../../utils/guard";
import { idParam, send, validate } from "../../utils/http";
import connectionService from "./connection.service";

const router: Router = express.Router();
router.use(authMiddleware, actorMiddleware);

const page = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(30) });
const pid = validate({ params: idParam("profileId") });
const read = guard(R.CONNECTION, A.READ);
const create = [writeLimiter, guard(R.CONNECTION, A.CREATE)];
const remove = guard(R.CONNECTION, A.DELETE);

/**
 * @openapi
 * tags:
 *   - name: Connections
 *     description: Friends (personal ↔ personal, mutual), follows (anyone → anyone) and blocks — always as the active profile
 *
 * /api/connections/friend-requests:
 *   get:
 *     tags: [Connections]
 *     summary: Pending friend requests to you (in) or from you (out)
 *     parameters:
 *       - { name: direction, in: query, schema: { type: string, enum: [in, out], default: in } }
 *     responses:
 *       200: { description: "[{ profile, createdAt }]" }
 */
router.get("/friend-requests", read, validate({ query: z.object({ direction: z.enum(["in", "out"]).default("in") }) }), asyncHandler(async (req, res) => {
  send(res, 200, "Requests fetched", await connectionService.requests(req.actor!, req.validated!.query.direction));
}));

/**
 * @openapi
 * /api/connections/friends/{profileId}:
 *   post:
 *     tags: [Connections]
 *     summary: Send a friend request (accepts theirs if they already asked you)
 *     parameters:
 *       - { name: profileId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ friendStatus }" }
 *   delete:
 *     tags: [Connections]
 *     summary: Unfriend, decline or cancel a request
 *     parameters:
 *       - { name: profileId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ friendStatus: NONE }" }
 * /api/connections/friends/{profileId}/accept:
 *   post:
 *     tags: [Connections]
 *     summary: Accept a friend request
 *     parameters:
 *       - { name: profileId, in: path, required: true, schema: { type: string }, description: Who sent it }
 *     responses:
 *       200: { description: "{ friendStatus: FRIENDS }" }
 */
router.post("/friends/:profileId", ...create, pid, asyncHandler(async (req, res) => {
  send(res, 200, "Friend request sent", await connectionService.requestFriend(req.actor!, req.params.profileId as string));
}));
router.post("/friends/:profileId/accept", ...create, pid, asyncHandler(async (req, res) => {
  send(res, 200, "Friend request accepted", await connectionService.accept(req.actor!, req.params.profileId as string));
}));
router.delete("/friends/:profileId", remove, pid, asyncHandler(async (req, res) => {
  send(res, 200, "Friendship removed", await connectionService.removeFriend(req.actor!, req.params.profileId as string));
}));

/**
 * @openapi
 * /api/connections/follows/{profileId}:
 *   post:
 *     tags: [Connections]
 *     summary: Follow a profile
 *     parameters:
 *       - { name: profileId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ following: true }" }
 *   delete:
 *     tags: [Connections]
 *     summary: Unfollow
 *     parameters:
 *       - { name: profileId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ following: false }" }
 */
router.post("/follows/:profileId", ...create, pid, asyncHandler(async (req, res) => {
  send(res, 200, "Following", await connectionService.follow(req.actor!, req.params.profileId as string));
}));
router.delete("/follows/:profileId", remove, pid, asyncHandler(async (req, res) => {
  send(res, 200, "Unfollowed", await connectionService.unfollow(req.actor!, req.params.profileId as string));
}));

/**
 * @openapi
 * /api/connections/blocks:
 *   get:
 *     tags: [Connections]
 *     summary: Profiles you blocked
 *     responses:
 *       200: { description: Profile cards }
 * /api/connections/blocks/{profileId}:
 *   post:
 *     tags: [Connections]
 *     summary: Block (also removes friendship and follows both ways)
 *     parameters:
 *       - { name: profileId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ blocked: true }" }
 *   delete:
 *     tags: [Connections]
 *     summary: Unblock
 *     parameters:
 *       - { name: profileId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ blocked: false }" }
 */
router.get("/blocks", read, asyncHandler(async (req, res) => {
  send(res, 200, "Blocked profiles fetched", await connectionService.blocks(req.actor!));
}));
router.post("/blocks/:profileId", ...create, pid, asyncHandler(async (req, res) => {
  send(res, 200, "Blocked", await connectionService.block(req.actor!, req.params.profileId as string));
}));
router.delete("/blocks/:profileId", remove, pid, asyncHandler(async (req, res) => {
  send(res, 200, "Unblocked", await connectionService.unblock(req.actor!, req.params.profileId as string));
}));

/**
 * @openapi
 * /api/connections/{profileId}/{list}:
 *   get:
 *     tags: [Connections]
 *     summary: A profile's friends, followers or following
 *     parameters:
 *       - { name: profileId, in: path, required: true, schema: { type: string } }
 *       - { name: list, in: path, required: true, schema: { type: string, enum: [friends, followers, following] } }
 *       - { name: offset, in: query, schema: { type: integer, default: 0 } }
 *       - { name: limit, in: query, schema: { type: integer, default: 30 } }
 *     responses:
 *       200: { description: Profile cards }
 */
router.get("/:profileId/:list", read, validate({ params: z.object({ profileId: z.string().min(1).max(64), list: z.enum(["friends", "followers", "following"]) }), query: page }), asyncHandler(async (req, res) => {
  const { profileId, list } = req.validated!.params;
  const { offset, limit } = req.validated!.query;
  const items = await connectionService[list as "friends" | "followers" | "following"](profileId, offset, limit);
  send(res, 200, "Profiles fetched", items);
}));

export default router;
