export type ModerationCategory =
  | "harassment"
  | "hate"
  | "self_harm"
  | "sexual"
  | "sexual_minors"
  | "threat"
  | "violence";

export interface ModerationClassification {
  readonly categories: Readonly<Partial<Record<ModerationCategory, number>>>;
  readonly providerRequestId?: string;
}

export interface ModerationProvider {
  readonly name: string;
  classify(text: string): Promise<ModerationClassification>;
}

export type ModerationPolicyAction = "allow" | "block" | "urgent_review";

export interface ModerationPolicyDecision {
  readonly action: ModerationPolicyAction;
  readonly reasonCodes: readonly ModerationCategory[];
}

export class ModerationProviderFailure extends Error {
  public constructor(
    public readonly kind: "failure" | "timeout",
    options?: ErrorOptions,
  ) {
    super(
      kind === "timeout"
        ? "The moderation provider timed out"
        : "The moderation provider failed",
      options,
    );
    this.name = "ModerationProviderFailure";
  }
}

export class UnavailableModerationProvider implements ModerationProvider {
  public readonly name = "unavailable";

  public classify(): Promise<ModerationClassification> {
    return Promise.reject(new ModerationProviderFailure("failure"));
  }
}

export type DeterministicModerationMode =
  "allow" | "block" | "failure" | "timeout" | "urgent_review";

export class DeterministicModerationProvider implements ModerationProvider {
  public readonly name = "deterministic";

  public constructor(
    private readonly mode:
      | DeterministicModerationMode
      | ((text: string) => DeterministicModerationMode) = "allow",
  ) {}

  public async classify(text: string): Promise<ModerationClassification> {
    const mode = typeof this.mode === "function" ? this.mode(text) : this.mode;
    if (mode === "failure") {
      throw new ModerationProviderFailure("failure");
    }
    if (mode === "timeout") {
      return new Promise<ModerationClassification>(() => undefined);
    }
    if (mode === "block") {
      return { categories: { harassment: 0.99 } };
    }
    if (mode === "urgent_review") {
      return { categories: { threat: 0.99 } };
    }
    return { categories: {} };
  }
}

const URGENT_CATEGORIES = new Set<ModerationCategory>([
  "sexual_minors",
  "threat",
]);

export function decideModerationPolicy(
  classification: ModerationClassification,
): ModerationPolicyDecision {
  const flagged = Object.entries(classification.categories)
    .filter((entry): entry is [ModerationCategory, number] => {
      const score = entry[1];
      return (
        typeof score === "number" && Number.isFinite(score) && score >= 0.8
      );
    })
    .map(([category]) => category);
  if (flagged.some((category) => URGENT_CATEGORIES.has(category))) {
    return { action: "urgent_review", reasonCodes: flagged };
  }
  return flagged.length > 0
    ? { action: "block", reasonCodes: flagged }
    : { action: "allow", reasonCodes: [] };
}

export async function classifyWithTimeout(
  provider: ModerationProvider,
  text: string,
  timeoutMilliseconds: number,
): Promise<ModerationClassification> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      provider.classify(text).catch((error: unknown) => {
        if (error instanceof ModerationProviderFailure) {
          throw error;
        }
        throw new ModerationProviderFailure("failure", { cause: error });
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ModerationProviderFailure("timeout")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
