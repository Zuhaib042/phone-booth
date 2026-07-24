import assert from "node:assert/strict";
import test from "node:test";

import { buildApi } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";

const TEST_CONFIG: ApiConfig = {
  host: "127.0.0.1",
  logLevel: "silent",
  nodeEnvironment: "test",
  port: 0,
};

test("GET /health/live reports that the API process is alive", async (context) => {
  const api = buildApi(TEST_CONFIG, { logger: false });
  context.after(async () => api.close());

  const response = await api.inject({
    method: "GET",
    url: "/health/live",
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /^application\/json/);
  assert.deepEqual(response.json(), { status: "ok" });
});
