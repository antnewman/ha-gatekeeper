/**
 * SQLite-backed structured audit log with hash-chained integrity.
 *
 * Records all policy decisions, state changes, and execution outcomes
 * using better-sqlite3 in WAL mode for non-blocking writes.
 *
 * Implements Layer 08 (Cryptographic Audit Trails) from "Verified Autonomy:
 * A Field Guide to Engineering Trust in AI Systems" (Newman & Greene, 2026).
 * Each row includes a SHA-256 hash of its content and a reference to the
 * previous row's hash, creating a tamper-evident chain.
 */

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { AuditLogEntry } from "../types/audit.js";
import { logger } from "../logger.js";

/** The hash used as the previous_hash for the first row in the chain. */
const GENESIS_HASH = "GENESIS";

/** Filter options for querying the audit log. */
export interface AuditLogQueryFilters {
  entityId?: string;
  toolName?: string;
  policyDecision?: string;
  since?: string;
  limit?: number;
}

/** Result of verifying the audit log hash chain. */
export interface ChainVerificationResult {
  /** Whether the entire chain is valid. */
  valid: boolean;
  /** Total number of rows checked. */
  totalRows: number;
  /** Row ID where the chain breaks, if invalid. */
  brokenAt?: number;
}

/**
 * Build a canonical string representation of an audit row for hashing.
 *
 * Concatenates all field values in a fixed, deterministic order, separated
 * by `|`. Uses empty string for NULL values. The previous row's hash is
 * prepended to the string before hashing.
 */
function buildCanonicalString(
  previousHash: string,
  row: {
    timestamp: string | null;
    request_id: string | null;
    tool_name: string | null;
    entity_id: string | null;
    action: string | null;
    parameters: string | null;
    policy_tier: number | null;
    policy_decision: string | null;
    clamped_from: string | null;
    clamped_to: string | null;
    state_before: string | null;
    state_after: string | null;
    execution_duration_ms: number | null;
    error: string | null;
    llm_rationale: string | null;
  },
): string {
  const fields = [
    previousHash,
    row.timestamp ?? "",
    row.request_id ?? "",
    row.tool_name ?? "",
    row.entity_id ?? "",
    row.action ?? "",
    row.parameters ?? "",
    String(row.policy_tier ?? ""),
    row.policy_decision ?? "",
    row.clamped_from ?? "",
    row.clamped_to ?? "",
    row.state_before ?? "",
    row.state_after ?? "",
    String(row.execution_duration_ms ?? ""),
    row.error ?? "",
    row.llm_rationale ?? "",
  ];

  return fields.join("|");
}

/**
 * Compute SHA-256 hash of a string, returned as a hex string.
 */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Structured audit log backed by SQLite with hash-chained integrity.
 *
 * Provides write, query, verification, and retention cleanup operations.
 * Uses WAL mode for concurrent read/write performance.
 */
export class AuditLog {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private getLastHashStmt: Database.Statement;

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
    this.migrateIfNeeded();

    this.insertStmt = this.db.prepare(`
      INSERT INTO audit_log (
        timestamp, request_id, tool_name, entity_id, action, parameters,
        policy_tier, policy_decision, clamped_from, clamped_to,
        state_before, state_after, execution_duration_ms, error, llm_rationale,
        row_hash, previous_hash
      ) VALUES (
        @timestamp, @request_id, @tool_name, @entity_id, @action, @parameters,
        @policy_tier, @policy_decision, @clamped_from, @clamped_to,
        @state_before, @state_after, @execution_duration_ms, @error, @llm_rationale,
        @row_hash, @previous_hash
      )
    `);

    this.getLastHashStmt = this.db.prepare(
      "SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1",
    );

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
        row_hash TEXT NOT NULL DEFAULT '',
        previous_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_decision ON audit_log(policy_decision);
    `);
  }

  /**
   * Migrate existing tables that lack the hash chain columns.
   * Adds the columns and backfills the chain for any existing rows.
   */
  private migrateIfNeeded(): void {
    // Check if row_hash column exists
    const columns = this.db
      .prepare("PRAGMA table_info(audit_log)")
      .all() as Array<{ name: string }>;

    const hasRowHash = columns.some((c) => c.name === "row_hash");
    if (hasRowHash) {
      return;
    }

    logger.info("Migrating audit log: adding hash chain columns");

    this.db.exec(`
      ALTER TABLE audit_log ADD COLUMN row_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE audit_log ADD COLUMN previous_hash TEXT NOT NULL DEFAULT '';
    `);

    // Backfill the chain for existing rows
    const rows = this.db
      .prepare(
        "SELECT id, timestamp, request_id, tool_name, entity_id, action, parameters, policy_tier, policy_decision, clamped_from, clamped_to, state_before, state_after, execution_duration_ms, error, llm_rationale FROM audit_log ORDER BY id ASC",
      )
      .all() as Array<Record<string, unknown>>;

    const updateStmt = this.db.prepare(
      "UPDATE audit_log SET row_hash = @row_hash, previous_hash = @previous_hash WHERE id = @id",
    );

    let previousHash = GENESIS_HASH;
    for (const row of rows) {
      const canonical = buildCanonicalString(previousHash, row as Parameters<typeof buildCanonicalString>[1]);
      const rowHash = sha256(canonical);

      updateStmt.run({
        id: row["id"],
        row_hash: rowHash,
        previous_hash: previousHash,
      });

      previousHash = rowHash;
    }

    logger.info({ migratedRows: rows.length }, "Audit log hash chain backfilled");
  }

  /**
   * Get the hash of the most recent row, or GENESIS if the table is empty.
   */
  private getLastHash(): string {
    const row = this.getLastHashStmt.get() as
      | { row_hash: string }
      | undefined;
    return row?.row_hash ?? GENESIS_HASH;
  }

  /**
   * Write an audit log entry with hash chain integrity.
   *
   * @param entry - The audit log entry to record.
   */
  write(entry: AuditLogEntry): void {
    const previousHash = this.getLastHash();

    const rowData = {
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
    };

    const canonical = buildCanonicalString(previousHash, rowData);
    const rowHash = sha256(canonical);

    this.insertStmt.run({
      ...rowData,
      row_hash: rowHash,
      previous_hash: previousHash,
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
   * Verify the integrity of the audit log hash chain.
   *
   * Reads every row in order, recomputes each hash, and verifies it
   * matches the stored hash and that previous_hash references are correct.
   *
   * @returns The verification result indicating whether the chain is intact.
   */
  verifyChain(): ChainVerificationResult {
    const rows = this.db
      .prepare(
        "SELECT id, timestamp, request_id, tool_name, entity_id, action, parameters, policy_tier, policy_decision, clamped_from, clamped_to, state_before, state_after, execution_duration_ms, error, llm_rationale, row_hash, previous_hash FROM audit_log ORDER BY id ASC",
      )
      .all() as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      return { valid: true, totalRows: 0 };
    }

    let expectedPreviousHash = GENESIS_HASH;

    for (const row of rows) {
      const storedHash = row["row_hash"] as string;
      const storedPreviousHash = row["previous_hash"] as string;

      // Verify the previous_hash reference
      if (storedPreviousHash !== expectedPreviousHash) {
        return {
          valid: false,
          totalRows: rows.length,
          brokenAt: row["id"] as number,
        };
      }

      // Recompute the hash and verify it matches
      const canonical = buildCanonicalString(
        storedPreviousHash,
        row as Parameters<typeof buildCanonicalString>[1],
      );
      const computedHash = sha256(canonical);

      if (computedHash !== storedHash) {
        return {
          valid: false,
          totalRows: rows.length,
          brokenAt: row["id"] as number,
        };
      }

      expectedPreviousHash = storedHash;
    }

    return { valid: true, totalRows: rows.length };
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

  /** Expose the database for direct queries (used by verification tools). */
  getDatabase(): Database.Database {
    return this.db;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
    logger.info("Audit log closed");
  }
}
