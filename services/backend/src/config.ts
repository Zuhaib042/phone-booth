const NODE_ENVIRONMENTS = ["development", "test", "production"] as const;
const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ApiConfig {
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly nodeEnvironment: NodeEnvironment;
  readonly port: number;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readNonEmpty(
  environment: Environment,
  key: string,
  fallback: string,
): string {
  const value = environment[key] ?? fallback;
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new ConfigError(`${key} must not be empty`);
  }

  return normalized;
}

function readChoice<const Choice extends string>(
  environment: Environment,
  key: string,
  fallback: Choice,
  choices: readonly Choice[],
): Choice {
  const value = readNonEmpty(environment, key, fallback);

  if (!choices.some((choice) => choice === value)) {
    throw new ConfigError(`${key} must be one of: ${choices.join(", ")}`);
  }

  return value as Choice;
}

function readPort(environment: Environment): number {
  const value = readNonEmpty(environment, "PORT", "3000");

  if (!/^\d+$/.test(value)) {
    throw new ConfigError("PORT must be an integer from 0 to 65535");
  }

  const port = Number(value);

  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError("PORT must be an integer from 0 to 65535");
  }

  return port;
}

export function loadApiConfig(
  environment: Environment = process.env,
): ApiConfig {
  return {
    host: readNonEmpty(environment, "HOST", "0.0.0.0"),
    logLevel: readChoice(environment, "LOG_LEVEL", "info", LOG_LEVELS),
    nodeEnvironment: readChoice(
      environment,
      "NODE_ENV",
      "development",
      NODE_ENVIRONMENTS,
    ),
    port: readPort(environment),
  };
}
