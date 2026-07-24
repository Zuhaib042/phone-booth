import { spawnSync } from "node:child_process";

const healthCommand = [
  "compose",
  "exec",
  "--no-TTY",
  "SERVICE",
  "node",
  "services/backend/dist/src/datastore-health-main.js",
];

for (const service of ["api", "worker"]) {
  process.stdout.write(`${service}: `);
  const args = healthCommand.map((argument) =>
    argument === "SERVICE" ? service : argument,
  );
  const result = spawnSync("docker", args, { stdio: "inherit" });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
