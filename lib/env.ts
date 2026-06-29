import { z } from "zod";

const envSchema = z.object({
  APP_ENV: z.string().default("local"),
  BETTER_AUTH_URL: z.string().url().optional(),
  BETTER_AUTH_SECRET: z.string().min(16).optional(),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_DRIVER: z.enum(["pg", "data-api"]).default("pg"),
  DB_HOST: z.string().optional(),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default("zcg"),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  DB_CLUSTER_ARN: z.string().optional(),
  DB_SECRET_ARN: z.string().optional(),
  SNAPSHOT_BUCKET_NAME: z.string().optional(),
  WORKER_SHARED_SECRET: z.string().optional(),
  SES_FROM_EMAIL: z.string().optional(),
  BOOTSTRAP_ADMIN_EMAILS: z.string().optional()
});

export type RuntimeEnv = z.infer<typeof envSchema>;

export function getEnv(): RuntimeEnv {
  return envSchema.parse(process.env);
}

export function databaseUrlFromEnv(env: RuntimeEnv = getEnv()): string {
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }

  if (env.DB_HOST && env.DB_USER && env.DB_PASSWORD) {
    const password = encodeURIComponent(env.DB_PASSWORD);
    return `postgres://${env.DB_USER}:${password}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`;
  }

  return "postgres://zcg:zcg@localhost:5432/zcg";
}
