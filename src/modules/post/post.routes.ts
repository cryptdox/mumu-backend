import express, { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { actorMiddleware } from "../../middlewares/actor.middleware";
import { writeLimiter } from "../../middlewares/rateLimit.middleware";
import { asyncHandler } from "../../utils/errors";
import { guard, R, A } from "../../utils/guard";
import { idParam, send, validate } from "../../utils/http";
import { beforeQuery } from "../../utils/content";
import postService from "./post.service";
import { commentSchema, createPostSchema, feedQuery, reactionSchema, updatePostSchema } from "./post.dto";

const router: Router = express.Router();
router.use(authMiddleware, actorMiddleware);
const postId = validate({ params: idParam("postId") });

/**
 * @openapi
 * tags:
 *   - name: Feed
 *     description: Posts (text ≤ 500 chars and/or one image), reactions and comments — as the active profile
 *
 * /api/posts/feed:
 *   get:
 *     tags: [Feed]
 *     summary: Home feed — "following" (you, friends, who you follow) or "explore" (all public)
 *     parameters:
 *       - { name: tab, in: query, schema: { type: string, enum: [following, explore], default: following } }
 *       - { name: before, in: query, schema: { type: string, format: date-time }, description: createdAt of the last post you have }
 *       - { name: limit, in: query, schema: { type: integer, default: 20 } }
 *     responses:
 *       200: { description: "Post[]" }
 * /api/posts:
 *   post:
 *     tags: [Feed]
 *     summary: Create a post
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/CreatePostDto' } } }
 *     responses:
 *       201: { description: Post }
 * /api/posts/by/{profileId}:
 *   get:
 *     tags: [Feed]
 *     summary: A profile's posts that you may see
 *     parameters:
 *       - { name: profileId, in: path, required: true, schema: { type: string } }
 *       - { name: before, in: query, schema: { type: string, format: date-time } }
 *       - { name: limit, in: query, schema: { type: integer, default: 20 } }
 *     responses:
 *       200: { description: "Post[]" }
 */
router.get("/feed", guard(R.POST, A.READ), validate({ query: feedQuery }), asyncHandler(async (req, res) => {
  const { tab, before, limit } = req.validated!.query;
  send(res, 200, "Feed fetched", await postService.feed(req.actor!, tab, before, limit));
}));
router.post("/", writeLimiter, guard(R.POST, A.CREATE), validate({ body: createPostSchema }), asyncHandler(async (req, res) => {
  send(res, 201, "Posted", await postService.create(req.actor!, req.body));
}));
router.get("/by/:profileId", guard(R.POST, A.READ), validate({ params: idParam("profileId"), query: beforeQuery }), asyncHandler(async (req, res) => {
  const { before, limit } = req.validated!.query;
  send(res, 200, "Posts fetched", await postService.byProfile(req.actor!, req.params.profileId as string, before, limit));
}));

/**
 * @openapi
 * /api/posts/{postId}:
 *   get:
 *     tags: [Feed]
 *     summary: One post (404 if you may not see it)
 *     parameters:
 *       - { name: postId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Post }
 *   patch:
 *     tags: [Feed]
 *     summary: Edit your post's text or audience
 *     parameters:
 *       - { name: postId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { text: { type: string, nullable: true }, audience: { type: string, enum: [PUBLIC, CONNECTIONS, ONLY_ME] } } }
 *     responses:
 *       200: { description: Post }
 *   delete:
 *     tags: [Feed]
 *     summary: Delete your post (moderators — MU_POST READ_ALL — any post)
 *     parameters:
 *       - { name: postId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted }
 */
router.get("/:postId", guard(R.POST, A.READ), postId, asyncHandler(async (req, res) => {
  send(res, 200, "Post fetched", await postService.get(req.actor!, req.params.postId as string));
}));
router.patch("/:postId", writeLimiter, guard(R.POST, A.UPDATE), validate({ params: idParam("postId"), body: updatePostSchema }), asyncHandler(async (req, res) => {
  send(res, 200, "Post updated", await postService.update(req.actor!, req.params.postId as string, req.body));
}));
router.delete("/:postId", guard(R.POST, A.DELETE), postId, asyncHandler(async (req, res) => {
  await postService.remove(req, req.params.postId as string);
  send(res, 200, "Post deleted");
}));

/**
 * @openapi
 * /api/posts/{postId}/reactions:
 *   get:
 *     tags: [Feed]
 *     summary: Who reacted
 *     parameters:
 *       - { name: postId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "[{ type, profile }]" }
 *   put:
 *     tags: [Feed]
 *     summary: React (or change your reaction)
 *     parameters:
 *       - { name: postId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { type: { type: string, enum: [LIKE, LOVE, HAHA, WOW, SAD], default: LIKE } } }
 *     responses:
 *       200: { description: "{ myReaction, reactionCount }" }
 *   delete:
 *     tags: [Feed]
 *     summary: Remove your reaction
 *     parameters:
 *       - { name: postId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ myReaction: null, reactionCount }" }
 */
router.get("/:postId/reactions", guard(R.REACTION, A.READ), postId, asyncHandler(async (req, res) => {
  send(res, 200, "Reactions fetched", await postService.reactions(req.actor!, req.params.postId as string, 100));
}));
router.put("/:postId/reactions", writeLimiter, guard(R.REACTION, A.CREATE), validate({ params: idParam("postId"), body: reactionSchema }), asyncHandler(async (req, res) => {
  send(res, 200, "Reacted", await postService.react(req.actor!, req.params.postId as string, req.body.type));
}));
router.delete("/:postId/reactions", guard(R.REACTION, A.DELETE), postId, asyncHandler(async (req, res) => {
  send(res, 200, "Reaction removed", await postService.unreact(req.actor!, req.params.postId as string));
}));

/**
 * @openapi
 * /api/posts/{postId}/comments:
 *   get:
 *     tags: [Feed]
 *     summary: Comments, newest first
 *     parameters:
 *       - { name: postId, in: path, required: true, schema: { type: string } }
 *       - { name: before, in: query, schema: { type: string, format: date-time } }
 *       - { name: limit, in: query, schema: { type: integer, default: 20 } }
 *     responses:
 *       200: { description: Comments }
 *   post:
 *     tags: [Feed]
 *     summary: Comment (≤ 500 chars) or reply (parentId)
 *     parameters:
 *       - { name: postId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [text], properties: { text: { type: string }, parentId: { type: string } } }
 *     responses:
 *       201: { description: Comment }
 * /api/posts/comments/{commentId}:
 *   delete:
 *     tags: [Feed]
 *     summary: Delete a comment (its author, the post's author, or a moderator)
 *     parameters:
 *       - { name: commentId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted }
 */
router.get("/:postId/comments", guard(R.COMMENT, A.READ), validate({ params: idParam("postId"), query: beforeQuery }), asyncHandler(async (req, res) => {
  const { before, limit } = req.validated!.query;
  send(res, 200, "Comments fetched", await postService.comments(req.actor!, req.params.postId as string, before, limit));
}));
router.post("/:postId/comments", writeLimiter, guard(R.COMMENT, A.CREATE), validate({ params: idParam("postId"), body: commentSchema }), asyncHandler(async (req, res) => {
  send(res, 201, "Commented", await postService.comment(req.actor!, req.params.postId as string, req.body.text, req.body.parentId));
}));
router.delete("/comments/:commentId", guard(R.COMMENT, A.DELETE), validate({ params: idParam("commentId") }), asyncHandler(async (req, res) => {
  await postService.removeComment(req, req.params.commentId as string);
  send(res, 200, "Comment deleted");
}));

export default router;
