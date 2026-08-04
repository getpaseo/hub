import "dotenv/config";
import { createDatabase } from "./pg.js";

const databaseUrl =
  process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/paseo_hub";
const database = await createDatabase(databaseUrl);

await database.close();
