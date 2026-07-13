import pg from "pg";
import { betterAuth } from "better-auth";
import { emailOTP, magicLink } from "better-auth/plugins";
import { databaseUrlFromEnv, getEnv } from "@/lib/env";
import { sendAuthCodeEmail } from "@/lib/email";
import { betterAuthDataApiAdapter } from "@/lib/better-auth-data-api-adapter";

const { Pool } = pg;
const env = getEnv();

export const auth = betterAuth({
  appName: "ZCG Grants Prototype",
  baseURL: env.BETTER_AUTH_URL ?? "http://localhost:3000",
  secret:
    env.BETTER_AUTH_SECRET ??
    (process.env.NODE_ENV === "production" ? undefined : "phase0-local-build-secret-change-before-deploy"),
  database:
    env.DATABASE_DRIVER === "data-api"
      ? betterAuthDataApiAdapter
      : new Pool({
          connectionString: databaseUrlFromEnv(env),
          max: 4,
          ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined
        }),
  plugins: [
    emailOTP({
      async sendVerificationOTP({ email, otp }) {
        await sendAuthCodeEmail({ email, otp });
      }
    }),
    magicLink({
      storeToken: "hashed",
      async sendMagicLink({ email, url, metadata }) {
        const otp = typeof metadata?.otp === "string" ? metadata.otp : null;

        if (!otp) {
          throw new Error("A sign-in code is required for the combined sign-in email.");
        }

        await sendAuthCodeEmail({ email, magicLink: url, otp });
      }
    })
  ]
});

export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
