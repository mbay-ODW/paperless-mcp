import type { CallToolResult } from "@modelcontextprotocol/server";

// Deliberately not typed on the SDK's ToolCallback: Args and Extra are inferred
// from the registerTool call, and the handler's result only has to be a
// CallToolResult. See tsc memory use in the PR description.
export const withErrorHandling = <Args, Extra>(
  cb: (args: Args, extra: Extra) => CallToolResult | Promise<CallToolResult>
) => {
  return async (args: Args, extra: Extra): Promise<CallToolResult> => {
    try {
      return await cb(args, extra);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const responseData = (err as any)?.response?.data;
      const status = (err as any)?.response?.status;

      throw new Error(
        JSON.stringify({
          error: errorMessage,
          responseData,
          status,
        })
      );
    }
  };
};
