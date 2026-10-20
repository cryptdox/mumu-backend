import 'dotenv/config'

export const NODE_ENV = process.env.NODE_ENV ?? "development";
export const IS_PROD = NODE_ENV === "production";
export const IS_TEST = NODE_ENV === "test";
/** Wipe all tables on boot (never in production). */
export const RESET = process.env.RESET_DB === "true" && !IS_PROD;

/** crypt-iam client of this app — permission strings start with "MU:". */
export const IAM_CLIENT_ID = process.env.IAM_CLIENT_ID ?? "mu";

export const BOOTSTRAP_CONFIG = {
  REDIS: {
    IAM_REDIS_URL: process.env.IAM_REDIS_URL ?? "redis://localhost:6379",
  },
};

export const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// ── Content limits ──────────────────────────────────────────────────────────
export const MAX_TEXT = 500;
export const MAX_IMAGE_BYTES = 1024 * 1024; // 1 MB
export const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export const MAX_GROUP_MEMBERS = 256;
/** A call nobody answers becomes MISSED after this long. */
export const CALL_RING_SECONDS = Number(process.env.CALL_RING_SECONDS ?? 45);

// ── Storage ─────────────────────────────────────────────────────────────────
export const STORAGE_DRIVER = (process.env.STORAGE_DRIVER ?? "supabase") as "supabase" | "local";
export const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
export const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
export const STORAGE_BUCKET = process.env.STORAGE_BUCKET ?? "mu-media";
export const LOCAL_STORAGE_PATH = process.env.LOCAL_STORAGE_PATH ?? "uploads";
/** Public base URL of this API — used for local-driver image URLs. */
export const PUBLIC_API_URL = (process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4100}`).replace(/\/+$/, "");

// ── MUMU RTC (calls + live) ─────────────────────────────────────────────────
export const MUMU_RTC_URL = (process.env.MUMU_RTC_URL ?? "http://localhost:3001").replace(/\/+$/, "");
export const MUMU_RTC_API_KEY = process.env.MUMU_RTC_API_KEY ?? "";
export const MUMU_RTC_API_SECRET = process.env.MUMU_RTC_API_SECRET ?? "";
export const RTC_TOKEN_TTL_SECONDS = Number(process.env.RTC_TOKEN_TTL_SECONDS ?? 3600);

export enum Role {
  ADMIN = "ADMIN",
  MANAGER = "MANAGER",
  VIEWER = "VIEWER",
  AUDITOR = "AUDITOR",
  USER = "USER",
}

export enum TypeAction {
  CREATE = "CREATE",
  READ = "READ",
  READ_ALL = "READ_ALL",
  UPDATE = "UPDATE",
  DELETE = "DELETE",
}

/**
 * IAM resources of client "mu" (all API_ENDPOINT), prefixed MU_ because crypt-iam's
 * own guard ignores the client segment — an unprefixed name could match an IAM
 * resource. Ownership ("your own post")
 * is checked in code; READ_ALL on a resource marks moderators who may act on
 * anyone's content. Grants per role: scripts/role-matrix.json.
 */
export enum Resource {
  PROFILE = "MU_PROFILE",
  CONNECTION = "MU_CONNECTION",
  POST = "MU_POST",
  COMMENT = "MU_COMMENT",
  REACTION = "MU_REACTION",
  MEDIA = "MU_MEDIA",
  CONVERSATION = "MU_CONVERSATION",
  MESSAGE = "MU_MESSAGE",
  CALL = "MU_CALL",
  LIVE = "MU_LIVE",
  NOTIFICATION = "MU_NOTIFICATION",
  REPORT = "MU_REPORT",
}

export enum TypeResource {
  API_ENDPOINT = "API_ENDPOINT",
  UI_PAGE = "UI_PAGE",
  FILE = "FILE",
  SERVICE = "SERVICE",
  DATASET = "DATASET",
}
