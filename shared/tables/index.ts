/**
 * Round 26 (DATA TABLES) — barrel re-export for `shared/tables/**`. Server
 * routes, MCP tools, and the client all consume this module through here
 * (or the individual files directly); see docs/spec-tables.md for the spec
 * and each file's header comment for what it owns.
 */
export * from './limits.js';
export * from './values.js';
export * from './codec.js';
export * from './query.js';
export * from './csv.js';
export * from './yaml.js';
