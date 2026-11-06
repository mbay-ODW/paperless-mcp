import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { withErrorHandling } from "./utils/middlewares";
import { buildQueryString } from "./utils/queryString";

export function registerCustomFieldTools(server: McpServer, api: PaperlessAPI) {
  server.registerTool(
    "list_custom_fields",
    {
      description:
        "List all custom fields. IMPORTANT: When a user query may refer to a custom field, you should fetch all custom fields up front (with a large enough page_size), cache them for the session, and search locally for matches by name before making further API calls. This reduces redundant requests and handles ambiguity efficiently.",
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
      const response = await api.request(`/custom_fields/${queryString ? `?${queryString}` : ""}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response),
          },
        ],
      };
    })
  );

  server.registerTool(
    "get_custom_field",
    {
      description:
        "Get a specific custom field by ID with full details including data type and extra configuration.",
      inputSchema: z.object({ id: z.number() }),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const response = await api.getCustomField(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    })
  );

  server.registerTool(
    "create_custom_field",
    {
      description:
        "Create a new custom field with a specified data type (string, url, date, boolean, integer, float, monetary, documentlink, or select). For monetary fields, values must use currency code prefix format (e.g., USD10.00, GBP123.45) — NOT trailing symbol format (e.g., 10.00$).",
      inputSchema: z.object({
        name: z.string(),
        data_type: z.enum([
          "string",
          "url",
          "date",
          "boolean",
          "integer",
          "float",
          "monetary",
          "documentlink",
          "select",
        ]),
        extra_data: z.looseObject({}).nullable().optional(),
      }),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const response = await api.createCustomField(args);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    })
  );

  server.registerTool(
    "update_custom_field",
    {
      description:
        "Update an existing custom field's name, data type, or extra configuration data.",
      inputSchema: z.object({
        id: z.number(),
        name: z.string().optional(),
        data_type: z
          .enum([
            "string",
            "url",
            "date",
            "boolean",
            "integer",
            "float",
            "monetary",
            "documentlink",
            "select",
          ])
          .optional(),
        extra_data: z.looseObject({}).nullable().optional(),
      }),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const { id, ...data } = args;
      const response = await api.updateCustomField(id, data);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    })
  );

  server.registerTool(
    "delete_custom_field",
    {
      description:
        "⚠️ DESTRUCTIVE: Permanently delete a custom field from the entire system. This will remove the field from ALL documents that use it.",
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
      await api.deleteCustomField(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "deleted" }) }],
      };
    })
  );

  server.registerTool(
    "bulk_edit_custom_fields",
    {
      description:
        "Bulk edit custom fields. ⚠️ WARNING: 'delete' operation permanently removes custom fields from the entire system.",
      inputSchema: z.object({
        custom_fields: z.array(z.number()),
        operation: z.enum(["delete"]),
        confirm: z
          .boolean()
          .optional()
          .describe("Must be true when operation is 'delete' to confirm destructive operation"),
      }),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      if (args.operation === "delete" && !args.confirm) {
        throw new Error(
          "Confirmation required for destructive operation. Set confirm: true to proceed."
        );
      }
      const response = await api.bulkEditObjects(
        args.custom_fields,
        "custom_field",
        args.operation
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response),
          },
        ],
      };
    })
  );
}
