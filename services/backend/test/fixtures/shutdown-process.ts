import { buildApi } from "../../src/app.js";
import { loadApiConfig } from "../../src/config.js";
import { installGracefulShutdown } from "../../src/server.js";

const api = buildApi(loadApiConfig());
const keepAlive = setInterval(() => undefined, 60_000);

api.addHook("onClose", async () => {
  clearInterval(keepAlive);
});

await api.ready();
installGracefulShutdown(api);
process.stdout.write("fixture-ready\n");
