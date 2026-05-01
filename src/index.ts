#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { parseArgs } from "node:util";
import { PaperlessAPI } from "./api/PaperlessAPI";
import { registerCorrespondentTools } from "./tools/correspondents";
import { registerCustomFieldTools } from "./tools/customFields";
import { registerDocumentTools } from "./tools/documents";
import { registerDocumentTypeTools } from "./tools/documentTypes";
import { registerTagTools } from "./tools/tags";
const { version } = require("../package.json") as { version: string };

// ---------------------------------------------------------------------------
// Logging – LOG_LEVEL env var: error|warn|info|debug|trace (default: info)
// ---------------------------------------------------------------------------
const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const requestedLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
const activeLevelIdx = Math.max(
  0,
  LOG_LEVELS.indexOf(LOG_LEVELS.includes(requestedLevel) ? requestedLevel : "info")
);
function lvlEnabled(l: LogLevel): boolean {
  return LOG_LEVELS.indexOf(l) <= activeLevelIdx;
}
const ts = () => new Date().toISOString();
const log = {
  error: (...a: unknown[]) =>
    lvlEnabled("error") && console.error(`[${ts()}] ERROR`, ...a),
  warn: (...a: unknown[]) =>
    lvlEnabled("warn") && console.warn(`[${ts()}] WARN `, ...a),
  info: (...a: unknown[]) =>
    lvlEnabled("info") && console.log(`[${ts()}] INFO `, ...a),
  debug: (...a: unknown[]) =>
    lvlEnabled("debug") && console.log(`[${ts()}] DEBUG`, ...a),
  trace: (...a: unknown[]) =>
    lvlEnabled("trace") && console.log(`[${ts()}] TRACE`, ...a),
};

const {
  values: { baseUrl, token, http: useHttp, port, publicUrl },
} = parseArgs({
  options: {
    baseUrl: { type: "string" },
    token: { type: "string" },
    http: { type: "boolean", default: false },
    port: { type: "string" },
    publicUrl: { type: "string", default: "" },
  },
  allowPositionals: true,
});

const resolvedBaseUrl = baseUrl || process.env.PAPERLESS_URL;
const resolvedToken = token || process.env.PAPERLESS_API_KEY;
const resolvedPublicUrl =
  publicUrl || process.env.PAPERLESS_PUBLIC_URL || resolvedBaseUrl;
const resolvedPort = port ? parseInt(port, 10) : 3000;

if (!resolvedBaseUrl || !resolvedToken) {
  console.error(
    "Usage: paperless-mcp --baseUrl <url> --token <token> [--http] [--port <port>] [--publicUrl <url>]"
  );
  console.error(
    "Or set PAPERLESS_URL and PAPERLESS_API_KEY environment variables."
  );
  process.exit(1);
}

async function main() {
  log.info(
    `paperless-mcp v${version} starting – LOG_LEVEL=${LOG_LEVELS[activeLevelIdx]} transport=${useHttp ? "http" : "stdio"} port=${resolvedPort}`
  );
  log.debug(
    `paperless: baseUrl=${resolvedBaseUrl} publicUrl=${resolvedPublicUrl} token_len=${resolvedToken!.length}`
  );

  // Initialize API client and server once
  const api = new PaperlessAPI(resolvedBaseUrl!, resolvedToken!);
  const server = new McpServer(
    { name: "paperless-ngx", version },
    {
      instructions: `
Paperless-NGX MCP Server Instructions

⚠️ CRITICAL: Always differentiate between operations on specific documents vs operations on the entire system:

- REMOVE operations (e.g., remove_tag in bulk_edit_documents): Affect only the specified documents, items remain in the system
- DELETE operations (e.g., delete_tag, delete_correspondent): Permanently delete items from the entire system, affecting ALL documents that use them

When a user asks to "remove" something, prefer operations that affect specific documents. Only use DELETE operations when explicitly asked to delete from the system.

To view documents in your Paperless-NGX web interface, construct URLs using this pattern:
${resolvedPublicUrl}/documents/{document_id}/

Example: If your base URL is "http://localhost:8000", the web interface URL would be "http://localhost:8000/documents/123/" for document ID 123.

The document tools return JSON data with document IDs that you can use to construct these URLs.
      `,
    }
  );
  registerDocumentTools(server, api);
  registerTagTools(server, api);
  registerCorrespondentTools(server, api);
  registerDocumentTypeTools(server, api);
  registerCustomFieldTools(server, api);
  log.info("Tool groups registered: documents, tags, correspondents, documentTypes, customFields");

  if (useHttp) {
    const app = express();
    app.use(express.json());

    // Generic request log – sees EVERY incoming request before routing.
    app.use((req, _res, next) => {
      const auth = req.headers.authorization ?? "";
      const authPreview = auth
        ? auth.slice(0, 20) + (auth.length > 20 ? "…" : "")
        : "(none)";
      log.debug(
        `→ ${req.method} ${req.originalUrl}  auth=${authPreview}  ip=${req.ip}`
      );
      next();
    });

    // ------------------------------------------------------------------
    // OIDC / Bearer auth middleware
    // Same logic as hero-mcp:
    //   1. If MCP_API_KEY is unset → all requests pass (dev mode, warned)
    //   2. Bearer == MCP_API_KEY → ok
    //   3. Bearer JWT → introspect against Authelia → active=true → ok
    //   4. Otherwise → 401
    // ------------------------------------------------------------------
    const mcpApiKey = process.env.MCP_API_KEY ?? "";
    const oidcIntrospectionUrl = process.env.OIDC_INTROSPECTION_URL ?? "";
    const oidcClientId = process.env.OIDC_CLIENT_ID ?? "";
    const oidcClientSecret = process.env.OIDC_CLIENT_SECRET ?? "";
    const oauthIssuer = process.env.OAUTH_ISSUER ?? "";
    const mcpServerUrl = process.env.MCP_SERVER_URL ?? "";

    log.info(
      `[auth] config: MCP_API_KEY=${mcpApiKey ? `set(${mcpApiKey.length} chars)` : "NOT SET"} OIDC_INTROSPECTION_URL=${oidcIntrospectionUrl || "NOT SET"} OIDC_CLIENT_ID=${oidcClientId || "NOT SET"} OIDC_CLIENT_SECRET=${oidcClientSecret ? `set(${oidcClientSecret.length} chars)` : "NOT SET"}`
    );
    log.info(
      `[oauth-discovery] OAUTH_ISSUER=${oauthIssuer || "NOT SET"} MCP_SERVER_URL=${mcpServerUrl || "NOT SET"}`
    );
    if (!mcpApiKey && (!oidcIntrospectionUrl || !oidcClientId || !oidcClientSecret)) {
      log.warn(
        "[auth] NEITHER static MCP_API_KEY NOR a complete OIDC triple is configured – ALL requests will be accepted unauthenticated (dev mode)."
      );
    }

    const isAuthorized = async (req: express.Request): Promise<boolean> => {
      const tag = `${req.method} ${req.path}`;
      if (!mcpApiKey) {
        log.debug(`[auth] ${tag} – no MCP_API_KEY configured, passing through`);
        return true;
      }

      const auth = req.headers.authorization ?? "";
      const authPreview = auth
        ? auth.slice(0, 20) + (auth.length > 20 ? "…" : "")
        : "(none)";
      log.debug(`[auth] ${tag} – Authorization: ${authPreview}`);

      if (!auth) {
        log.warn(`[auth] ${tag} – DENY: no Authorization header`);
        return false;
      }

      if (auth === `Bearer ${mcpApiKey}`) {
        log.info(`[auth] ${tag} – OK: static MCP_API_KEY matched`);
        return true;
      }

      if (!auth.startsWith("Bearer ")) {
        log.warn(`[auth] ${tag} – DENY: Authorization is not a Bearer scheme`);
        return false;
      }

      // Bearer ≠ MCP_API_KEY → try OIDC introspection.
      if (!oidcIntrospectionUrl || !oidcClientId || !oidcClientSecret) {
        log.warn(
          `[auth] ${tag} – DENY: Bearer JWT presented but OIDC introspection not fully configured (url=${
            oidcIntrospectionUrl ? "ok" : "MISSING"
          } id=${oidcClientId ? "ok" : "MISSING"} secret=${
            oidcClientSecret ? "ok" : "MISSING"
          })`
        );
        return false;
      }

      const jwtToken = auth.slice(7);
      log.debug(
        `[auth] ${tag} – introspecting token (len=${jwtToken.length}) against ${oidcIntrospectionUrl}`
      );
      const startedAt = Date.now();
      try {
        const credentials = Buffer.from(
          `${oidcClientId}:${oidcClientSecret}`
        ).toString("base64");
        const resp = await fetch(oidcIntrospectionUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${credentials}`,
          },
          body: `token=${encodeURIComponent(jwtToken)}`,
          signal: AbortSignal.timeout(5000),
        });
        const elapsed = Date.now() - startedAt;
        const body = await resp.text();
        log.debug(
          `[auth] ${tag} – introspection HTTP ${resp.status} in ${elapsed}ms, body: ${body.slice(0, 300)}`
        );
        if (resp.status !== 200) {
          log.warn(
            `[auth] ${tag} – DENY: introspection returned non-200 (${resp.status})`
          );
          return false;
        }
        const data = JSON.parse(body) as {
          active?: boolean;
          sub?: string;
          scope?: string;
          aud?: string;
          exp?: number;
        };
        if (data.active === true) {
          log.info(
            `[auth] ${tag} – OK: OIDC token active sub=${data.sub ?? "?"} scope=${data.scope ?? "?"}`
          );
          return true;
        }
        log.warn(`[auth] ${tag} – DENY: OIDC token not active`);
        return false;
      } catch (e) {
        log.error(`[auth] ${tag} – introspection exception:`, e);
        return false;
      }
    };

    const authMiddleware: express.RequestHandler = async (req, res, next) => {
      if (await isAuthorized(req)) return next();
      res.status(401).json({ error: "Unauthorized" });
    };

    // Store transports for each session
    const sseTransports: Record<string, SSEServerTransport> = {};

    // ------------------------------------------------------------------
    // Public OAuth discovery endpoints (RFC 9728 + RFC 8414).
    // Mounted BEFORE auth so Claude.ai can bootstrap the OAuth flow.
    // Only registered when OAUTH_ISSUER is set.
    // ------------------------------------------------------------------
    if (oauthIssuer && mcpServerUrl) {
      app.get("/.well-known/oauth-protected-resource", (_req, res) => {
        log.info("[discovery] /.well-known/oauth-protected-resource hit");
        res.json({
          resource: mcpServerUrl,
          authorization_servers: [oauthIssuer],
          bearer_methods_supported: ["header"],
          scopes_supported: ["openid", "profile", "email"],
        });
      });
    }
    if (oauthIssuer) {
      app.get("/.well-known/oauth-authorization-server", (_req, res) => {
        log.info("[discovery] /.well-known/oauth-authorization-server hit");
        res.json({
          issuer: oauthIssuer,
          authorization_endpoint: `${oauthIssuer}/api/oidc/authorization`,
          token_endpoint: `${oauthIssuer}/api/oidc/token`,
          jwks_uri: `${oauthIssuer}/jwks.json`,
          introspection_endpoint: `${oauthIssuer}/api/oidc/introspection`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "profile", "email"],
        });
      });
    }

    // ------------------------------------------------------------------
    // Streamable HTTP transport (current MCP spec).
    // Mounted on BOTH /mcp and /sse (POST) so the same server works
    // regardless of which URL the user typed into the Claude.ai connector
    // dialog – modern Claude.ai always uses Streamable-HTTP semantics
    // (POST + json/event-stream Accept) even when the connector URL
    // ends in /sse.
    // ------------------------------------------------------------------
    const streamableHandler: express.RequestHandler = async (req, res) => {
      const tag = `[stream POST ${req.path}]`;
      log.info(`${tag} new request, body keys=${Object.keys(req.body ?? {}).join(",")}`);
      log.trace(`${tag} body: ${JSON.stringify(req.body).slice(0, 500)}`);
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => {
          log.debug(`${tag} connection closed by client`);
          transport.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        log.debug(`${tag} handled, response status=${res.statusCode}`);
      } catch (error) {
        log.error(`${tag} handler error:`, error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    };
    app.post("/mcp", authMiddleware, streamableHandler);
    app.post("/sse", authMiddleware, streamableHandler);

    app.get("/mcp", (req, res) => {
      log.debug(`[/mcp GET] not allowed (method=${req.method})`);
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        })
      );
    });

    app.delete("/mcp", (req, res) => {
      log.debug(`[/mcp DELETE] not allowed`);
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        })
      );
    });

    // ------------------------------------------------------------------
    // SSE transport (legacy MCP spec; Claude Desktop, older Claude.ai).
    // ------------------------------------------------------------------
    app.get("/sse", authMiddleware, async (_req, res) => {
      log.info("[/sse GET] new SSE connection");
      try {
        const transport = new SSEServerTransport("/messages", res);
        sseTransports[transport.sessionId] = transport;
        log.info(
          `[/sse GET] sessionId=${transport.sessionId} – transport registered (active sessions: ${Object.keys(sseTransports).length})`
        );
        res.on("close", () => {
          log.info(
            `[/sse GET] sessionId=${transport.sessionId} – connection closed (remaining sessions: ${
              Object.keys(sseTransports).length - 1
            })`
          );
          delete sseTransports[transport.sessionId];
          transport.close();
        });
        await server.connect(transport);
        log.debug(`[/sse GET] sessionId=${transport.sessionId} – server.connect completed`);
      } catch (error) {
        log.error("[/sse GET] error:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });

    app.post("/messages", authMiddleware, async (req, res) => {
      const sessionId = req.query.sessionId as string;
      log.debug(
        `[/messages POST] sessionId=${sessionId} body keys=${Object.keys(req.body ?? {}).join(",")}`
      );
      log.trace(`[/messages POST] body: ${JSON.stringify(req.body).slice(0, 500)}`);
      const transport = sseTransports[sessionId];
      if (!transport) {
        log.warn(
          `[/messages POST] sessionId=${sessionId} – no transport found (known: ${Object.keys(sseTransports).join(",") || "none"})`
        );
        res.status(400).send("No transport found for sessionId");
        return;
      }
      try {
        await transport.handlePostMessage(req, res, req.body);
        log.debug(`[/messages POST] sessionId=${sessionId} – handled, status=${res.statusCode}`);
      } catch (error) {
        log.error(`[/messages POST] sessionId=${sessionId} – error:`, error);
        if (!res.headersSent) res.status(500).send("Internal server error");
      }
    });

    // Catch-all for unmatched routes – often the actual cause of "Not connected".
    app.use((req, res) => {
      log.warn(
        `[404] ${req.method} ${req.originalUrl} – no route matched. Headers: ${JSON.stringify(req.headers).slice(0, 300)}`
      );
      res.status(404).json({ error: "Not found", path: req.originalUrl });
    });

    app.listen(resolvedPort, () => {
      log.info(
        `MCP server listening on :${resolvedPort} (routes: /mcp /sse /messages /.well-known/*)`
      );
    });
  } else {
    log.info("starting on stdio");
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((e) => {
  log.error("fatal:", e);
  process.exit(1);
});
