import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AuditLog } from "../../../src/observability/audit-log.js";
import type { AuditLogEntry } from "../../../src/types/audit.js";

vi.mock("../../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createEntry(overrides?: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    timestamp: new Date().toISOString(),
    request_id: "req-001",
    tool_name: "turn_on",
    entity_id: "light.living_room",
    action: "light.turn_on",
    policy_tier: 1,
    policy_decision: "allowed",
    ...overrides,
  };
}

describe("Audit Log Hash Chain", () => {
  let auditLog: AuditLog;

  beforeEach(() => {
    auditLog = new AuditLog(":memory:");
  });

  afterEach(() => {
    auditLog.close();
  });

  it("writes a valid chain of 5 entries", () => {
    for (let i = 0; i < 5; i++) {
      auditLog.write(createEntry({ request_id: `req-${String(i)}` }));
    }

    const result = auditLog.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.totalRows).toBe(5);
    expect(result.brokenAt).toBeUndefined();
  });

  it("detects a corrupted row (data tampered)", () => {
    for (let i = 0; i < 5; i++) {
      auditLog.write(createEntry({ request_id: `req-${String(i)}` }));
    }

    // Manually corrupt a row's data in SQLite
    const db = auditLog.getDatabase();
    db.prepare(
      "UPDATE audit_log SET entity_id = 'TAMPERED' WHERE id = 3",
    ).run();

    const result = auditLog.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.totalRows).toBe(5);
    expect(result.brokenAt).toBe(3);
  });

  it("detects a corrupted previous_hash", () => {
    for (let i = 0; i < 5; i++) {
      auditLog.write(createEntry({ request_id: `req-${String(i)}` }));
    }

    // Manually change a previous_hash
    const db = auditLog.getDatabase();
    db.prepare(
      "UPDATE audit_log SET previous_hash = 'FAKE_HASH' WHERE id = 4",
    ).run();

    const result = auditLog.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(4);
  });

  it("first entry has previous_hash = GENESIS", () => {
    auditLog.write(createEntry());

    const db = auditLog.getDatabase();
    const row = db.prepare("SELECT previous_hash FROM audit_log WHERE id = 1").get() as { previous_hash: string };

    expect(row.previous_hash).toBe("GENESIS");
  });

  it("empty database verification returns valid with 0 rows", () => {
    const result = auditLog.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.totalRows).toBe(0);
    expect(result.brokenAt).toBeUndefined();
  });

  it("hash is deterministic: same input produces same hash", () => {
    const entry = createEntry({
      timestamp: "2026-04-14T12:00:00.000Z",
      request_id: "deterministic-test",
    });

    const log1 = new AuditLog(":memory:");
    log1.write(entry);
    const db1 = log1.getDatabase();
    const row1 = db1.prepare("SELECT row_hash FROM audit_log WHERE id = 1").get() as { row_hash: string };
    log1.close();

    const log2 = new AuditLog(":memory:");
    log2.write(entry);
    const db2 = log2.getDatabase();
    const row2 = db2.prepare("SELECT row_hash FROM audit_log WHERE id = 1").get() as { row_hash: string };
    log2.close();

    expect(row1.row_hash).toBe(row2.row_hash);
  });

  it("canonical string handles NULL values consistently", () => {
    // Entry with minimal fields (lots of NULLs)
    auditLog.write({
      timestamp: "2026-04-14T12:00:00.000Z",
      request_id: "minimal-test",
      tool_name: "get_entity_state",
      policy_tier: 0,
      policy_decision: "allowed",
    });

    const result = auditLog.verifyChain();
    expect(result.valid).toBe(true);
  });

  it("each row's hash depends on the previous row", () => {
    auditLog.write(createEntry({ request_id: "first" }));
    auditLog.write(createEntry({ request_id: "second" }));

    const db = auditLog.getDatabase();
    const row1 = db.prepare("SELECT row_hash FROM audit_log WHERE id = 1").get() as { row_hash: string };
    const row2 = db.prepare("SELECT previous_hash FROM audit_log WHERE id = 2").get() as { previous_hash: string };

    // Row 2's previous_hash should equal row 1's row_hash
    expect(row2.previous_hash).toBe(row1.row_hash);
  });

  it("chain breaks at the first corrupted row, not later ones", () => {
    for (let i = 0; i < 5; i++) {
      auditLog.write(createEntry({ request_id: `req-${String(i)}` }));
    }

    // Corrupt row 2 -- rows 2, 3, 4, 5 would all be affected but
    // the report should point to row 2
    const db = auditLog.getDatabase();
    db.prepare("UPDATE audit_log SET tool_name = 'CORRUPTED' WHERE id = 2").run();

    const result = auditLog.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it("backwards compatibility: new audit log works with hash columns from the start", () => {
    // Verify that the new schema (with hash columns) is created correctly
    // and that writing and verifying works from scratch
    const freshLog = new AuditLog(":memory:");
    freshLog.write(createEntry({ request_id: "compat-1" }));
    freshLog.write(createEntry({ request_id: "compat-2" }));

    const result = freshLog.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.totalRows).toBe(2);

    // Verify the hash columns are populated
    const db = freshLog.getDatabase();
    const row = db.prepare("SELECT row_hash, previous_hash FROM audit_log WHERE id = 1").get() as { row_hash: string; previous_hash: string };
    expect(row.row_hash).toBeTruthy();
    expect(row.row_hash.length).toBe(64); // SHA-256 hex = 64 chars
    expect(row.previous_hash).toBe("GENESIS");

    freshLog.close();
  });
});
