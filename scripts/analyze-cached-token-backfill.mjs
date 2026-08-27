#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function extractCachedTokenMetadata(tokens) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return { status: "malformed-data" };
  const raw = tokens.prompt_tokens_details?.cached_tokens;
  if (raw === undefined || raw === null) return { status: "missing-cache-metadata" };
  const cachedTokens = number(raw);
  if (cachedTokens === null) return { status: "malformed-data" };
  const promptTokens = number(tokens.prompt_tokens ?? tokens.input_tokens) ?? 0;
  if (cachedTokens === 0) return { status: "true-zero-cache", cachedTokens, promptTokens };
  if (cachedTokens > promptTokens) return { status: "malformed-data" };
  return { status: "positive", cachedTokens, promptTokens };
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

async function openReadOnly(file) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec("BEGIN");
    return {
      all: (sql) => db.prepare(sql).all(),
      close: () => { try { db.exec("ROLLBACK"); } finally { db.close(); } },
    };
  } catch (nodeError) {
    if (fs.existsSync(`${file}-wal`)) {
      throw new Error(`Cannot safely inspect an active WAL database without node:sqlite (${nodeError.message})`);
    }
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(file));
    return {
      all(sql) {
        const result = db.exec(sql)[0];
        if (!result) return [];
        return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
      },
      close: () => db.close(),
    };
  }
}

function tableColumns(db, table) {
  return db.all(`PRAGMA table_info(${table})`).map((row) => row.name);
}

export async function analyzeDatabase(file) {
  if (!fs.existsSync(file)) throw new Error(`Database not found: ${file}`);
  const db = await openReadOnly(file);
  try {
    const usageColumns = tableColumns(db, "usageHistory");
    const detailColumns = tableColumns(db, "requestDetails");
    if (!usageColumns.length || !detailColumns.length) throw new Error("Required usageHistory/requestDetails tables are missing");
    const requiredUsage = ["id", "tokens"];
    const requiredDetails = ["id", "timestamp", "data"];
    if (requiredUsage.some((column) => !usageColumns.includes(column)) ||
        requiredDetails.some((column) => !detailColumns.includes(column))) {
      throw new Error("Required usageHistory/requestDetails columns are missing");
    }

    const usageRows = db.all("SELECT id, tokens FROM usageHistory ORDER BY id");
    const detailRows = db.all("SELECT id, data FROM requestDetails ORDER BY timestamp, id");
    const report = {
      matching: {
        deterministic: false,
        usageHistoryPrimaryKey: "id (INTEGER)",
        requestDetailsPrimaryKey: "id (TEXT)",
        sharedIdentifiers: [],
        reason: "usageHistory has no shared request or correlation ID with requestDetails; timestamps are generated independently",
      },
      usageHistory: { rowsScanned: usageRows.length, candidateAffected: 0, alreadyCorrect: 0, malformedData: 0 },
      requestDetails: {
        rowsScanned: detailRows.length,
        positiveCacheMetadata: 0,
        trueZeroCache: 0,
        missingCacheMetadata: 0,
        malformedData: 0,
        cachedTokensAvailable: 0,
      },
      recoverable: 0,
      unlinkedPositiveDetails: 0,
      warnings: [
        "No rows are classified as recoverable because the schema has no deterministic cross-table key.",
        "Timestamp/provider/model/token matching would be heuristic and is intentionally not attempted.",
      ],
    };

    for (const row of usageRows) {
      const tokens = parseJson(row.tokens);
      if (!tokens || typeof tokens !== "object") {
        report.usageHistory.malformedData++;
        continue;
      }
      const cached = number(tokens.cached_tokens ?? tokens.cache_read_input_tokens);
      if (cached === null || cached === 0) report.usageHistory.candidateAffected++;
      else report.usageHistory.alreadyCorrect++;
    }

    for (const row of detailRows) {
      const data = parseJson(row.data);
      const result = data ? extractCachedTokenMetadata(data.tokens) : { status: "malformed-data" };
      if (result.status === "positive") {
        report.requestDetails.positiveCacheMetadata++;
        report.requestDetails.cachedTokensAvailable += result.cachedTokens;
      } else if (result.status === "true-zero-cache") report.requestDetails.trueZeroCache++;
      else if (result.status === "missing-cache-metadata") report.requestDetails.missingCacheMetadata++;
      else report.requestDetails.malformedData++;
    }
    report.unlinkedPositiveDetails = report.requestDetails.positiveCacheMetadata;
    return report;
  } finally {
    db.close();
  }
}

function defaultDatabasePath() {
  const dataDir = process.env.DATA_DIR || (process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router")
    : path.join(os.homedir(), ".9router"));
  return path.join(dataDir, "db", "data.sqlite");
}

function format(report, file) {
  const u = report.usageHistory;
  const d = report.requestDetails;
  return [
    "Historical cached-token analysis (read-only)",
    "",
    `database:                         ${file}`,
    `deterministic association:        ${report.matching.deterministic ? "yes" : "no"}`,
    `reason:                           ${report.matching.reason}`,
    "",
    `usageHistory rows scanned:        ${u.rowsScanned}`,
    `candidate affected rows:          ${u.candidateAffected}`,
    `already correct rows:             ${u.alreadyCorrect}`,
    `malformed usage rows:             ${u.malformedData}`,
    "",
    `requestDetails rows scanned:      ${d.rowsScanned}`,
    `positive cache metadata:          ${d.positiveCacheMetadata}`,
    `true zero-cache metadata:         ${d.trueZeroCache}`,
    `missing cache metadata:           ${d.missingCacheMetadata}`,
    `malformed detail rows:            ${d.malformedData}`,
    `unlinked cached tokens available: ${d.cachedTokensAvailable}`,
    "",
    `recoverable rows:                 ${report.recoverable}`,
    ...report.warnings.map((warning) => `warning: ${warning}`),
  ].join("\n");
}

async function main(argv) {
  let file = defaultDatabasePath();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--db requires a path");
      file = argv[++i];
    }
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--dry-run") continue;
    else if (argv[i] === "--apply") throw new Error("Apply mode is unavailable: requestDetails cannot be deterministically associated with usageHistory");
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/analyze-cached-token-backfill.mjs [--db PATH] [--dry-run] [--json]\n\nRead-only diagnostic. No apply mode exists because the current schema has no deterministic cross-table key.");
      return;
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  file = path.resolve(file);
  const report = await analyzeDatabase(file);
  console.log(json ? JSON.stringify(report, null, 2) : format(report, file));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Historical cached-token analysis failed: ${error.message}`);
    process.exitCode = 1;
  });
}
