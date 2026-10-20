import fs from "fs/promises";
import path from "path";
import {
  IMAGE_MIME,
  LOCAL_STORAGE_PATH,
  MAX_IMAGE_BYTES,
  PUBLIC_API_URL,
  STORAGE_BUCKET,
  STORAGE_DRIVER,
  SUPABASE_SECRET_KEY,
  SUPABASE_URL,
} from "./consts";
import { ServiceUnavailable } from "./errors";
import logger from "./logger";

/**
 * Image storage. "supabase" = public Supabase Storage bucket (production);
 * "local" = files under LOCAL_STORAGE_PATH served at /media (dev / tests).
 */
export interface Storage {
  put(key: string, body: Buffer, mime: string): Promise<string>; // → public URL
  remove(key: string): Promise<void>;
}

class SupabaseStorage implements Storage {
  private headers() {
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw ServiceUnavailable("Image storage is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY)");
    return { authorization: `Bearer ${SUPABASE_SECRET_KEY}`, apikey: SUPABASE_SECRET_KEY };
  }

  publicUrl(key: string) {
    return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${key}`;
  }

  async put(key: string, body: Buffer, mime: string) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${key}`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": mime, "cache-control": "31536000", "x-upsert": "false" },
      body: new Uint8Array(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error(`[Storage] upload ${key} failed: ${res.status} ${text}`);
      throw ServiceUnavailable("Image upload failed, try again");
    }
    return this.publicUrl(key);
  }

  async remove(key: string) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`, {
      method: "DELETE",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ prefixes: [key] }),
    }).catch((err) => logger.warn(`[Storage] delete ${key} failed: ${err?.message ?? err}`));
  }

  /** Create the public bucket (1 MB, images only) if it doesn't exist yet. */
  async ensureBucket() {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({
        id: STORAGE_BUCKET,
        name: STORAGE_BUCKET,
        public: true,
        file_size_limit: MAX_IMAGE_BYTES,
        allowed_mime_types: IMAGE_MIME,
      }),
    });
    if (res.ok) return logger.info(`[Storage] created public bucket "${STORAGE_BUCKET}"`);
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 409 || /already exists/i.test(body?.message ?? "")) return;
    throw new Error(`Can't create bucket "${STORAGE_BUCKET}": ${res.status} ${body?.message ?? ""}`);
  }
}

class LocalStorage implements Storage {
  async put(key: string, body: Buffer) {
    const file = path.join(LOCAL_STORAGE_PATH, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    return `${PUBLIC_API_URL}/media/${key}`;
  }

  async remove(key: string) {
    await fs.rm(path.join(LOCAL_STORAGE_PATH, key), { force: true });
  }
}

export const supabaseStorage = new SupabaseStorage();
export const storage: Storage = STORAGE_DRIVER === "local" ? new LocalStorage() : supabaseStorage;

/** At boot: make sure the bucket exists (no-op for local storage or before the key is set). */
export async function initStorage() {
  if (STORAGE_DRIVER !== "supabase") return;
  if (!SUPABASE_SECRET_KEY) {
    logger.warn("[Storage] SUPABASE_SECRET_KEY not set — image uploads will fail until it is");
    return;
  }
  await supabaseStorage.ensureBucket().catch((err) => logger.error(`[Storage] ${err.message}`));
}
