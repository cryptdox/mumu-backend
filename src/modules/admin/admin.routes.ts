import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { asyncHandler, Forbidden } from "../../utils/errors";
import { isAppAdmin } from "../../utils/permissions";
import { idParam, send, validate } from "../../utils/http";
import adminService from "./admin.service";
import { SETTING_DEFAULTS } from "./settings";

/** Public: the active category list for the Provider dropdown. */
export const categoriesRouter: Router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Admin
 *     description: Admin panel API — the IAM ADMIN role of client "mu" (MU_PROFILE READ_ALL + UPDATE)
 *
 * /api/categories:
 *   get:
 *     tags: [Admin]
 *     security: []
 *     summary: Active provider categories (for the dropdown)
 *     responses:
 *       200: { description: "[{ categoryId, name }]" }
 */
categoriesRouter.get("/", asyncHandler(async (_req, res) => {
  send(res, 200, "Categories", await adminService.listCategories(false));
}));

const router: Router = express.Router();
const adminOnly = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (!(await isAppAdmin(req))) throw Forbidden("Admins only");
    next();
  } catch (err) {
    next(err);
  }
};
router.use(authMiddleware, adminOnly);

const name = z.string().trim().min(1).max(40);
const cid = validate({ params: idParam("categoryId") });

/**
 * @openapi
 * /api/admin/overview:
 *   get: { tags: [Admin], summary: "Counts: providers, consumers, suspended, posts, messages (24h), live now, open reports…", responses: { 200: { description: Stats } } }
 * /api/admin/categories:
 *   get: { tags: [Admin], summary: All categories (with how many profiles use each), responses: { 200: { description: Categories } } }
 *   post:
 *     tags: [Admin]
 *     summary: Add a category
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, required: [name], properties: { name: { type: string }, sortOrder: { type: integer } } } } } }
 *     responses: { 201: { description: Created }, 409: { description: Exists } }
 * /api/admin/categories/{categoryId}:
 *   patch:
 *     tags: [Admin]
 *     summary: Rename, reorder, turn on/off
 *     parameters: [{ name: categoryId, in: path, required: true, schema: { type: string } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { name: { type: string }, sortOrder: { type: integer }, isActive: { type: boolean } } } } } }
 *     responses: { 200: { description: Updated } }
 *   delete:
 *     tags: [Admin]
 *     summary: Delete an unused category
 *     parameters: [{ name: categoryId, in: path, required: true, schema: { type: string } }]
 *     responses: { 200: { description: Deleted }, 400: { description: In use } }
 * /api/admin/settings:
 *   get: { tags: [Admin], summary: App settings, responses: { 200: { description: "{ consumerModeEnabled, liveEnabled, maxProvidersPerAccount }" } } }
 *   put:
 *     tags: [Admin]
 *     summary: Change app settings
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { consumerModeEnabled: { type: boolean }, liveEnabled: { type: boolean }, maxProvidersPerAccount: { type: integer } } } } } }
 *     responses: { 200: { description: Settings } }
 * /api/admin/profiles:
 *   get:
 *     tags: [Admin]
 *     summary: Find profiles
 *     parameters:
 *       - { name: q, in: query, schema: { type: string } }
 *       - { name: kind, in: query, schema: { type: string, enum: [PERSONAL, BUSINESS] } }
 *       - { name: status, in: query, schema: { type: string, enum: [active, suspended] } }
 *       - { name: offset, in: query, schema: { type: integer } }
 *       - { name: limit, in: query, schema: { type: integer } }
 *     responses: { 200: { description: "{ items, total }" } }
 * /api/admin/profiles/{profileId}:
 *   patch:
 *     tags: [Admin]
 *     summary: Verify / unverify, suspend / restore (suspending ends their live)
 *     parameters: [{ name: profileId, in: path, required: true, schema: { type: string } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { isVerified: { type: boolean }, suspended: { type: boolean } } } } } }
 *     responses: { 200: { description: Profile } }
 * /api/admin/live:
 *   get: { tags: [Admin], summary: Streams live now, responses: { 200: { description: Streams } } }
 * /api/admin/live/{liveStreamId}/end:
 *   post:
 *     tags: [Admin]
 *     summary: End a live
 *     parameters: [{ name: liveStreamId, in: path, required: true, schema: { type: string } }]
 *     responses: { 200: { description: Ended } }
 */
router.get("/overview", asyncHandler(async (_req, res) => send(res, 200, "Overview", await adminService.overview())));

router.get("/categories", asyncHandler(async (_req, res) => send(res, 200, "Categories", await adminService.listCategories(true))));
router.post("/categories", validate({ body: z.object({ name, sortOrder: z.number().int().min(0).max(10_000).optional() }) }), asyncHandler(async (req, res) => {
  send(res, 201, "Category added", await adminService.createCategory(req.body.name, req.body.sortOrder));
}));
router.patch("/categories/:categoryId", validate({ params: idParam("categoryId"), body: z.object({ name, sortOrder: z.number().int().min(0).max(10_000), isActive: z.boolean() }).partial() }), asyncHandler(async (req, res) => {
  send(res, 200, "Category updated", await adminService.updateCategory(req.params.categoryId as string, req.body));
}));
router.delete("/categories/:categoryId", cid, asyncHandler(async (req, res) => {
  await adminService.deleteCategory(req.params.categoryId as string);
  send(res, 200, "Category deleted");
}));

router.get("/settings", asyncHandler(async (_req, res) => send(res, 200, "Settings", await adminService.settings())));
router.put("/settings", validate({
  body: z.object({
    consumerModeEnabled: z.boolean(),
    liveEnabled: z.boolean(),
    maxProvidersPerAccount: z.number().int().min(1).max(100),
  }).partial().refine((v) => Object.keys(v).every((k) => k in SETTING_DEFAULTS), "Unknown setting"),
}), asyncHandler(async (req, res) => {
  send(res, 200, "Settings saved", await adminService.saveSettings(req.body, req.user!.userId));
}));

router.get("/profiles", validate({
  query: z.object({
    q: z.string().trim().max(60).optional(),
    kind: z.enum(["PERSONAL", "BUSINESS"]).optional(),
    status: z.enum(["active", "suspended"]).optional(),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }),
}), asyncHandler(async (req, res) => send(res, 200, "Profiles", await adminService.profiles(req.validated!.query))));
router.patch("/profiles/:profileId", validate({ params: idParam("profileId"), body: z.object({ isVerified: z.boolean(), suspended: z.boolean() }).partial() }), asyncHandler(async (req, res) => {
  send(res, 200, "Profile updated", await adminService.moderateProfile(req.params.profileId as string, req.body));
}));

router.get("/live", asyncHandler(async (_req, res) => send(res, 200, "Live", await adminService.lives())));
router.post("/live/:liveStreamId/end", validate({ params: idParam("liveStreamId") }), asyncHandler(async (req, res) => {
  send(res, 200, "Live ended", await adminService.endLive(req.params.liveStreamId as string));
}));

export default router;
