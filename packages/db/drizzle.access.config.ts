import { defineConfig } from "drizzle-kit";

// The access log lives in its own D1 database (portifact-access), with its own migrations.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/access-schema.ts",
  out: "./access-migrations",
});
