import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { MATCHING_ALGORITHM_DESCRIPTION, Tag } from "../api/types";
import { enhanceMatchingAlgorithm, enhanceMatchingAlgorithmArray } from "../api/utils";
import { withErrorHandling } from "./utils/middlewares";
import { buildQueryString } from "./utils/queryString";

export function registerTagTools(server: McpServer, api: PaperlessAPI) {
  server.registerTool(
    "list_tags",
    {
      description:
        "List all tags. IMPORTANT: When a user query may refer to a tag or document type, you should fetch all tags and all document types up front (with a large enough page_size), cache them for the session, and search locally for matches by name or slug before making further API calls. This reduces redundant requests and handles ambiguity between tags and document types efficiently.",
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
    withErrorHandling(async (args = {}) => {
      if (!api) throw new Error("Please configure API connection first");
      const queryString = buildQueryString(args);
      const tagsResponse = await api.request(`/tags/${queryString ? `?${queryString}` : ""}`);
      const enhancedResults = enhanceMatchingAlgorithmArray(tagsResponse.results || []);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...tagsResponse,
              results: enhancedResults,
            }),
          },
        ],
      };
    })
  );

  server.registerTool(
    "create_tag",
    {
      description:
        "Create a new tag with optional color, matching pattern, and matching algorithm for automatic document tagging.",
      inputSchema: z.object({
        name: z.string(),
        color: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
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
      const tag = await api.createTag(args as Partial<Tag>);
      const enhancedTag = enhanceMatchingAlgorithm(tag);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(enhancedTag),
          },
        ],
      };
    })
  );

  server.registerTool(
    "update_tag",
    {
      description: "Update an existing tag's name, color, matching pattern, or matching algorithm.",
      inputSchema: z.object({
        id: z.number(),
        name: z.string(),
        color: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
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
      const tag = await api.updateTag(args.id, args as Partial<Tag>);
      const enhancedTag = enhanceMatchingAlgorithm(tag);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(enhancedTag),
          },
        ],
      };
    })
  );

  server.registerTool(
    "delete_tag",
    {
      description:
        "⚠️ DESTRUCTIVE: Permanently delete a tag from the entire system. This will remove the tag from ALL documents that use it. Use with extreme caution.",
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
      await api.deleteTag(args.id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "deleted" }),
          },
        ],
      };
    })
  );

  server.registerTool(
    "bulk_edit_tags",
    {
      description:
        "Bulk edit tags. ⚠️ WARNING: 'delete' operation permanently removes tags from the entire system. Use with caution.",
      inputSchema: z.object({
        tag_ids: z.array(z.number()),
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
        args.tag_ids,
        "tags",
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
