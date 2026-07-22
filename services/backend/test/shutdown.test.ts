import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;

function waitForOutput(
  stream: NodeJS.ReadableStream,
  expected: string,
  timeoutMilliseconds: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for output: ${expected}`));
    }, timeoutMilliseconds);

    function cleanup(): void {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("error", onError);
    }

    function onData(chunk: Buffer | string): void {
      output += chunk.toString();
      if (output.includes(expected)) {
        cleanup();
        resolve(output);
      }
    }

    function onError(error: Error): void {
      cleanup();
      reject(error);
    }

    stream.on("data", onData);
    stream.on("error", onError);
  });
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMilliseconds: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for API shutdown"));
    }, timeoutMilliseconds);

    function cleanup(): void {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
    }

    function onError(error: Error): void {
      cleanup();
      reject(error);
    }

    function onExit(
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void {
      cleanup();
      resolve({ code, signal });
    }

    child.once("error", onError);
    child.once("exit", onExit);
  });
}

for (const shutdownSignal of ["SIGINT", "SIGTERM"] as const) {
  test(`the API process exits successfully after ${shutdownSignal}`, async () => {
    const fixturePath = new URL(
      "./fixtures/shutdown-process.js",
      import.meta.url,
    );
    const child = spawn(process.execPath, [fileURLToPath(fixturePath)], {
      env: {
        ...process.env,
        LOG_LEVEL: "info",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    try {
      await waitForOutput(child.stdout, "fixture-ready", START_TIMEOUT_MS);
      assert.equal(child.kill(shutdownSignal), true);

      const result = await waitForExit(child, STOP_TIMEOUT_MS);

      assert.deepEqual(result, { code: 0, signal: null });
      assert.equal(Buffer.concat(stderrChunks).toString(), "");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
}
