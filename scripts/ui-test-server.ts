// Local-only acceptance fixture. Never imported by the production Worker.
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createApiApp } from "../apps/api/src/app.ts";
import { VideoComposeClient } from "../packages/client/src/index.ts";
import { seedWorkbench } from "../tests/e2e/workbench-fixture.ts";
import { seedProjectLibrary } from "../tests/e2e/project-fixture.ts";
if (process.env.NODE_ENV === "production")
  throw new Error("The acceptance server is local-only.");
const root = path.resolve(import.meta.dirname, "../apps/web/dist");
const writer = {
  "cf-access-authenticated-user-email": "alice@talkincode.net",
  "cf-access-jwt-assertion": "local-acceptance",
};
let backend = createApiApp();
async function reset(count = 100): Promise<void> {
  backend = createApiApp();
  const client = new VideoComposeClient({
    baseUrl: "http://localhost",
    headers: writer,
    fetchFn: async (input, init) =>
      backend.app.fetch(new Request(String(input), init)),
  });
  await seedWorkbench(client, count);
  await seedProjectLibrary(client);
}
await reset();
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/__test/reset" && request.method === "POST") {
      await reset();
      response.end("reset");
      return;
    }
    if (url.pathname === "/__test/fail-next" && request.method === "POST") {
      const stage = url.searchParams.get("stage") ?? "patchComposition";
      if (
        !["patchComposition", "createProject", "createComposition"].includes(
          stage,
        )
      ) {
        response.writeHead(400);
        response.end("Unknown fault stage");
        return;
      }
      backend.domain.store.injectFaultOnce(stage);
      response.end("armed");
      return;
    }
    if (url.pathname.startsWith("/v1/") || url.pathname === "/mcp") {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const role = request.headers["x-test-role"];
      headers.set(
        "cf-access-authenticated-user-email",
        role === "reader"
          ? "bob-reader@talkincode.net"
          : role === "outsider"
            ? "outside@talkincode.net"
            : "alice@talkincode.net",
      );
      headers.set("cf-access-jwt-assertion", "local-acceptance");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const method = request.method ?? "GET";
      const result = await backend.app.fetch(
        new Request(url, {
          method,
          headers,
          ...(method !== "GET" && method !== "HEAD"
            ? { body: Buffer.concat(chunks) }
            : {}),
        }),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) {
        const reader = result.body.getReader();
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          response.write(item.value);
        }
      }
      response.end();
      return;
    }
    const resolved = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403);
      response.end();
      return;
    }
    let file = resolved;
    try {
      if (!(await fs.stat(file)).isFile()) file = path.join(root, "index.html");
    } catch {
      file = path.join(root, "index.html");
    }
    const mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
    };
    response.writeHead(200, {
      "content-type": mime[path.extname(file)] ?? "application/octet-stream",
    });
    response.end(await fs.readFile(file));
  } catch (error) {
    response.writeHead(500);
    response.end(
      error instanceof Error ? error.message : "Local fixture failed",
    );
  }
});
server.listen(4179, "127.0.0.1", () =>
  console.log("Local acceptance fixture: http://127.0.0.1:4179"),
);
