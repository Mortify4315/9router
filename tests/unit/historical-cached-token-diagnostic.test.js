import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeDatabase,
  extractCachedTokenMetadata,
} from "../../scripts/analyze-cached-token-backfill.mjs";

const tempFiles = [];

afterEach(() => {
  for (const file of tempFiles.splice(0)) fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cache-analysis-"));
  const file = path.join(dir, "data.sqlite");
  tempFiles.push(file);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE usageHistory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, provider TEXT,
      model TEXT, connectionId TEXT, promptTokens INTEGER, completionTokens INTEGER,
      cost REAL, tokens TEXT
    );
    CREATE TABLE usageDaily (dateKey TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE requestDetails (
      id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, provider TEXT, model TEXT,
      connectionId TEXT, status TEXT, data TEXT NOT NULL
    );
  `);
  return { db, file };
}

function insertUsage(db, id, cachedTokens) {
  const tokens = { prompt_tokens: 27985, completion_tokens: 60, cached_tokens: cachedTokens };
  db.prepare(`INSERT INTO usageHistory(id, timestamp, provider, model, connectionId, promptTokens, completionTokens, cost, tokens)
    VALUES (?, ?, 'codex', 'gpt-5.6-sol', 'conn-1', 27985, 60, 0.141725, ?)`)
    .run(id, `2026-07-28T00:00:0${id}.000Z`, JSON.stringify(tokens));
}

function insertDetail(db, id, tokens) {
  const data = { id, timestamp: "2026-07-28T00:00:00.001Z", provider: "codex", model: "gpt-5.6-sol", connectionId: "conn-1", tokens };
  db.prepare(`INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data)
    VALUES (?, ?, 'codex', 'gpt-5.6-sol', 'conn-1', 'success', ?)`)
    .run(id, data.timestamp, JSON.stringify(data));
}

describe("historical cached-token diagnostic", () => {
  it("extracts nested OpenAI cache metadata without changing prompt tokens", () => {
    const result = extractCachedTokenMetadata({
      prompt_tokens: 27985,
      completion_tokens: 60,
      prompt_tokens_details: { cached_tokens: 27136 },
    });
    expect(result).toEqual({ status: "positive", cachedTokens: 27136, promptTokens: 27985 });
  });

  it("distinguishes explicit zero, missing metadata, and malformed values", () => {
    expect(extractCachedTokenMetadata({ prompt_tokens_details: { cached_tokens: 0 } }).status).toBe("true-zero-cache");
    expect(extractCachedTokenMetadata({ prompt_tokens: 10 }).status).toBe("missing-cache-metadata");
    expect(extractCachedTokenMetadata({ prompt_tokens_details: { cached_tokens: "many" } }).status).toBe("malformed-data");
  });

  it("reports no deterministic association and performs zero mutations", async () => {
    const { db, file } = makeDb();
    insertUsage(db, 1, 0);
    insertUsage(db, 2, 27136);
    insertDetail(db, "detail-a", {
      prompt_tokens: 27985,
      completion_tokens: 60,
      prompt_tokens_details: { cached_tokens: 27136 },
    });
    insertDetail(db, "detail-b", { prompt_tokens: 10, completion_tokens: 2 });
    db.close();
    const before = fs.readFileSync(file);

    const report = await analyzeDatabase(file);
    const after = fs.readFileSync(file);

    expect(report.matching.deterministic).toBe(false);
    expect(report.matching.reason).toMatch(/no shared request or correlation ID/i);
    expect(report.usageHistory).toMatchObject({ rowsScanned: 2, candidateAffected: 1, alreadyCorrect: 1 });
    expect(report.requestDetails).toMatchObject({ rowsScanned: 2, positiveCacheMetadata: 1, missingCacheMetadata: 1, cachedTokensAvailable: 27136 });
    expect(report.recoverable).toBe(0);
    expect(report.unlinkedPositiveDetails).toBe(1);
    expect(after.equals(before)).toBe(true);
  });

  it("rejects apply mode and performs zero mutations", () => {
    const { db, file } = makeDb();
    insertUsage(db, 1, 0);
    db.close();
    const before = fs.readFileSync(file);

    const result = spawnSync(process.execPath, [
      path.resolve("scripts/analyze-cached-token-backfill.mjs"),
      "--db", file,
      "--apply",
    ], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Apply mode is unavailable/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("reads committed rows from an active WAL without writing", async () => {
    const { db, file } = makeDb();
    db.exec("PRAGMA journal_mode = WAL");
    insertUsage(db, 1, 0);
    insertDetail(db, "detail-wal", {
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 90 },
    });

    const report = await analyzeDatabase(file);

    expect(report.usageHistory.rowsScanned).toBe(1);
    expect(report.requestDetails.positiveCacheMetadata).toBe(1);
    db.close();
  });
});
