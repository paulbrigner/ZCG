import pg from "pg";
import { databaseUrlFromEnv } from "../lib/env";

const { Client } = pg;

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL;

  if (!adminEmail) {
    console.log("Set SEED_ADMIN_EMAIL to grant the initial admin role.");
    return;
  }

  const client = new Client({
    connectionString: databaseUrlFromEnv(),
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined
  });

  await client.connect();

  try {
    await client.query("begin");

    const principal = await client.query<{ id: string }>(
      `insert into principals (auth_provider, auth_subject, email, display_name)
       values ('manual-seed', $1, $1, $1)
       on conflict (auth_provider, auth_subject)
       do update set email = excluded.email, updated_at = now()
       returning id`,
      [adminEmail]
    );

    await client.query(
      `insert into role_assignments (principal_id, role_id, reason)
       select $1, roles.id, 'Initial Phase 0 seed admin'
         from roles
        where roles.role_key = 'admin'
       on conflict (principal_id, role_id) do nothing`,
      [principal.rows[0]?.id]
    );

    await client.query("commit");
    console.log(`Seeded admin role for ${adminEmail}`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
