import { env } from "./env.js";
import { runMigrations } from "./db/migrate.js";
import { createApp } from "./app.js";

const { PORT } = env(); // fail fast on missing configuration
await runMigrations();
(await createApp()).listen(PORT, "0.0.0.0", () => {
  console.log(`Twig portal listening on port ${PORT}`);
});
