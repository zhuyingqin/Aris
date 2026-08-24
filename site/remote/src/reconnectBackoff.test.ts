import { describe, expect, it } from "vitest";

import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  ReconnectBackoff,
} from "./reconnectBackoff";

const noJitter = { jitterRatio: 0, random: () => 0 };

describe("ReconnectBackoff", () => {
  it("does not delay the first attempt after a healthy connection", () => {
    const backoff = new ReconnectBackoff(noJitter);

    expect(backoff.delayMs()).toBe(0);
  });

  it("grows the delay for each consecutive failure", () => {
    const backoff = new ReconnectBackoff(noJitter);

    backoff.recordFailure();
    expect(backoff.delayMs()).toBe(RECONNECT_BASE_DELAY_MS);
    backoff.recordFailure();
    expect(backoff.delayMs()).toBe(RECONNECT_BASE_DELAY_MS * 2);
    backoff.recordFailure();
    expect(backoff.delayMs()).toBe(RECONNECT_BASE_DELAY_MS * 4);
  });

  it("caps the delay so a long outage still retries on a bounded schedule", () => {
    const backoff = new ReconnectBackoff(noJitter);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      backoff.recordFailure();
    }

    expect(backoff.delayMs()).toBe(RECONNECT_MAX_DELAY_MS);
    expect(Number.isFinite(backoff.delayMs())).toBe(true);
  });

  it("spreads retries with jitter without exceeding the cap", () => {
    const backoff = new ReconnectBackoff({ jitterRatio: 0.25, random: () => 1 });
    backoff.recordFailure();

    expect(backoff.delayMs()).toBe(RECONNECT_BASE_DELAY_MS * 1.25);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      backoff.recordFailure();
    }
    expect(backoff.delayMs()).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it("returns to immediate retries once a connection succeeds", () => {
    const backoff = new ReconnectBackoff(noJitter);
    backoff.recordFailure();
    backoff.recordFailure();

    backoff.recordSuccess();

    expect(backoff.consecutiveFailures).toBe(0);
    expect(backoff.delayMs()).toBe(0);
  });
});
