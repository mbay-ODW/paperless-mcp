import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { convertDocsWithNames } from "../api/documentEnhancer";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { arrayNotEmpty, objectNotEmpty } from "./utils/empty";
import { withErrorHandling } from "./utils/middlewares";
import { validateCustomFields } from "./utils/monetary";
import { CUSTOM_FIELD_VALUE_DESCRIPTION } from "./utils/descriptions";

// Container-side directory the export tool writes ZIPs into. The host
// path is configured via the docker-compose volume mount; the value
// here is just the in-container mount point. Defaults to /data/exports
// (matches the convention used in docker-compose.yml).
const EXPORT_DIR = process.env.PAPERLESS_EXPORT_DIR ?? "/data/exports";

export function registerDocumentTools(server: McpServer, api: PaperlessAPI) {
  server.tool(
    "bulk_edit_documents",
    "Perform bulk operations on multiple documents. Note: 'remove_tag' removes a tag from specific documents (tag remains in system), while 'delete_tag' permanently deletes a tag from the entire system. ⚠️ WARNING: 'delete' method permanently deletes documents and requires confirmation.",
    {
      documents: z.array(z.number()),
      method: z.enum([
        "set_correspondent",
        "set_document_type",
        "set_storage_path",
        "add_tag",
        "remove_tag",
        "modify_tags",
        "modify_custom_fields",
        "delete",
        "reprocess",
        "set_permissions",
        "merge",
        "split",
        "rotate",
        "delete_pages",
      ]),
      correspondent: z.number().optional(),
      document_type: z.number().optional(),
      storage_path: z.number().optional(),
      tag: z.number().optional(),
      add_tags: z.array(z.number()).optional().transform(arrayNotEmpty),
      remove_tags: z.array(z.number()).optional().transform(arrayNotEmpty),
      add_custom_fields: z
        .array(
          z.object({
            field: z.number(),
            value: z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.array(z.number()),
              z.null(),
            ]).describe(CUSTOM_FIELD_VALUE_DESCRIPTION),
          })
        )
        .optional()
        .transform(arrayNotEmpty),
      remove_custom_fields: z
        .array(z.number())
        .optional()
        .transform(arrayNotEmpty),
      permissions: z
        .object({
          owner: z.number().nullable().optional(),
          set_permissions: z
            .object({
              view: z.object({
                users: z.array(z.number()),
                groups: z.array(z.number()),
              }),
              change: z.object({
                users: z.array(z.number()),
                groups: z.array(z.number()),
              }),
            })
            .optional(),
          merge: z.boolean().optional(),
        })
        .optional()
        .transform(objectNotEmpty),
      metadata_document_id: z.number().optional(),
      delete_originals: z.boolean().optional(),
      pages: z.string().optional(),
      degrees: z.number().optional(),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Must be true when method is 'delete' to confirm destructive operation"
        ),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      if (args.method === "delete" && !args.confirm) {
        throw new Error(
          "Confirmation required for destructive operation. Set confirm: true to proceed."
        );
      }
      const { documents, method, add_custom_fields, confirm, ...parameters } = args;

      validateCustomFields(add_custom_fields);

      // Transform add_custom_fields into the two separate API parameters
      const apiParameters = { ...parameters };
      if (add_custom_fields && add_custom_fields.length > 0) {
        apiParameters.assign_custom_fields = add_custom_fields.map(
          (cf) => cf.field
        );
        apiParameters.assign_custom_fields_values = add_custom_fields;
      }

      const response = await api.bulkEditDocuments(
        documents,
        method,
        apiParameters
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ result: response.result || response }),
          },
        ],
      };
    })
  );

  server.tool(
    "post_document",
    "Upload a new document to Paperless-NGX with optional metadata like title, correspondent, document type, tags, and custom fields.",
    {
      file: z.string(),
      filename: z.string(),
      title: z.string().optional(),
      created: z.string().optional(),
      correspondent: z.number().optional(),
      document_type: z.number().optional(),
      storage_path: z.number().optional(),
      tags: z.array(z.number()).optional(),
      archive_serial_number: z.number().optional(),
      custom_fields: z.array(z.number()).optional(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");

      // Validate base64 input
      const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
      if (!base64Regex.test(args.file)) {
        throw new Error(
          "Invalid base64-encoded file data. Please provide a valid base64 string."
        );
      }
      const { file, filename, ...metadata } = args;
      const document = Buffer.from(file, "base64");

      const response = await api.postDocument(document, filename, metadata);
      let result;
      if (typeof response === "string" && /^\d+$/.test(response)) {
        result = { id: Number(response) };
      } else {
        result = { status: response };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    })
  );

  server.tool(
    "list_documents",
    "List and filter documents by fields such as title, correspondent, document type, tag, storage path, creation date, and more. IMPORTANT: For queries like 'the last 3 contributions' or when searching by tag, correspondent, document type, or storage path, you should FIRST use the relevant tool (e.g., 'list_tags', 'list_correspondents', 'list_document_types', 'list_storage_paths') to find the correct ID, and then use that ID as a filter here. Only use the 'search' argument for free-text search when no specific field applies. Using the correct ID filter will yield much more accurate results. Note: Document content is excluded from results by default. Use 'get_document_content' to retrieve content when needed.",
    {
      page: z.number().optional(),
      page_size: z.number().optional(),
      search: z.string().optional(),
      correspondent: z.number().optional(),
      document_type: z.number().optional(),
      tag: z.number().optional(),
      storage_path: z.number().optional(),
      created__date__gte: z.string().optional(),
      created__date__lte: z.string().optional(),
      ordering: z.string().optional(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const query = new URLSearchParams();
      if (args.page) query.set("page", args.page.toString());
      if (args.page_size) query.set("page_size", args.page_size.toString());
      if (args.search) query.set("search", args.search);
      if (args.correspondent)
        query.set("correspondent__id", args.correspondent.toString());
      if (args.document_type)
        query.set("document_type__id", args.document_type.toString());
      if (args.tag) query.set("tags__id", args.tag.toString());
      if (args.storage_path)
        query.set("storage_path__id", args.storage_path.toString());
      if (args.created__date__gte) query.set("created__date__gte", args.created__date__gte);
      if (args.created__date__lte) query.set("created__date__lte", args.created__date__lte);
      if (args.ordering) query.set("ordering", args.ordering);

      const docsResponse = await api.getDocuments(
        query.toString() ? `?${query.toString()}` : ""
      );
      return convertDocsWithNames(docsResponse, api);
    })
  );

  server.tool(
    "get_document",
    "Get a specific document by ID with full details including correspondent, document type, tags, and custom fields. Note: Document content is excluded from results by default. Use 'get_document_content' to retrieve content when needed.",
    {
      id: z.number(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const doc = await api.getDocument(args.id);
      return convertDocsWithNames(doc, api);
    })
  );

  server.tool(
    "get_document_content",
    "Get the text content of a specific document by ID. Use this when you need to read or analyze the actual document text.",
    {
      id: z.number(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const doc = await api.getDocument(args.id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: doc.id,
              title: doc.title,
              content: doc.content,
            }),
          },
        ],
      };
    })
  );

  server.tool(
    "search_documents",
    "Full text search for documents. This tool is for searching document content, title, and metadata using a full text query. For general document listing or filtering by fields, use 'list_documents' instead. Note: Document content is excluded from results by default. Use 'get_document_content' to retrieve content when needed.",
    {
      query: z.string(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const docsResponse = await api.searchDocuments(args.query);
      return convertDocsWithNames(docsResponse, api);
    })
  );

  server.tool(
    "download_document",
    "Download a document file by ID. Returns the document as a base64-encoded resource.",
    {
      id: z.number(),
      original: z.boolean().optional(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const response = await api.downloadDocument(args.id, args.original);

      // Pull the original filename out of Content-Disposition (axios returns
      // headers either as a Map-like object or a plain dict depending on
      // the adapter, hence the dual access).
      const cdRaw =
        typeof response.headers.get === "function"
          ? response.headers.get("content-disposition")
          : response.headers["content-disposition"];
      const filename =
        cdRaw?.split("filename=")[1]?.replace(/"/g, "") ||
        `document-${args.id}.pdf`;

      // The Paperless API echoes the actual MIME type back; default to
      // application/pdf since that's what `?original=false` returns.
      const ctRaw =
        typeof response.headers.get === "function"
          ? response.headers.get("content-type")
          : response.headers["content-type"];
      const mimeType = (ctRaw ?? "application/pdf").split(";")[0].trim();

      // RFC 3986: an MCP resource `uri` must have a scheme. `document-1583.pdf`
      // alone is rejected by the SDK validator with "malformed response".
      // We synthesise a `paperless://documents/<id>/<filename>` URI so the
      // resource is uniquely identifiable and the validator is happy.
      const safeName = encodeURIComponent(filename);
      const uri = `paperless://documents/${args.id}/${safeName}`;

      // axios `responseType: "arraybuffer"` gives us an ArrayBuffer in the
      // browser/edge runtimes and a Buffer in Node. Wrap in Uint8Array to
      // get a consistent base64 round-trip on either.
      const blob = Buffer.from(new Uint8Array(response.data)).toString(
        "base64"
      );

      return {
        content: [
          {
            type: "resource",
            resource: {
              uri,
              blob,
              mimeType,
            },
          },
        ],
      };
    })
  );

  server.tool(
    "export_documents_to_volume",
    [
      "Download multiple documents as a ZIP and write it directly to a",
      "host-mounted volume on the server – the file does NOT travel",
      "through Claude's context window. Use this for any export larger",
      "than a handful of documents.",
      "",
      "The container writes the ZIP into the directory specified by the",
      "PAPERLESS_EXPORT_DIR env var (default: /data/exports). Mount that",
      "directory to a host path in your docker-compose.yml, e.g.:",
      "  volumes:",
      "    - /volume1/docker/Paperless-MCP/exports:/data/exports",
      "",
      "The tool returns only the resulting filename + container/host",
      "path + size, never the bytes. Pick the file up via SMB / SFTP /",
      "Synology File Station / similar from the host path.",
    ].join(" "),
    {
      ids: z
        .array(z.number())
        .min(1)
        .describe("List of document IDs to include in the archive"),
      filename: z
        .string()
        .optional()
        .describe(
          "Optional filename for the ZIP (default: paperless-export-<timestamp>.zip). Subdirectories not allowed; basename only."
        ),
      content: z
        .enum(["archive", "originals", "both"])
        .optional()
        .describe(
          "Which file copy to include (default: 'archive' – the OCR'd PDF view)"
        ),
      compression: z
        .enum(["none", "deflated", "bzip2", "lzma"])
        .optional()
        .describe(
          "ZIP entry compression. 'none' is fastest; PDFs don't shrink further."
        ),
      follow_formatting: z
        .boolean()
        .optional()
        .describe(
          "If true, mirror the on-disk directory layout configured in Paperless's filename-formatting setting"
        ),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");

      // Resolve target filename. Strip any directory components – the
      // user shouldn't be able to escape the export dir via "../etc".
      const baseName = path
        .basename(
          args.filename ??
            `paperless-export-${new Date()
              .toISOString()
              .replace(/[:.]/g, "-")
              .replace(/T/, "_")
              .replace(/Z$/, "")}.zip`
        )
        .replace(/[/\\]/g, "_");
      const fullPath = path.join(EXPORT_DIR, baseName);

      // Make sure the export dir exists – if the user forgot to mount it
      // we want a clear error instead of a cryptic ENOENT.
      try {
        await fs.mkdir(EXPORT_DIR, { recursive: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Cannot create export directory ${EXPORT_DIR}: ${msg}. ` +
            `Make sure it is mounted as a volume in docker-compose.yml ` +
            `(e.g. - /volume1/.../exports:/data/exports) and writable by ` +
            `the container user.`
        );
      }

      const response = await api.bulkDownload(
        args.ids,
        args.content ?? "archive",
        args.compression ?? "none",
        args.follow_formatting ?? false
      );

      const bytes = new Uint8Array(response.data);
      await fs.writeFile(fullPath, bytes);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                document_count: args.ids.length,
                container_path: fullPath,
                filename: baseName,
                size_bytes: bytes.byteLength,
                size_human: formatBytes(bytes.byteLength),
                hint: `File written inside the container at ${fullPath}. Pick it up from the host directory you mounted to ${EXPORT_DIR} (typically a Synology/NAS share).`,
              },
              null,
              2
            ),
          },
        ],
      };
    })
  );

  server.tool(
    "bulk_download_documents",
    [
      "Download multiple documents in one call as a single ZIP archive.",
      "Wraps the Paperless /api/documents/bulk_download/ endpoint and",
      "returns the ZIP as a base64 resource (mimeType application/zip).",
      "",
      "Heads-up: the response is base64-encoded and travels through the",
      "MCP context window – stay below ~10-20 MB of total document size",
      "to avoid blowing the LLM's context. For larger batches, narrow the",
      "ID list, set content='archive' (smaller than 'both'), or call",
      "download_document per id and stream out-of-band.",
    ].join(" "),
    {
      ids: z
        .array(z.number())
        .min(1)
        .describe("List of document IDs to include in the archive"),
      content: z
        .enum(["archive", "originals", "both"])
        .optional()
        .describe(
          "Which file copy to include (default: 'archive' – the OCR'd PDF view)"
        ),
      compression: z
        .enum(["none", "deflated", "bzip2", "lzma"])
        .optional()
        .describe(
          "ZIP entry compression. 'none' is fastest; PDFs don't shrink further."
        ),
      follow_formatting: z
        .boolean()
        .optional()
        .describe(
          "If true, mirror the on-disk directory layout configured in Paperless's filename-formatting setting"
        ),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const response = await api.bulkDownload(
        args.ids,
        args.content ?? "archive",
        args.compression ?? "none",
        args.follow_formatting ?? false
      );

      // Filename hint from Content-Disposition (Paperless sets one) → fallback.
      const cdRaw =
        typeof response.headers.get === "function"
          ? response.headers.get("content-disposition")
          : response.headers["content-disposition"];
      const filename =
        cdRaw?.split("filename=")[1]?.replace(/"/g, "") || "documents.zip";

      const ctRaw =
        typeof response.headers.get === "function"
          ? response.headers.get("content-type")
          : response.headers["content-type"];
      const mimeType = (ctRaw ?? "application/zip").split(";")[0].trim();

      const safeName = encodeURIComponent(filename);
      const uri = `paperless://documents/bulk/${safeName}`;

      const blob = Buffer.from(new Uint8Array(response.data)).toString(
        "base64"
      );

      return {
        content: [
          {
            type: "resource",
            resource: {
              uri,
              blob,
              mimeType,
            },
          },
        ],
      };
    })
  );

  server.tool(
    "get_document_thumbnail",
    "Get a document thumbnail (image preview) by ID. Returns the thumbnail as a base64-encoded WebP image resource.",
    {
      id: z.number(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const response = await api.getThumbnail(args.id);

      const ctRaw =
        typeof response.headers.get === "function"
          ? response.headers.get("content-type")
          : response.headers["content-type"];
      const mimeType = (ctRaw ?? "image/webp").split(";")[0].trim();

      // Use a real URI (scheme + path) so the MCP SDK validator accepts the
      // resource – passing `document-<id>-thumb.webp` alone produced
      // "malformed response" on the client side.
      const uri = `paperless://documents/${args.id}/thumbnail`;

      const blob = Buffer.from(new Uint8Array(response.data)).toString(
        "base64"
      );

      return {
        content: [
          {
            type: "resource",
            resource: {
              uri,
              blob,
              mimeType,
            },
          },
        ],
      };
    })
  );

  server.tool(
    "update_document",
    "Update a specific document with new values. This tool allows you to modify any document field including title, correspondent, document type, storage path, tags, custom fields, and more. Only the fields you specify will be updated.",
    {
      id: z.number().describe("The ID of the document to update"),
      title: z
        .string()
        .max(128)
        .optional()
        .describe("The new title for the document (max 128 characters)"),
      correspondent: z
        .number()
        .nullable()
        .optional()
        .describe("The ID of the correspondent to assign"),
      document_type: z
        .number()
        .nullable()
        .optional()
        .describe("The ID of the document type to assign"),
      storage_path: z
        .number()
        .nullable()
        .optional()
        .describe("The ID of the storage path to assign"),
      tags: z
        .array(z.number())
        .optional()
        .describe("Array of tag IDs to assign to the document"),
      content: z
        .string()
        .optional()
        .describe("The raw text content of the document (used for searching)"),
      created: z
        .string()
        .optional()
        .describe("The creation date in YYYY-MM-DD format"),
      archive_serial_number: z
        .number()
        .optional()
        .describe("The archive serial number (0-4294967295)"),
      owner: z
        .number()
        .nullable()
        .optional()
        .describe("The ID of the user who owns the document"),
      custom_fields: z
        .array(
          z.object({
            field: z.number().describe("The custom field ID"),
            value: z
              .union([
                z.string(),
                z.number(),
                z.boolean(),
                z.array(z.number()),
                z.null(),
              ])
              .describe(CUSTOM_FIELD_VALUE_DESCRIPTION),
          })
        )
        .optional()
        .describe("Array of custom field values to assign"),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const { id, ...updateData } = args;

      validateCustomFields(updateData.custom_fields);

      const response = await api.updateDocument(id, updateData);

      return convertDocsWithNames(response, api);
    })
  );
}

/** Pretty-print a byte count (B / KB / MB / GB). Used by the export tool. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIdx]}`;
}
