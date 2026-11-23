import { createServer } from "node:http";

// A local Ollama-compatible endpoint: responses exercise the CLI's real tools.
export async function startScriptedProvider(task, mode = "repair") {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    requests++;
    if (mode === "hang") return;
    if (mode === "fail") {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "scripted startup failure" }));
      return;
    }
    const files =
      task === "fix-media-type"
        ? {
            "types.json": {
              html: "text/html",
              png: "image/png",
              svg: "image/svg+xml",
            },
          }
        : {
            "en.json": { open: "Open", close: "Close", save: "Save" },
            "es.json": { open: "Abrir", close: "Cerrar", save: "Guardar" },
          };
    const tool_calls =
      requests === 1 && mode !== "noop"
        ? Object.entries(files).map(([path, value]) => ({
            function: {
              name: "write",
              arguments: { path, content: JSON.stringify(value) + "\n" },
            },
          }))
        : undefined;
    response.setHeader("Content-Type", "application/x-ndjson");
    response.end(
      JSON.stringify({
        model: "scripted",
        message: {
          role: "assistant",
          content: tool_calls ? "" : "Done",
          ...(tool_calls ? { tool_calls } : {}),
        },
        done: true,
        done_reason: "stop",
      }) + "\n",
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    host: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
