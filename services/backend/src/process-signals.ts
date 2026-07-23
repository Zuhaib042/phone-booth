export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export interface SignalSource {
  off(signal: ShutdownSignal, listener: () => void): unknown;
  once(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface SignalSubscription {
  dispose(): void;
}

export function subscribeToShutdownSignals(
  onSignal: (signal: ShutdownSignal) => void,
  signalSource: SignalSource = process,
): SignalSubscription {
  let disposed = false;
  const handlers: Record<ShutdownSignal, () => void> = {
    SIGINT: () => onSignal("SIGINT"),
    SIGTERM: () => onSignal("SIGTERM"),
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    signalSource.once(signal, handlers[signal]);
  }

  return {
    dispose(): void {
      if (disposed) {
        return;
      }

      disposed = true;
      for (const signal of SHUTDOWN_SIGNALS) {
        signalSource.off(signal, handlers[signal]);
      }
    },
  };
}
