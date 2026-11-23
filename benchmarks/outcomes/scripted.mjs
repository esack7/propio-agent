import { createServer } from "node:http";

function repairFiles(task) {
  return task === "fix-media-type"
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
}

function toolCalls(task, mode, requests) {
  if (requests !== 1 || mode === "noop") return undefined;
  return Object.entries(repairFiles(task)).map(([path, value]) => ({
    function: {
      name: "write",
      arguments: { path, content: JSON.stringify(value) + "\n" },
    },
  }));
}

function sendResponse(response, calls) {
  response.setHeader("Content-Type", "application/x-ndjson");
  response.end(
    JSON.stringify({
      model: "scripted",
      message: {
        role: "assistant",
        content: calls ? "" : "Done",
        ...(calls ? { tool_calls: calls } : {}),
      },
      done: true,
      done_reason: "stop",
    }) + "\n",
  );
}

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
    sendResponse(response, toolCalls(task, mode, requests));
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
