import "dotenv/config";
import { postgresDatabaseRuntime } from "./runtime/index.js";

const databaseUrl =
  process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/paseo_hub";
const { runtime } = await postgresDatabaseRuntime(databaseUrl);

try {
  await runtime.migrate();
} finally {
  await runtime.close();
}
