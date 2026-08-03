import { buildApplication } from "./application.js";
import { loadConfig } from "./config.js";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";

const config = loadConfig();
const repository = new PostgresArchiveRepository(config.databaseUrl);
const application = buildApplication(config, repository);

const shutdown = async (signal: string) => {
  application.log.info({ signal }, "Shutting down BubblePilot");
  await application.close();
  process.exitCode = 0;
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await application.listen({ host: config.host, port: config.port });
} catch (error) {
  application.log.fatal({ err: error }, "BubblePilot failed to start");
  await application.close();
  process.exitCode = 1;
}
