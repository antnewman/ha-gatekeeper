import { describe, it, expect, vi, beforeEach } from "vitest";
import { HAClient } from "../../../src/execution/ha-client.js";

// Mock the home-assistant-js-websocket module
vi.mock("home-assistant-js-websocket", () => ({
  createConnection: vi.fn(),
  createLongLivedTokenAuth: vi.fn(),
  subscribeEntities: vi.fn(),
  callService: vi.fn(),
  ERR_CANNOT_CONNECT: 1,
  ERR_INVALID_AUTH: 2,
  ERR_CONNECTION_LOST: 3,
  ERR_HASS_HOST_REQUIRED: 4,
}));

// Suppress pino output during tests
vi.mock("../../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

const haWs = await import("home-assistant-js-websocket");

function createMockConnection(): {
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  sendMessagePromise: ReturnType<typeof vi.fn>;
} {
  return {
    addEventListener: vi.fn(),
    close: vi.fn(),
    sendMessagePromise: vi.fn(),
  };
}

describe("HAClient", () => {
  let client: HAClient;

  beforeEach(() => {
    vi.clearAllMocks();

    client = new HAClient({
      url: "ws://localhost:8123/api/websocket",
      token: "test-token",
    });
  });

  describe("constructor", () => {
    it("sets default options when not provided", () => {
      expect(client.connectionState).toBe("disconnected");
      expect(client.isConnected).toBe(false);
      expect(client.entityCount).toBe(0);
    });
  });

  describe("connect", () => {
    it("connects successfully and subscribes to entities", async () => {
      const mockConn = createMockConnection();
      vi.mocked(haWs.createConnection).mockResolvedValue(
        mockConn as unknown as Awaited<ReturnType<typeof haWs.createConnection>>,
      );
      vi.mocked(haWs.subscribeEntities).mockReturnValue(vi.fn());

      await client.connect();

      expect(client.connectionState).toBe("connected");
      expect(client.isConnected).toBe(true);
      expect(haWs.createLongLivedTokenAuth).toHaveBeenCalledWith(
        "http://localhost:8123/api/websocket",
        "test-token",
      );
      expect(haWs.subscribeEntities).toHaveBeenCalledOnce();
      expect(mockConn.addEventListener).toHaveBeenCalledWith(
        "ready",
        expect.any(Function),
      );
      expect(mockConn.addEventListener).toHaveBeenCalledWith(
        "disconnected",
        expect.any(Function),
      );
    });

    it("throws on invalid authentication", async () => {
      vi.mocked(haWs.createConnection).mockRejectedValue(
        haWs.ERR_INVALID_AUTH,
      );

      await expect(client.connect()).rejects.toThrow(
        "Invalid Home Assistant authentication token",
      );
      expect(client.connectionState).toBe("disconnected");
    });

    it("throws when it cannot connect", async () => {
      vi.mocked(haWs.createConnection).mockRejectedValue(
        haWs.ERR_CANNOT_CONNECT,
      );

      await expect(client.connect()).rejects.toThrow(
        "Cannot connect to Home Assistant",
      );
      expect(client.connectionState).toBe("disconnected");
    });
  });

  describe("disconnect", () => {
    it("cleans up connection and subscriptions", async () => {
      const mockConn = createMockConnection();
      const unsubscribe = vi.fn();
      vi.mocked(haWs.createConnection).mockResolvedValue(
        mockConn as unknown as Awaited<ReturnType<typeof haWs.createConnection>>,
      );
      vi.mocked(haWs.subscribeEntities).mockReturnValue(unsubscribe);

      await client.connect();
      client.disconnect();

      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(mockConn.close).toHaveBeenCalledOnce();
      expect(client.connectionState).toBe("disconnected");
      expect(client.entityCount).toBe(0);
    });
  });

  describe("entity operations", () => {
    it("returns undefined for non-existent entity", () => {
      expect(client.getEntityState("sensor.nonexistent")).toBeUndefined();
    });

    it("reports non-existent entity correctly", () => {
      expect(client.entityExists("sensor.nonexistent")).toBe(false);
    });

    it("returns empty entities when not connected", () => {
      const entities = client.getAllEntities();
      expect(Object.keys(entities)).toHaveLength(0);
    });
  });

  describe("callService", () => {
    it("throws when not connected", async () => {
      await expect(
        client.callService({
          domain: "light",
          service: "turn_on",
          target: { entity_id: "light.test" },
        }),
      ).rejects.toThrow("Not connected to Home Assistant");
    });

    it("calls the HA service when connected", async () => {
      const mockConn = createMockConnection();
      vi.mocked(haWs.createConnection).mockResolvedValue(
        mockConn as unknown as Awaited<ReturnType<typeof haWs.createConnection>>,
      );
      vi.mocked(haWs.subscribeEntities).mockReturnValue(vi.fn());
      vi.mocked(haWs.callService).mockResolvedValue(undefined);

      await client.connect();

      await client.callService({
        domain: "light",
        service: "turn_on",
        target: { entity_id: "light.test" },
        service_data: { brightness: 255 },
      });

      expect(haWs.callService).toHaveBeenCalledWith(
        mockConn,
        "light",
        "turn_on",
        { brightness: 255 },
        { entity_id: "light.test" },
      );
    });
  });

  describe("sendMessage", () => {
    it("throws when not connected", async () => {
      await expect(
        client.sendMessage({ type: "get_config" }),
      ).rejects.toThrow("Not connected to Home Assistant");
    });

    it("sends a message when connected", async () => {
      const mockConn = createMockConnection();
      const mockResponse = { version: "2026.4.0" };
      mockConn.sendMessagePromise.mockResolvedValue(mockResponse);
      vi.mocked(haWs.createConnection).mockResolvedValue(
        mockConn as unknown as Awaited<ReturnType<typeof haWs.createConnection>>,
      );
      vi.mocked(haWs.subscribeEntities).mockReturnValue(vi.fn());

      await client.connect();

      const result = await client.sendMessage<{ version: string }>({
        type: "get_config",
      });

      expect(result).toEqual(mockResponse);
      expect(mockConn.sendMessagePromise).toHaveBeenCalledWith({
        type: "get_config",
      });
    });
  });
});
