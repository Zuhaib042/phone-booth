import { loadPostgresConfig } from "./config.js";
import { createDatabasePool } from "./persistence/database.js";
import { migrationStatus, runMigrations } from "./persistence/migrations.js";

const command = process.argv[2] ?? "up";
if (command !== "up" && command !== "status") {
  process.stderr.write("Usage: migrate-main.js [up|status]\n");
  process.exitCode = 2;
} else {
  const { databaseUrl } = loadPostgresConfig();
  const pool = createDatabasePool({
    applicationName: "project-booth-migrations",
    connectionString: databaseUrl,
    maximumConnections: 1,
  });

  try {
    const status =
      command === "up"
        ? await runMigrations(pool)
        : await migrationStatus(pool);
    process.stdout.write(`${JSON.stringify(status)}\n`);
  } finally {
    await pool.end();
  }
}
