import { MUMU_RTC_API_KEY, MUMU_RTC_API_SECRET, MUMU_RTC_URL, RTC_TOKEN_TTL_SECONDS } from "./consts";
import { AppError, ServiceUnavailable } from "./errors";
import logger from "./logger";

export type RtcRole = "PUBLISHER" | "SUBSCRIBER" | "HOST" | "AUDIENCE";

/** What a client needs to join: `new Room({ apiUrl }).join({ token })` (mumu-rtc SDK). */
export interface RtcJoin {
  apiUrl: string;
  token: string;
  channel: string;
  role: RtcRole;
  expiresAt: string;
}

/**
 * Ask MUMU RTC for a token (server-to-server, the API secret never reaches browsers).
 * Plan / quota errors (402) are passed through so the app can explain them.
 */
export async function issueRtcToken(profileId: string, channel: string, role: RtcRole): Promise<RtcJoin> {
  if (!MUMU_RTC_API_KEY || !MUMU_RTC_API_SECRET) throw ServiceUnavailable("Calls are not configured (MUMU_RTC_API_KEY / SECRET)");
  let res: Response;
  try {
    res = await fetch(`${MUMU_RTC_URL}/api/server/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": MUMU_RTC_API_KEY, "x-api-secret": MUMU_RTC_API_SECRET },
      body: JSON.stringify({ externalUserId: profileId, channelName: channel, role, ttlSeconds: RTC_TOKEN_TTL_SECONDS }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    logger.error(`[RTC] token request failed: ${err?.message ?? err}`);
    throw ServiceUnavailable("Calling service is unreachable, try again");
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.warn(`[RTC] token refused ${res.status}: ${body?.message}`);
    if (res.status === 402) throw new AppError(402, body?.message ?? "Calling limit reached", body?.errors);
    throw ServiceUnavailable("Calling service refused the request");
  }
  return { apiUrl: MUMU_RTC_URL, token: body.data.token, channel, role, expiresAt: body.data.expiresAt };
}
