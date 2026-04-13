import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfirmationManager } from "../../../src/policy/confirmation.js";
import type { HAClient } from "../../../src/execution/ha-client.js";
import type { ConfirmationConfig } from "../../../src/types/policy.js";

vi.mock("../../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createMockHAClient(): HAClient {
  return {
    callService: vi.fn().mockResolvedValue(undefined),
    getEntityState: vi.fn(),
    entityExists: vi.fn(),
    getAllEntities: vi.fn(),
    isConnected: true,
    entityCount: 10,
    connectionState: "connected" as const,
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as HAClient;
}

const testConfig: ConfirmationConfig = {
  method: "notification",
  timeout_seconds: 2,
  notification_service: "notify.mobile_app_test",
  message_template: "Approve {{action}} on {{entity_id}}?",
};

describe("ConfirmationManager", () => {
  let manager: ConfirmationManager;
  let haClient: HAClient;

  beforeEach(() => {
    vi.useFakeTimers();
    haClient = createMockHAClient();
    manager = new ConfirmationManager(haClient);
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  it("sends a notification when requesting confirmation", async () => {
    const promise = manager.requestConfirmation(
      "climate.bedroom",
      "climate.set_temperature",
      testConfig,
    );

    // Allow the async notification call to complete
    await vi.advanceTimersByTimeAsync(10);

    // Should have called the notification service
    expect(haClient.callService).toHaveBeenCalledOnce();

    const callArgs = vi.mocked(haClient.callService).mock.calls[0]?.[0];
    expect(callArgs?.domain).toBe("notify");
    expect(callArgs?.service).toBe("mobile_app_test");

    expect(manager.pendingCount).toBe(1);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(2001);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.approved).toBe(false);
  });

  it("resolves as approved when manually approved", async () => {
    const promise = manager.requestConfirmation(
      "climate.bedroom",
      "climate.set_temperature",
      testConfig,
    );

    // Wait a tick for the notification to be sent
    await vi.advanceTimersByTimeAsync(10);

    // Find the token -- there should be exactly one pending
    expect(manager.pendingCount).toBe(1);

    // We need to get the token somehow -- use the resolveConfirmation with a scan
    // Since we can't access pending directly, let's use the internal mechanism
    // The promise will resolve when we call resolveConfirmation

    // Actually, the test needs the token. Let's check the notification call for it.
    const callArgs = vi.mocked(haClient.callService).mock.calls[0]?.[0];
    const serviceData = callArgs?.service_data as Record<string, unknown>;
    const data = serviceData?.["data"] as Record<string, unknown>;
    const tag = data?.["tag"] as string;
    // Token is in the tag: "gatekeeper-confirm-{token}"
    const token = tag.replace("gatekeeper-confirm-", "");

    const resolved = manager.resolveConfirmation(token, true);
    expect(resolved).toBe(true);

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("resolves as denied when manually denied", async () => {
    const promise = manager.requestConfirmation(
      "lock.front_door",
      "lock.unlock",
      testConfig,
    );

    await vi.advanceTimersByTimeAsync(10);

    const callArgs = vi.mocked(haClient.callService).mock.calls[0]?.[0];
    const serviceData = callArgs?.service_data as Record<string, unknown>;
    const data = serviceData?.["data"] as Record<string, unknown>;
    const tag = data?.["tag"] as string;
    const token = tag.replace("gatekeeper-confirm-", "");

    manager.resolveConfirmation(token, false);

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("times out after the configured timeout", async () => {
    const promise = manager.requestConfirmation(
      "climate.bedroom",
      "climate.set_temperature",
      testConfig,
    );

    await vi.advanceTimersByTimeAsync(2001);

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(manager.pendingCount).toBe(0);
  });

  it("rejects replay of consumed token", async () => {
    const promise = manager.requestConfirmation(
      "climate.bedroom",
      "climate.set_temperature",
      testConfig,
    );

    await vi.advanceTimersByTimeAsync(10);

    const callArgs = vi.mocked(haClient.callService).mock.calls[0]?.[0];
    const serviceData = callArgs?.service_data as Record<string, unknown>;
    const data = serviceData?.["data"] as Record<string, unknown>;
    const tag = data?.["tag"] as string;
    const token = tag.replace("gatekeeper-confirm-", "");

    // First resolution succeeds
    expect(manager.resolveConfirmation(token, true)).toBe(true);

    // Second resolution fails (replay prevention)
    expect(manager.resolveConfirmation(token, true)).toBe(false);

    await promise;
  });

  it("returns false for unknown token", () => {
    expect(manager.resolveConfirmation("nonexistent-token", true)).toBe(false);
  });

  it("returns denied when notification fails", async () => {
    vi.mocked(haClient.callService).mockRejectedValue(
      new Error("Notification service unavailable"),
    );

    const result = await manager.requestConfirmation(
      "climate.bedroom",
      "climate.set_temperature",
      testConfig,
    );

    expect(result.approved).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("substitutes template variables in message", async () => {
    const promise = manager.requestConfirmation(
      "climate.bedroom",
      "climate.set_temperature",
      testConfig,
    );

    const callArgs = vi.mocked(haClient.callService).mock.calls[0]?.[0];
    const serviceData = callArgs?.service_data as Record<string, unknown>;
    expect(serviceData?.["message"]).toBe(
      "Approve climate.set_temperature on climate.bedroom?",
    );

    await vi.advanceTimersByTimeAsync(2001);
    await promise;
  });
});
