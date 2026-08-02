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
const IDENTITY_PROVIDERS = ["disabled", "development", "apple"] as const;
const CHAT_MODERATION_PROVIDERS = ["disabled", "deterministic"] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type IdentityProviderName = (typeof IDENTITY_PROVIDERS)[number];

export interface RuntimeConfig {
  readonly logLevel: LogLevel;
  readonly nodeEnvironment: NodeEnvironment;
}

export interface ApiConfig extends RuntimeConfig {
  readonly host: string;
  readonly port: number;
}

export interface WorkerConfig extends RuntimeConfig {
  readonly readinessFile: string;
}

export interface ReliableJobConfig {
  readonly batchSize: number;
  readonly leaseMilliseconds: number;
  readonly outboxChannel: string;
  readonly pollIntervalMilliseconds: number;
}

export interface MatchmakingConfig {
  readonly lobbyReadyTimeoutSeconds: number;
  readonly readyTimeoutSeconds: number;
  readonly recentPairingWindowSeconds: number;
}

export interface RealtimeConfig {
  readonly heartbeatIntervalMilliseconds: number;
  readonly heartbeatTimeoutMilliseconds: number;
  readonly resumeLimit: number;
}

export interface ChatConfig {
  readonly duplicateWindowSeconds: number;
  readonly maximumTypedMessageCharacters: number;
  readonly moderationProvider: (typeof CHAT_MODERATION_PROVIDERS)[number];
  readonly moderationTimeoutMilliseconds: number;
  readonly rapidTargetLimit: number;
  readonly rateLimitWindowSeconds: number;
  readonly threadRateLimit: number;
  readonly userRateLimit: number;
}

export interface EconomyRuntimeConfig {
  readonly fixtureValuesEnabled: boolean;
}

export interface DatastoreConfig {
  readonly databaseUrl: string;
  readonly valkeyUrl: string;
}

export interface PostgresConfig {
  readonly databaseUrl: string;
}

interface IdentityConfigBase {
  readonly accessTokenTtlSeconds: number;
  readonly accountDeletionDelaySeconds: number;
  readonly refreshTokenTtlSeconds: number;
}

export type IdentityConfig =
  | (IdentityConfigBase & {
      readonly provider: "disabled";
    })
  | (IdentityConfigBase & {
      readonly provider: "development";
    })
  | (IdentityConfigBase & {
      readonly appleClientId: string;
      readonly provider: "apple";
    });

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

function readInteger(
  environment: Environment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = readNonEmpty(environment, key, String(fallback));
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(
      `${key} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigError(
      `${key} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}

function readConnectionUrl(
  environment: Environment,
  key: string,
  protocols: readonly string[],
): string {
  const value = environment[key];
  if (value === undefined) {
    throw new ConfigError(`${key} is required`);
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ConfigError(`${key} must not be empty`);
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new ConfigError(`${key} must be a valid connection URL`);
  }

  if (!protocols.includes(parsed.protocol) || parsed.hostname.length === 0) {
    throw new ConfigError(
      `${key} must use one of these protocols: ${protocols.join(", ")}`,
    );
  }

  return normalized;
}

export function loadApiConfig(
  environment: Environment = process.env,
): ApiConfig {
  return {
    ...loadRuntimeConfig(environment),
    host: readNonEmpty(environment, "HOST", "0.0.0.0"),
    port: readPort(environment),
  };
}

export function loadRuntimeConfig(
  environment: Environment = process.env,
): RuntimeConfig {
  return {
    logLevel: readChoice(environment, "LOG_LEVEL", "info", LOG_LEVELS),
    nodeEnvironment: readChoice(
      environment,
      "NODE_ENV",
      "development",
      NODE_ENVIRONMENTS,
    ),
  };
}

export function loadDatastoreConfig(
  environment: Environment = process.env,
): DatastoreConfig {
  return {
    ...loadPostgresConfig(environment),
    valkeyUrl: readConnectionUrl(environment, "VALKEY_URL", [
      "redis:",
      "rediss:",
    ]),
  };
}

export function loadPostgresConfig(
  environment: Environment = process.env,
): PostgresConfig {
  return {
    databaseUrl: readConnectionUrl(environment, "DATABASE_URL", [
      "postgres:",
      "postgresql:",
    ]),
  };
}

export function loadIdentityConfig(
  environment: Environment = process.env,
): IdentityConfig {
  const { nodeEnvironment } = loadRuntimeConfig(environment);
  const provider = readChoice(
    environment,
    "IDENTITY_PROVIDER",
    "disabled",
    IDENTITY_PROVIDERS,
  );
  const accessTokenTtlSeconds = readInteger(
    environment,
    "ACCESS_TOKEN_TTL_SECONDS",
    900,
    60,
    3_600,
  );
  const refreshTokenTtlSeconds = readInteger(
    environment,
    "REFRESH_TOKEN_TTL_SECONDS",
    2_592_000,
    3_600,
    7_776_000,
  );
  if (refreshTokenTtlSeconds <= accessTokenTtlSeconds) {
    throw new ConfigError(
      "REFRESH_TOKEN_TTL_SECONDS must be greater than ACCESS_TOKEN_TTL_SECONDS",
    );
  }
  const common = {
    accessTokenTtlSeconds,
    accountDeletionDelaySeconds: readInteger(
      environment,
      "ACCOUNT_DELETION_DELAY_SECONDS",
      0,
      0,
      604_800,
    ),
    refreshTokenTtlSeconds,
  };

  if (provider === "development" && nodeEnvironment === "production") {
    throw new ConfigError(
      "IDENTITY_PROVIDER=development is forbidden when NODE_ENV=production",
    );
  }
  if (provider === "apple") {
    return {
      ...common,
      appleClientId: readNonEmpty(environment, "APPLE_CLIENT_ID", ""),
      provider,
    };
  }
  return { ...common, provider };
}

export function loadWorkerConfig(
  environment: Environment = process.env,
): WorkerConfig {
  return {
    ...loadRuntimeConfig(environment),
    readinessFile: readNonEmpty(
      environment,
      "WORKER_READY_FILE",
      "/tmp/project-booth-worker-ready",
    ),
  };
}

export function loadReliableJobConfig(
  environment: Environment = process.env,
): ReliableJobConfig {
  return {
    batchSize: readInteger(environment, "WORKER_BATCH_SIZE", 25, 1, 100),
    leaseMilliseconds: readInteger(
      environment,
      "WORKER_LEASE_MS",
      30_000,
      1_000,
      300_000,
    ),
    outboxChannel: readNonEmpty(
      environment,
      "OUTBOX_CHANNEL",
      "project-booth:events",
    ),
    pollIntervalMilliseconds: readInteger(
      environment,
      "WORKER_POLL_INTERVAL_MS",
      250,
      25,
      60_000,
    ),
  };
}

export function loadMatchmakingConfig(
  environment: Environment = process.env,
): MatchmakingConfig {
  return {
    lobbyReadyTimeoutSeconds: readInteger(
      environment,
      "MATCH_LOBBY_READY_TIMEOUT_SECONDS",
      30,
      5,
      300,
    ),
    readyTimeoutSeconds: readInteger(
      environment,
      "MATCHMAKING_READY_TIMEOUT_SECONDS",
      15,
      5,
      120,
    ),
    recentPairingWindowSeconds: readInteger(
      environment,
      "MATCHMAKING_RECENT_PAIRING_SECONDS",
      86_400,
      0,
      2_592_000,
    ),
  };
}

export function loadEconomyRuntimeConfig(
  environment: Environment = process.env,
): EconomyRuntimeConfig {
  const { nodeEnvironment } = loadRuntimeConfig(environment);
  const fixtureValuesEnabled =
    readChoice(
      environment,
      "ECONOMY_FIXTURE_VALUES",
      nodeEnvironment === "production" ? "disabled" : "enabled",
      ["disabled", "enabled"] as const,
    ) === "enabled";
  if (fixtureValuesEnabled && nodeEnvironment === "production") {
    throw new ConfigError(
      "ECONOMY_FIXTURE_VALUES=enabled is forbidden when NODE_ENV=production",
    );
  }
  return { fixtureValuesEnabled };
}

export function loadRealtimeConfig(
  environment: Environment = process.env,
): RealtimeConfig {
  const heartbeatIntervalMilliseconds = readInteger(
    environment,
    "REALTIME_HEARTBEAT_INTERVAL_MS",
    10_000,
    1_000,
    60_000,
  );
  const heartbeatTimeoutMilliseconds = readInteger(
    environment,
    "REALTIME_HEARTBEAT_TIMEOUT_MS",
    30_000,
    heartbeatIntervalMilliseconds + 1,
    180_000,
  );
  return {
    heartbeatIntervalMilliseconds,
    heartbeatTimeoutMilliseconds,
    resumeLimit: readInteger(environment, "REALTIME_RESUME_LIMIT", 100, 1, 500),
  };
}

export function loadChatConfig(
  environment: Environment = process.env,
): ChatConfig {
  const { nodeEnvironment } = loadRuntimeConfig(environment);
  const moderationProvider = readChoice(
    environment,
    "CHAT_MODERATION_PROVIDER",
    nodeEnvironment === "production" ? "disabled" : "deterministic",
    CHAT_MODERATION_PROVIDERS,
  );
  if (
    nodeEnvironment === "production" &&
    moderationProvider === "deterministic"
  ) {
    throw new ConfigError(
      "CHAT_MODERATION_PROVIDER=deterministic is forbidden when NODE_ENV=production",
    );
  }
  return {
    duplicateWindowSeconds: readInteger(
      environment,
      "CHAT_DUPLICATE_WINDOW_SECONDS",
      30,
      1,
      600,
    ),
    maximumTypedMessageCharacters: readInteger(
      environment,
      "CHAT_MAX_TYPED_CHARACTERS",
      240,
      1,
      240,
    ),
    moderationProvider,
    moderationTimeoutMilliseconds: readInteger(
      environment,
      "CHAT_MODERATION_TIMEOUT_MS",
      1_500,
      10,
      10_000,
    ),
    rapidTargetLimit: readInteger(
      environment,
      "CHAT_RAPID_TARGET_LIMIT",
      3,
      1,
      5,
    ),
    rateLimitWindowSeconds: readInteger(
      environment,
      "CHAT_RATE_WINDOW_SECONDS",
      10,
      1,
      300,
    ),
    threadRateLimit: readInteger(
      environment,
      "CHAT_THREAD_RATE_LIMIT",
      4,
      1,
      100,
    ),
    userRateLimit: readInteger(environment, "CHAT_USER_RATE_LIMIT", 6, 1, 200),
  };
}
