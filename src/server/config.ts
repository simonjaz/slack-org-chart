import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  // Public https origin of this service, e.g. https://orgchart.example.com
  BASE_URL: z.string().url(),
  DATABASE_URL: z.string(),
  SLACK_CLIENT_ID: z.string(),
  SLACK_CLIENT_SECRET: z.string(),
  SLACK_SIGNING_SECRET: z.string(),
  // Random string used to sign OAuth state.
  SLACK_STATE_SECRET: z.string().min(16),
  // 32 bytes, base64. Encrypts Slack tokens at rest.
  TOKEN_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded',
  }),
  // Hour (UTC) the nightly full sync runs.
  NIGHTLY_SYNC_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(2),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}

export const BOT_SCOPES = [
  'users:read',
  'users:read.email',
  'users.profile:read',
  'team:read',
  'channels:read',
  'groups:read',
  'commands',
];

export const SIGN_IN_SCOPES = ['openid', 'email', 'profile'];
