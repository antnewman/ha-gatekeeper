/**
 * Home Assistant WebSocket client wrapper.
 *
 * Manages the connection to Home Assistant, maintains a real-time entity state cache,
 * and provides methods for calling services and retrieving state.
 */

import {
  createConnection,
  createLongLivedTokenAuth,
  subscribeEntities,
  callService,
  type Connection,
  type HassEntities,
  type HassEntity,
  ERR_CANNOT_CONNECT,
  ERR_INVALID_AUTH,
  ERR_CONNECTION_LOST,
  ERR_HASS_HOST_REQUIRED,
} from "home-assistant-js-websocket";
import { logger } from "../logger.js";
import type { HAConnectionState, HAServiceCall } from "../types/ha.js";

/** Options for creating the HA client. */
export interface HAClientOptions {
  /** WebSocket URL, e.g. "ws://homeassistant.local:8123/api/websocket". */
  url: string;
  /** Long-lived access token for authentication. */
  token: string;
  /** Milliseconds between reconnection attempts. */
  reconnectIntervalMs?: number;
  /** Maximum consecutive reconnection attempts before giving up. */
  maxReconnectAttempts?: number;
}

/**
 * Wraps the official `home-assistant-js-websocket` library.
 *
 * Provides:
 * - Connection lifecycle management (connect, disconnect)
 * - Real-time entity state cache via `subscribeEntities`
 * - Service call execution
 * - Connection state tracking
 */
export class HAClient {
  private readonly options: Required<HAClientOptions>;
  private connection: Connection | null = null;
  private entities: HassEntities = {};
  private unsubscribeEntities: (() => void) | null = null;
  private _connectionState: HAConnectionState = "disconnected";

  constructor(options: HAClientOptions) {
    this.options = {
      reconnectIntervalMs: options.reconnectIntervalMs ?? 5000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
      url: options.url,
      token: options.token,
    };
  }

  /** Current connection state. */
  get connectionState(): HAConnectionState {
    return this._connectionState;
  }

  /** Whether the client is currently connected. */
  get isConnected(): boolean {
    return this._connectionState === "connected";
  }

  /** Number of entities currently cached. */
  get entityCount(): number {
    return Object.keys(this.entities).length;
  }

  /**
   * Establish a WebSocket connection to Home Assistant.
   *
   * @throws If authentication fails or the connection cannot be established.
   */
  async connect(): Promise<void> {
    this._connectionState = "connecting";
    logger.info({ url: this.options.url }, "Connecting to Home Assistant");

    try {
      const auth = createLongLivedTokenAuth(
        this.options.url.replace(/^ws/, "http"),
        this.options.token,
      );

      this.connection = await createConnection({ auth });
      this._connectionState = "connected";
      logger.info("Connected to Home Assistant");

      // Subscribe to entity state updates
      this.unsubscribeEntities = subscribeEntities(
        this.connection,
        (entities) => {
          this.entities = entities;
        },
      );

      // Handle connection events
      this.connection.addEventListener("ready", () => {
        this._connectionState = "connected";
        logger.info("Home Assistant connection ready");
      });

      this.connection.addEventListener("disconnected", () => {
        this._connectionState = "disconnected";
        logger.warn("Lost connection to Home Assistant");
      });

      this.connection.addEventListener("reconnect-error", () => {
        logger.error("Home Assistant reconnection failed");
      });
    } catch (err: unknown) {
      this._connectionState = "disconnected";
      const code = typeof err === "number" ? err : undefined;

      if (code === ERR_INVALID_AUTH) {
        throw new Error("Invalid Home Assistant authentication token");
      }
      if (code === ERR_CANNOT_CONNECT) {
        throw new Error(
          `Cannot connect to Home Assistant at ${this.options.url}`,
        );
      }
      if (code === ERR_HASS_HOST_REQUIRED) {
        throw new Error("Home Assistant host URL is required");
      }
      if (code === ERR_CONNECTION_LOST) {
        throw new Error("Home Assistant connection lost during setup");
      }

      throw new Error(
        `Failed to connect to Home Assistant: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Disconnect from Home Assistant and clean up subscriptions. */
  disconnect(): void {
    if (this.unsubscribeEntities) {
      this.unsubscribeEntities();
      this.unsubscribeEntities = null;
    }
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    this.entities = {};
    this._connectionState = "disconnected";
    logger.info("Disconnected from Home Assistant");
  }

  /**
   * Get the current state of a specific entity.
   *
   * @param entityId - The entity ID, e.g. "light.living_room".
   * @returns The entity state, or undefined if the entity does not exist.
   */
  getEntityState(entityId: string): HassEntity | undefined {
    return this.entities[entityId];
  }

  /**
   * Check whether an entity exists in the current state cache.
   *
   * @param entityId - The entity ID to check.
   */
  entityExists(entityId: string): boolean {
    return entityId in this.entities;
  }

  /**
   * Get all cached entity states.
   *
   * @returns A shallow copy of the entities map.
   */
  getAllEntities(): HassEntities {
    return { ...this.entities };
  }

  /**
   * Call a Home Assistant service.
   *
   * @param serviceCall - The service call parameters.
   * @throws If not connected or the service call fails.
   */
  async callService(serviceCall: HAServiceCall): Promise<void> {
    if (!this.connection) {
      throw new Error("Not connected to Home Assistant");
    }

    logger.debug(
      {
        domain: serviceCall.domain,
        service: serviceCall.service,
        target: serviceCall.target,
      },
      "Calling Home Assistant service",
    );

    await callService(
      this.connection,
      serviceCall.domain,
      serviceCall.service,
      serviceCall.service_data,
      serviceCall.target,
    );
  }

  /**
   * Send a raw WebSocket message to Home Assistant.
   * Used for commands not covered by the helper functions (e.g. get_config health check).
   *
   * @param message - The message to send.
   * @returns The response from Home Assistant.
   * @throws If not connected.
   */
  async sendMessage<T>(message: {
    type: string;
    [key: string]: unknown;
  }): Promise<T> {
    if (!this.connection) {
      throw new Error("Not connected to Home Assistant");
    }

    return this.connection.sendMessagePromise(message);
  }
}
