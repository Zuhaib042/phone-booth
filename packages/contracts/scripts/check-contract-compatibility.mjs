import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  CLIENT_MESSAGE_V1_SCHEMA,
  createCompatibilitySurface,
  findBreakingContractChanges,
  PROTOCOL_ERROR_V1_SCHEMA,
  SERVER_EVENT_ENVELOPE_V1_SCHEMA,
} from "../dist/src/index.js";

const baselineUrl = new URL(
  "../compatibility/baselines/contracts.v1.json",
  import.meta.url,
);
const currentOpenApiUrl = new URL(
  "../dist/compatibility/openapi.current.json",
  import.meta.url,
);

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

const current = {
  clientMessage: createCompatibilitySurface(CLIENT_MESSAGE_V1_SCHEMA),
  formatVersion: 1,
  openapi: createCompatibilitySurface(await readJson(currentOpenApiUrl)),
  protocolError: createCompatibilitySurface(PROTOCOL_ERROR_V1_SCHEMA),
  serverEvent: createCompatibilitySurface(SERVER_EVENT_ENVELOPE_V1_SCHEMA),
};

if (process.argv.includes("--update-baseline")) {
  await mkdir(new URL("../compatibility/baselines/", import.meta.url), {
    recursive: true,
  });
  await writeFile(baselineUrl, `${JSON.stringify(current, null, 2)}\n`);
  process.stdout.write("Updated contract compatibility baseline.\n");
} else {
  const baseline = await readJson(baselineUrl);
  const issues = [
    "clientMessage",
    "openapi",
    "protocolError",
    "serverEvent",
  ].flatMap((contract) =>
    findBreakingContractChanges(baseline[contract], current[contract]).map(
      (issue) => ({ contract, ...issue }),
    ),
  );

  if (issues.length > 0) {
    for (const issue of issues) {
      process.stderr.write(`${issue.contract} ${issue.kind}: ${issue.path}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write("Contract compatibility check passed.\n");
  }
}
