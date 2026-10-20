import express, { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { actorMiddleware } from "../../middlewares/actor.middleware";
import { uploadLimiter } from "../../middlewares/rateLimit.middleware";
import { AppError, asyncHandler } from "../../utils/errors";
import { MAX_IMAGE_BYTES } from "../../utils/consts";
import { guard, R, A } from "../../utils/guard";
import { idParam, send, validate } from "../../utils/http";
import mediaService from "./media.service";

const router: Router = express.Router();
router.use(authMiddleware, actorMiddleware);

const single = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 } }).single("file");
const oneImage = (req: Request, res: Response, next: NextFunction) =>
  single(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return next(new AppError(413, "Images can be at most 1 MB"));
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") return next(new AppError(400, 'Upload one image as form field "file"'));
    next(new AppError(400, err.message ?? "Upload failed"));
  });

/**
 * @openapi
 * tags:
 *   - name: Media
 *     description: Images (JPEG, PNG, WebP, GIF; max 1 MB, one per upload) — public URLs. Use the returned mediaId in a post, message or profile.
 *
 * /api/media:
 *   post:
 *     tags: [Media]
 *     summary: Upload one image
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema: { type: object, required: [file], properties: { file: { type: string, format: binary } } }
 *     responses:
 *       201: { description: "{ mediaId, url, mime, bytes, width, height }" }
 *       413: { description: Over 1 MB }
 * /api/media/{mediaId}:
 *   delete:
 *     tags: [Media]
 *     summary: Delete an image you uploaded
 *     parameters:
 *       - { name: mediaId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted }
 */
router.post("/", uploadLimiter, guard(R.MEDIA, A.CREATE), oneImage, asyncHandler(async (req, res) => {
  send(res, 201, "Image uploaded", await mediaService.upload(req.actor!, req.file));
}));
router.delete("/:mediaId", guard(R.MEDIA, A.DELETE), validate({ params: idParam("mediaId") }), asyncHandler(async (req, res) => {
  await mediaService.remove(req.actor!, req.params.mediaId as string);
  send(res, 200, "Image deleted");
}));

export default router;
