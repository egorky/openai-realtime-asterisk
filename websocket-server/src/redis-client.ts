import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_CONVERSATION_TTL_SECONDS = parseInt(process.env.REDIS_CONVERSATION_TTL_SECONDS || "3600", 10);

let redisClient: Redis | null = null;
let redisAvailable = false;

try {
  const client = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    lazyConnect: true, // Connect on first command
    connectTimeout: 5000, // 5 seconds
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 10) { // Stop retrying after 10 attempts for initial connection
        console.warn('[RedisClient] Exhausted connection retries to Redis.');
        return null; // Stop retrying
      }
      const delay = Math.min(times * 100, 2000); // Exponential backoff up to 2s
      console.log(`[RedisClient] Retrying connection to Redis in ${delay}ms (attempt ${times})`);
      return delay;
    },
  });

  client.on('connect', () => {
    console.info('[RedisClient] Successfully connected to Redis.');
    redisAvailable = true;
  });

  client.on('error', (err) => {
    console.error('[RedisClient] Redis connection error:', err.message);
    // If it was available, mark as unavailable.
    // The retryStrategy will handle reconnections if possible for future commands.
    // If the error occurs after initial successful connection, ioredis might attempt to reconnect based on its internal settings.
    if (redisAvailable) {
        redisAvailable = false;
        console.warn('[RedisClient] Redis connection lost. Logging to Redis will be suspended until reconnected.');
    }
  });

  client.on('reconnecting', () => {
    console.info('[RedisClient] Reconnecting to Redis...');
  });

  client.on('end', () => {
    console.info('[RedisClient] Redis connection ended.');
    redisAvailable = false; // Mark as unavailable
  });

  // Perform an explicit connect attempt and a ping to check availability early
  client.connect().then(() => {
    client.ping((err, result) => {
      if (err || result !== 'PONG') {
        console.warn(`[RedisClient] Ping to Redis failed. Host: ${REDIS_HOST}:${REDIS_PORT}. Error: ${err ? err.message : 'Result not PONG'}. Conversation logging to Redis might be unavailable.`);
        redisAvailable = false;
      } else {
        console.info(`[RedisClient] Redis ping successful. Host: ${REDIS_HOST}:${REDIS_PORT}. Conversation logging enabled.`);
        redisAvailable = true;
      }
    });
  }).catch(connectError => {
     console.warn(`[RedisClient] Initial connection to Redis failed. Host: ${REDIS_HOST}:${REDIS_PORT}. Error: ${connectError.message}. Conversation logging to Redis will be unavailable.`);
     redisAvailable = false;
  });

  redisClient = client;

} catch (e: any) {
  console.error(`[RedisClient] Failed to initialize Redis client: ${e.message}`);
  redisClient = null;
  redisAvailable = false;
}

export interface ConversationTurn {
  timestamp: string;
  actor: "caller" | "bot" | "system" | "error" | "dtmf" | "tool_call" | "tool_response";
  type: "transcript" | "tts_prompt" | "dtmf_input" | "error_message" | "system_message" | "tool_log";
  content: string;
  tool_name?: string;
  callId?: string; // Optional, as it's part of the key
}

export async function logConversationToRedis(
  callId: string,
  turnData: Omit<ConversationTurn, 'timestamp' | 'callId'>
): Promise<void> {
  if (!redisClient || !redisAvailable) {
    // console.warn('[RedisClient] Redis client not available. Skipping conversation log for callId:', callId);
    return;
  }

  const turn: ConversationTurn = {
    ...turnData,
    timestamp: new Date().toISOString(),
    callId: callId,
  };

  const redisKey = `conversation:${callId}`;

  try {
    await redisClient.rpush(redisKey, JSON.stringify(turn));
    await redisClient.expire(redisKey, REDIS_CONVERSATION_TTL_SECONDS);
    // console.debug(`[RedisClient] Logged turn to Redis for callId ${callId}. Key: ${redisKey}`);
  } catch (error: any) {
    console.error(`[RedisClient] Error logging conversation to Redis for callId ${callId}:`, error.message);
    // If an error occurs, we might lose redisAvailable status. The 'error' event on client should handle this.
  }
}

export function isRedisAvailable(): boolean {
    return redisClient !== null && redisAvailable;
}

// Optional: Graceful shutdown
export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
      console.info('[RedisClient] Redis client disconnected gracefully.');
    } catch (error: any) {
      console.error('[RedisClient] Error during Redis disconnection:', error.message);
    }
    redisClient = null;
    redisAvailable = false;
  }
}

// Example of how to use it (this would be in ari-client.ts or similar)
// import { logConversationToRedis } from './redis-client';
// logConversationToRedis('some-call-id', { actor: 'caller', type: 'transcript', content: 'Hello world' });
// logConversationToRedis('some-call-id', { actor: 'bot', type: 'tts_prompt', content: 'Hi there, how can I help?' });
// logConversationToRedis('some-call-id', { actor: 'dtmf', type: 'dtmf_input', content: '1234#' });
