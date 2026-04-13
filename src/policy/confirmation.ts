/**
 * Human-in-the-loop confirmation flow for Tier 2 actions.
 *
 * Generates confirmation tokens, sends notifications via Home Assistant,
 * and handles webhook responses for approval or denial.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { HAClient } from "../execution/ha-client.js";
import type { ConfirmationConfig } from "../types/policy.js";
import { logger } from "../logger.js";

/** Result of a confirmation request. */
export interface ConfirmationResult {
  approved: boolean;
  timedOut: boolean;
  token: string;
}

/** Pending confirmation with its resolution callback. */
interface PendingConfirmation {
  entityId: string;
  action: string;
  resolve: (result: ConfirmationResult) => void;
  timer: ReturnType<typeof setTimeout>;
  token: string;
  consumed: boolean;
}

/**
 * Manages HITL confirmation requests for Tier 2 actions.
 *
 * Provides:
 * - Token generation and storage
 * - HA notification dispatch
 * - Webhook endpoint for confirmation responses
 * - Timeout handling and token expiry
 * - Replay prevention (tokens are single-use)
 */
export class ConfirmationManager {
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly haClient: HAClient;
  private webhookServer: Server | null = null;

  constructor(haClient: HAClient) {
    this.haClient = haClient;
  }

  /**
   * Start the webhook server for receiving confirmation responses.
   *
   * @param port - The port to listen on.
   */
  startWebhookServer(port: number): void {
    const app = express();
    app.use(express.json());

    app.post("/api/confirm/:token", (req, res) => {
      const { token } = req.params;

      if (!token) {
        res.status(400).json({ error: "Missing token" });
        return;
      }

      const pending = this.pending.get(token);
      if (!pending) {
        res.status(404).json({ error: "Token not found or expired" });
        return;
      }

      if (pending.consumed) {
        res.status(409).json({ error: "Token already used" });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const approved = body["approved"] === true;

      pending.consumed = true;
      clearTimeout(pending.timer);
      this.pending.delete(token);

      pending.resolve({
        approved,
        timedOut: false,
        token,
      });

      logger.info(
        { token, entityId: pending.entityId, approved },
        "Confirmation response received",
      );

      res.json({ status: approved ? "approved" : "denied" });
    });

    this.webhookServer = app.listen(port, () => {
      logger.info({ port }, "Confirmation webhook server started");
    });
  }

  /**
   * Request human confirmation for a Tier 2 action.
   *
   * Sends a notification via Home Assistant and waits for a response
   * through the webhook endpoint, or times out.
   *
   * @param entityId - The entity being acted upon.
   * @param action - The action being performed.
   * @param config - The confirmation configuration.
   * @returns The confirmation result.
   */
  async requestConfirmation(
    entityId: string,
    action: string,
    config: ConfirmationConfig,
  ): Promise<ConfirmationResult> {
    const token = randomUUID();

    // Build notification message from template
    const message = config.message_template
      .replace("{{action}}", action)
      .replace("{{entity_id}}", entityId);

    // Send notification via HA
    const notifyDomain = config.notification_service.split(".")[0] ?? "notify";
    const notifyService =
      config.notification_service.split(".").slice(1).join(".") || "notify";

    try {
      await this.haClient.callService({
        domain: notifyDomain,
        service: notifyService,
        service_data: {
          message,
          title: "ha-gatekeeper Confirmation",
          data: {
            actions: [
              { action: "APPROVE", title: "Approve" },
              { action: "DENY", title: "Deny" },
            ],
            tag: `gatekeeper-confirm-${token}`,
            url: `/api/confirm/${token}`,
          },
        },
      });
    } catch (err: unknown) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          entityId,
          action,
        },
        "Failed to send confirmation notification",
      );

      return { approved: false, timedOut: false, token };
    }

    // Wait for response or timeout
    return new Promise<ConfirmationResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(token);
        if (pending && !pending.consumed) {
          this.pending.delete(token);

          logger.info(
            { token, entityId, action, timeoutSeconds: config.timeout_seconds },
            "Confirmation timed out",
          );

          resolve({ approved: false, timedOut: true, token });
        }
      }, config.timeout_seconds * 1000);

      this.pending.set(token, {
        entityId,
        action,
        resolve,
        timer,
        token,
        consumed: false,
      });
    });
  }

  /**
   * Manually resolve a pending confirmation (for testing or programmatic approval).
   *
   * @param token - The confirmation token.
   * @param approved - Whether the action is approved.
   * @returns Whether the token was found and resolved.
   */
  resolveConfirmation(token: string, approved: boolean): boolean {
    const pending = this.pending.get(token);
    if (!pending || pending.consumed) {
      return false;
    }

    pending.consumed = true;
    clearTimeout(pending.timer);
    this.pending.delete(token);

    pending.resolve({ approved, timedOut: false, token });
    return true;
  }

  /** Get the number of pending confirmations. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Clean up all resources. */
  destroy(): void {
    // Clear all pending timers
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }
    this.pending.clear();

    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = null;
    }
  }
}
