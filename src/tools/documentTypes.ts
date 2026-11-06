import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { DocumentType, MATCHING_ALGORITHM_DESCRIPTION } from "../api/types";
import { enhanceMatchingAlgorithm, enhanceMatchingAlgorithmArray } from "../api/utils";
import { withErrorHandling } from "./utils/middlewares";
import { buildQueryString } from "./utils/queryString";

export function registerDocumentTypeTools(server: McpServer, api: PaperlessAPI) {
  server.registerTool(
    "list_document_types",
    {
      description:
        "List all document types. IMPORTANT: When a user query may refer to a document type or tag, you should fetch all document types and all tags up front (with a large enough page_size), cache them for the session, and search locally for matches by name or slug before making further API calls. This reduces redundant requests and handles ambiguity between tags and document types efficiently.",
      inputSchema: z.object({
        page: z.number().optional(),
        page_size: z.number().optional(),
        name__icontains: z.string().optional(),
        name__iendswith: z.string().optional(),
        name__iexact: z.string().optional(),
        name__istartswith: z.string().optional(),
        ordering: z.string().optional(),
      }),
    },
    withErrorHandling(async (args = {}, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const queryString = buildQueryString(args);
      const response = await api.request(`/document_types/${queryString ? `?${queryString}` : ""}`);
      const enhancedResults = enhanceMatchingAlgorithmArray(response.results || []);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...response,
              results: enhancedResults,
            }),
          },
        ],
      };
    })
  );

  server.registerTool(
    "get_document_type",
    {
      description: "Get a specific document type by ID with full details including matching rules.",
      inputSchema: z.object({ id: z.number() }),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const response = await api.request(`/document_types/${args.id}/`);
      const enhancedDocumentType = enhanceMatchingAlgorithm(response);
      return {
        content: [{ type: "text", text: JSON.stringify(enhancedDocumentType) }],
      };
    })
  );

  server.registerTool(
    "create_document_type",
    {
      description:
        "Create a new document type with optional matching pattern and algorithm for automatic document classification.",
      inputSchema: z.object({
        name: z.string(),
        match: z.string().optional(),
        matching_algorithm: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe(MATCHING_ALGORITHM_DESCRIPTION),
      }),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const response = await api.createDocumentType(args as Partial<DocumentType>);
      const enhancedDocumentType = enhanceMatchingAlgorithm(response);
      return {
        content: [{ type: "text", text: JSON.stringify(enhancedDocumentType) }],
      };
    })
  );

  server.registerTool(
    "update_document_type",
    {
      description:
        "Update an existing document type's name, matching pattern, or matching algorithm.",
      inputSchema: z.object({
        id: z.number(),
        name: z.string(),
        match: z.string().optional(),
        matching_algorithm: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe(MATCHING_ALGORITHM_DESCRIPTION),
      }),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const { id, ...payloadWithoutId } = args;
      const response = await api.updateDocumentType(id, payloadWithoutId as Partial<DocumentType>);
      const enhancedDocumentType = enhanceMatchingAlgorithm(response);
      return {
        content: [{ type: "text", text: JSON.stringify(enhancedDocumentType) }],
      };
    })
  );

  server.registerTool(
    "delete_document_type",
    {
      description:
        "⚠️ DESTRUCTIVE: Permanently delete a document type from the entire system. This will affect ALL documents that use this type.",
      inputSchema: z.object({
        id: z.number(),
        confirm: z.boolean().describe("Must be true to confirm this destructive operation"),
      }),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      if (!args.confirm) {
        throw new Error(
          "Confirmation required for destructive operation. Set confirm: true to proceed."
        );
      }
      await api.deleteDocumentType(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "deleted" }) }],
      };
    })
  );

  server.registerTool(
    "bulk_edit_document_types",
    {
      description:
        "Bulk edit document types. ⚠️ WARNING: 'delete' operation permanently removes document types from the entire system.",
      inputSchema: z.object({
        document_type_ids: z.array(z.number()),
        operation: z.enum(["set_permissions", "delete"]),
        confirm: z
          .boolean()
          .optional()
          .describe("Must be true when operation is 'delete' to confirm destructive operation"),
        owner: z.number().optional(),
        permissions: z
          .object({
            view: z.object({
              users: z.array(z.number()).optional(),
              groups: z.array(z.number()).optional(),
            }),
            change: z.object({
              users: z.array(z.number()).optional(),
              groups: z.array(z.number()).optional(),
            }),
          })
          .optional(),
        merge: z.boolean().optional(),
      }),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      if (args.operation === "delete" && !args.confirm) {
        throw new Error(
          "Confirmation required for destructive operation. Set confirm: true to proceed."
        );
      }
      return api.bulkEditObjects(
        args.document_type_ids,
        "document_types",
        args.operation,
        args.operation === "set_permissions"
          ? {
              owner: args.owner,
              permissions: args.permissions,
              merge: args.merge,
            }
          : {}
      );
    })
  );
}
