import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const secretsManager = new SecretsManagerClient({});

type DbSecret = {
  username?: string;
  password?: string;
  host?: string;
  port?: number;
  dbname?: string;
};

let cachedUrl: string | undefined;

export async function workerDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  if (cachedUrl) {
    return cachedUrl;
  }

  const secretArn = process.env.DB_SECRET_ARN;
  const host = process.env.DB_HOST;
  const dbName = process.env.DB_NAME ?? "zcg";
  const port = process.env.DB_PORT ?? "5432";

  if (!secretArn || !host) {
    throw new Error("DB_SECRET_ARN and DB_HOST are required for deployed workers");
  }

  const response = await secretsManager.send(
    new GetSecretValueCommand({
      SecretId: secretArn
    })
  );

  if (!response.SecretString) {
    throw new Error("Database secret has no SecretString");
  }

  const secret = JSON.parse(response.SecretString) as DbSecret;
  const username = secret.username;
  const password = secret.password;

  if (!username || !password) {
    throw new Error("Database secret is missing username or password");
  }

  cachedUrl = `postgres://${username}:${encodeURIComponent(password)}@${host}:${port}/${dbName}`;
  return cachedUrl;
}
