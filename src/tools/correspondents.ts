import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { Correspondent, MATCHING_ALGORITHM_DESCRIPTION } from "../api/types";
import { enhanceMatchingAlgorithm, enhanceMatchingAlgorithmArray } from "../api/utils";
import { withErrorHandling } from "./utils/middlewares";
import { buildQueryString } from "./utils/queryString";

export function registerCorrespondentTools(server: McpServer, api: PaperlessAPI) {
  server.registerTool(
    "list_correspondents",
    {
      description:
        "List all correspondents with optional filtering and pagination. Correspondents represent entities that send or receive documents.",
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
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const queryString = buildQueryString(args);
      const response = await api.getCorrespondents(queryString);
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
    "get_correspondent",
    {
      description: "Get a specific correspondent by ID with full details including matching rules.",
      inputSchema: z.object({ id: z.number() }),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const response = await api.getCorrespondent(args.id);
      const enhancedCorrespondent = enhanceMatchingAlgorithm(response);
      return {
        content: [{ type: "text", text: JSON.stringify(enhancedCorrespondent) }],
      };
    })
  );

  server.registerTool(
    "create_correspondent",
    {
      description:
        "Create a new correspondent with optional matching pattern and algorithm for automatic document assignment.",
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
      const response = await api.createCorrespondent(args as Partial<Correspondent>);
      const enhancedCorrespondent = enhanceMatchingAlgorithm(response);
      return {
        content: [{ type: "text", text: JSON.stringify(enhancedCorrespondent) }],
      };
    })
  );

  server.registerTool(
    "update_correspondent",
    {
      description:
        "Update an existing correspondent's name, matching pattern, or matching algorithm.",
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
      const { id, ...data } = args;
      const response = await api.updateCorrespondent(id, data as Partial<Correspondent>);
      const enhancedCorrespondent = enhanceMatchingAlgorithm(response);
      return {
        content: [{ type: "text", text: JSON.stringify(enhancedCorrespondent) }],
      };
    })
  );

  server.registerTool(
    "delete_correspondent",
    {
      description:
        "⚠️ DESTRUCTIVE: Permanently delete a correspondent from the entire system. This will affect ALL documents that use this correspondent.",
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
      await api.deleteCorrespondent(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "deleted" }) }],
      };
    })
  );

  server.registerTool(
    "bulk_edit_correspondents",
    {
      description:
        "Bulk edit correspondents. ⚠️ WARNING: 'delete' operation permanently removes correspondents from the entire system.",
      inputSchema: z.object({
        correspondent_ids: z.array(z.number()),
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
        args.correspondent_ids,
        "correspondents",
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
