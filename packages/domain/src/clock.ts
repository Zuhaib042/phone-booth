import type { UtcTimestamp } from "./timestamp.js";

export interface Clock {
  now(): UtcTimestamp;
}
