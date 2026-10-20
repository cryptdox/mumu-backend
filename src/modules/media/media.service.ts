import crypto from "crypto";
import { imageSize } from "image-size";
import prisma from "../../prisma/client";
import { BadRequest, Forbidden, NotFound } from "../../utils/errors";
import { MAX_IMAGE_BYTES } from "../../utils/consts";
import { storage } from "../../utils/storage";
import type { Actor } from "../../middlewares/actor.middleware";

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/** Real type from the file's first bytes — the client's content-type isn't trusted. */
export function sniffImage(buf: Buffer): keyof typeof EXT | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a") return "image/gif";
  return null;
}

class MediaService {
  async upload(actor: Actor, file: Express.Multer.File | undefined) {
    if (!file) throw BadRequest('Attach one image as form field "file"');
    if (file.size > MAX_IMAGE_BYTES) throw BadRequest("Images can be at most 1 MB");
    const mime = sniffImage(file.buffer);
    if (!mime) throw BadRequest("Only JPEG, PNG, WebP or GIF images are allowed");
    let dims: { width?: number; height?: number } = {};
    try {
      dims = imageSize(file.buffer);
    } catch {
      throw BadRequest("That image looks broken");
    }

    const mediaId = crypto.randomUUID();
    const path = `${actor.profileId}/${mediaId}.${EXT[mime]}`;
    const url = await storage.put(path, file.buffer, mime);
    return prisma.media.create({
      data: { mediaId, ownerProfileId: actor.profileId, path, url, mime, bytes: file.size, width: dims.width ?? null, height: dims.height ?? null },
      select: { mediaId: true, url: true, mime: true, bytes: true, width: true, height: true, createdAt: true },
    });
  }

  /** Delete an image you uploaded (posts / messages using it lose the image). */
  async remove(actor: Actor, mediaId: string) {
    const media = await prisma.media.findUnique({ where: { mediaId } });
    if (!media) throw NotFound("Image not found");
    if (media.ownerProfileId !== actor.profileId) throw Forbidden("Not your image");
    await prisma.media.delete({ where: { mediaId } });
    await storage.remove(media.path);
  }
}

export default new MediaService();
