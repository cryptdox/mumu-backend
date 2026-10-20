import { createClient, RedisClientType } from "redis";
import { BOOTSTRAP_CONFIG } from "./consts";

let redis: RedisClientType;

redis = createClient({
  url: BOOTSTRAP_CONFIG.REDIS.IAM_REDIS_URL,
});

redis.on("connect", () => {
  console.log("✅ Redis Connected");
});

redis.on("error", (err) => {
  console.error("❌ Redis Error", err);
});


export const ConnectIamRedis = async () => {
  if (!redis.isOpen) {
    await redis.connect();
  }
};

export class IamCacheService {
  async set(key: string, value: any, ttl?: number) {
    const stringValue = JSON.stringify(value);

    if (ttl) {
      await redis.set(key, stringValue, { EX: ttl });
    } else {
      await redis.set(key, stringValue);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async del(key: string) {
    await redis.del(key);
  }
}

export const iamCacheService = new IamCacheService();

export default redis;