// src/services/redis.ts
import Redis from 'ioredis';

const redis = new Redis({
  host: import.meta.env.VITE_REDIS_HOST || 'localhost',
  port: Number(import.meta.env.VITE_REDIS_PORT) || 6379,
  password: import.meta.env.VITE_REDIS_PASSWORD || undefined,
});

export default redis;