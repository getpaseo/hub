import { fileURLToPath } from "node:url";
import { reportFailure } from "../failures/index.js";
import { logger } from "../logger.js";
import { postgresDatabaseRuntime } from "./runtime/index.js";

const LOCAL_DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/paseo_hub";

export async function runDatabaseMigrations(
  databaseUrl = resolveMigrationDatabaseUrl(),
): Promise<void> {
  const { runtime } = await postgresDatabaseRuntime(databaseUrl);
  try {
    await runtime.migrate();
    logger.info("database migrations applied");
  } finally {
    await runtime.close();
  }
}

function resolveMigrationDatabaseUrl(): string {
  const configured = process.env["DATABASE_URL"]?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("DATABASE_URL is required to run database migrations in production");
  }
  return LOCAL_DEFAULT_DATABASE_URL;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDatabaseMigrations().catch((error: unknown) => {
    reportFailure(error, { operation: "database.migrate.cli", component: "database" });
    process.exit(1);
  });
}
