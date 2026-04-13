/**
 * SQLite-backed structured audit log.
 *
 * Records all policy decisions, state changes, and execution outcomes
 * using better-sqlite3 in WAL mode for non-blocking writes.
 */

import Database from "better-sqlite3";
import type { AuditLogEntry } from "../types/audit.js";
import { logger } from "../logger.js";

/** Filter options for querying the audit log. */
export interface AuditLogQueryFilters {
  entityId?: string;
  toolName?: string;
  policyDecision?: string;
  since?: string;
  limit?: number;
}

/**
 * Structured audit log backed by SQLite.
 *
 * Provides write, query, and retention cleanup operations.
 * Uses WAL mode for concurrent read/write performance.
 */
export class AuditLog {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  /**
   * Create a new audit log instance.
   *
   * @param databasePath - Path to the SQLite database file. Use ":memory:" for testing.
   */
  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    this.createSchema();

    this.insertStmt = this.db.prepare(`
      INSERT INTO audit_log (
        timestamp, request_id, tool_name, entity_id, action, parameters,
        policy_tier, policy_decision, clamped_from, clamped_to,
        state_before, state_after, execution_duration_ms, error, llm_rationale
      ) VALUES (
        @timestamp, @request_id, @tool_name, @entity_id, @action, @parameters,
        @policy_tier, @policy_decision, @clamped_from, @clamped_to,
        @state_before, @state_after, @execution_duration_ms, @error, @llm_rationale
      )
    `);

    logger.info({ databasePath }, "Audit log initialised");
  }

  /** Create the audit log table and indexes if they do not exist. */
  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        request_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        entity_id TEXT,
        action TEXT,
        parameters TEXT,
        policy_tier INTEGER NOT NULL,
        policy_decision TEXT NOT NULL,
        clamped_from TEXT,
        clamped_to TEXT,
        state_before TEXT,
        state_after TEXT,
        execution_duration_ms INTEGER,
        error TEXT,
        llm_rationale TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_decision ON audit_log(policy_decision);
    `);
  }

  /**
   * Write an audit log entry.
   *
   * @param entry - The audit log entry to record.
   */
  write(entry: AuditLogEntry): void {
    this.insertStmt.run({
      timestamp: entry.timestamp,
      request_id: entry.request_id,
      tool_name: entry.tool_name,
      entity_id: entry.entity_id ?? null,
      action: entry.action ?? null,
      parameters: entry.parameters ?? null,
      policy_tier: entry.policy_tier,
      policy_decision: entry.policy_decision,
      clamped_from: entry.clamped_from ?? null,
      clamped_to: entry.clamped_to ?? null,
      state_before: entry.state_before ?? null,
      state_after: entry.state_after ?? null,
      execution_duration_ms: entry.execution_duration_ms ?? null,
      error: entry.error ?? null,
      llm_rationale: entry.llm_rationale ?? null,
    });
  }

  /**
   * Query audit log entries with optional filters.
   *
   * @param filters - Optional filters to narrow the results.
   * @returns Matching audit log entries, most recent first.
   */
  query(filters?: AuditLogQueryFilters): AuditLogEntry[] {
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};

    if (filters?.entityId) {
      conditions.push("entity_id = @entityId");
      params["entityId"] = filters.entityId;
    }

    if (filters?.toolName) {
      conditions.push("tool_name = @toolName");
      params["toolName"] = filters.toolName;
    }

    if (filters?.policyDecision) {
      conditions.push("policy_decision = @policyDecision");
      params["policyDecision"] = filters.policyDecision;
    }

    if (filters?.since) {
      conditions.push("timestamp >= @since");
      params["since"] = filters.since;
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters?.limit ?? 100;

    const sql = `SELECT * FROM audit_log ${whereClause} ORDER BY id DESC LIMIT @limit`;
    params["limit"] = limit;

    const stmt = this.db.prepare(sql);
    return stmt.all(params) as AuditLogEntry[];
  }

  /**
   * Delete audit log entries older than the specified retention period.
   *
   * @param retentionDays - Entries older than this many days will be deleted.
   * @returns The number of rows deleted.
   */
  cleanup(retentionDays: number): number {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const stmt = this.db.prepare(
      "DELETE FROM audit_log WHERE timestamp < @cutoff",
    );
    const result = stmt.run({ cutoff });
    const deleted = result.changes;

    if (deleted > 0) {
      logger.info({ deleted, retentionDays }, "Audit log cleanup complete");
    }

    return deleted;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
    logger.info("Audit log closed");
  }
}
