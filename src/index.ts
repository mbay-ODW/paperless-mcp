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

  if (useHttp) {
    const app = express();
    app.use(express.json());

    // ------------------------------------------------------------------
    // OIDC / Bearer auth middleware
    // Env vars:
    //   MCP_API_KEY              – static fallback token (optional)
    //   OIDC_INTROSPECTION_URL   – Authelia introspection endpoint
    //   OIDC_CLIENT_ID           – client id for introspection auth
    //   OIDC_CLIENT_SECRET       – client secret for introspection auth
    // ------------------------------------------------------------------
    const mcpApiKey = process.env.MCP_API_KEY ?? "";
    const oidcIntrospectionUrl = process.env.OIDC_INTROSPECTION_URL ?? "";
    const oidcClientId = process.env.OIDC_CLIENT_ID ?? "";
    const oidcClientSecret = process.env.OIDC_CLIENT_SECRET ?? "";
    // Base URL of the Authelia OAuth/OIDC server (e.g. https://authelia.example.com)
    const oauthIssuer = process.env.OAUTH_ISSUER ?? "";
    // Public URL of this MCP server (e.g. https://mcp.example.com)
    const mcpServerUrl = process.env.MCP_SERVER_URL ?? "";

    // Log config once at startup so we can verify env vars are loaded
    console.log("[auth] Config: MCP_API_KEY=%s OIDC_INTROSPECTION_URL=%s OIDC_CLIENT_ID=%s OIDC_CLIENT_SECRET=%s",
      mcpApiKey ? `set(${mcpApiKey.length} chars)` : "NOT SET",
      oidcIntrospectionUrl || "NOT SET",
      oidcClientId || "NOT SET",
      oidcClientSecret ? `set(${oidcClientSecret.length} chars)` : "NOT SET",
    );

    const isAuthorized = async (req: express.Request): Promise<boolean> => {
      if (!mcpApiKey) {
        console.log("[auth] No MCP_API_KEY configured – skipping auth");
        return true;
      }

      const auth = req.headers.authorization ?? "";
      const authPreview = auth
        ? auth.slice(0, 20) + (auth.length > 20 ? "…" : "")
        : "(none)";
      console.log("[auth] %s %s – Authorization: %s", req.method, req.path, authPreview);

      if (!auth) {
        console.log("[auth] DENIED – no Authorization header");
        return false;
      }

      if (auth === `Bearer ${mcpApiKey}`) {
        console.log("[auth] OK – static Bearer token matched");
        return true;
      }

      if (auth.startsWith("Bearer ")) {
        if (!oidcIntrospectionUrl || !oidcClientId || !oidcClientSecret) {
          console.log("[auth] DENIED – JWT received but OIDC not fully configured: url=%s id=%s secret=%s",
            oidcIntrospectionUrl ? "set" : "MISSING",
            oidcClientId ? "set" : "MISSING",
            oidcClientSecret ? "set" : "MISSING",
          );
          return false;
        }

        const jwtToken = auth.slice(7);
        console.log("[auth] JWT token received (len=%d), calling introspection: %s", jwtToken.length, oidcIntrospectionUrl);
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
          const body = await resp.text();
          console.log("[auth] Introspection HTTP %d – body: %s", resp.status, body.slice(0, 200));
          const data = JSON.parse(body) as { active?: boolean };
          if (data.active === true) {
            console.log("[auth] OK – OIDC token active");
            return true;
          } else {
            console.log("[auth] DENIED – OIDC token not active");
            return false;
          }
        } catch (e) {
          console.error("[auth] Introspection error:", e);
          return false;
        }
      }

      console.log("[auth] DENIED – Authorization header is not a Bearer token");
      return false;
    };

    const authMiddleware: express.RequestHandler = async (req, res, next) => {
      if (await isAuthorized(req)) return next();
      res.status(401).json({ error: "Unauthorized" });
    };

    // Store transports for each session
    const sseTransports: Record<string, SSEServerTransport> = {};

    // Both discovery endpoints must be BEFORE authMiddleware – publicly
    // accessible so Claude.ai can bootstrap the OAuth flow without a token.

    // RFC 9728 – OAuth 2.0 Protected Resource Metadata
    // Claude.ai fetches this FIRST to find out which authorization server
    // protects this resource.
    if (oauthIssuer && mcpServerUrl) {
      app.get("/.well-known/oauth-protected-resource", (_req, res) => {
        res.json({
          resource: mcpServerUrl,
          authorization_servers: [oauthIssuer],
          bearer_methods_supported: ["header"],
          scopes_supported: ["openid", "profile", "email"],
        });
      });
    }

    // RFC 8414 – OAuth 2.0 Authorization Server Metadata
    // Describes all Authelia endpoints Claude.ai needs for the OAuth flow.
    if (oauthIssuer) {
      app.get("/.well-known/oauth-authorization-server", (_req, res) => {
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

    app.post("/mcp", authMiddleware, async (req, res) => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => {
          transport.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
    });

    app.get("/mcp", async (req, res) => {
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed.",
          },
          id: null,
        })
      );
    });

    app.delete("/mcp", async (req, res) => {
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed.",
          },
          id: null,
        })
      );
    });

    app.get("/sse", authMiddleware, async (req, res) => {
      console.log("SSE request received");
      try {
        const transport = new SSEServerTransport("/messages", res);
        sseTransports[transport.sessionId] = transport;
        res.on("close", () => {
          delete sseTransports[transport.sessionId];
          transport.close();
        });
        await server.connect(transport);
      } catch (error) {
        console.error("Error handling SSE request:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
    });

    app.post("/messages", authMiddleware, async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = sseTransports[sessionId];
      if (transport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).send("No transport found for sessionId");
      }
    });

    app.listen(resolvedPort, () => {
      console.log(
        `MCP Stateless Streamable HTTP Server listening on port ${resolvedPort}`
      );
    });
    // await new Promise((resolve) => setTimeout(resolve, 1000000));
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((e) => console.error(e.message));
