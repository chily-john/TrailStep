/**
 * Backwards-compatible re-export of the layered MCP-JSON loader.
 *
 * The implementation moved to `packages/core/src/mcp/layered-mcp-loader.ts`;
 * this module keeps the historical path and export names working.
 */
export {
  layeredMcpToolDirs as layeredDirs,
  loadLayeredMcpToolDefinitions as load,
} from "./mcp/layered-mcp-loader.js";
