import { loadConfig } from "@agentflow/config";
import { createDatabase, migrate } from "./index.js";

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);

try {
  await migrate(database);
  console.log("AgentFlow database migrations are up to date.");
} finally {
  await database.end();
}
