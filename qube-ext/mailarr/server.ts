import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { defineExtension } from "@qube-code/extension-sdk";
import { mailarrMcpServer } from "./mcp.js";
import { openMailarrDatabase } from "./lib/db.js";
import { startScheduler, stopScheduler } from "./lib/scheduler.js";
import { registerMailarrRoutes } from "./routes.js";

const sessions = new Map<string, StreamableHTTPServerTransport>();
const builtDir = dirname(fileURLToPath(import.meta.url));
const sebeSkillDir = join(builtDir, "..", "skills", "sebe");

export default defineExtension({
  id: "mailarr",
  settings: [
    {
      id: "delivery",
      title: "Delivery",
      fields: [
        {
          key: "dry_run",
          label: "Dry run",
          placeholder: "true, defaults to true when unset",
        },
      ],
    },
    {
      id: "smtp",
      title: "SMTP",
      fields: [
        {
          key: "smtp_host",
          label: "Host",
          required: true,
          placeholder: "SMTP server hostname",
        },
        {
          key: "smtp_port",
          label: "TLS port",
          required: true,
          placeholder: "465",
        },
        {
          key: "smtp_user",
          label: "Username",
          required: true,
          secret: true,
          placeholder: "Leave blank to keep any saved value",
        },
        {
          key: "smtp_password",
          label: "Password",
          required: true,
          secret: true,
          placeholder: "Leave blank to keep any saved value",
        },
        {
          key: "from_address",
          label: "From address",
          required: true,
          placeholder: "sender@example.com",
        },
      ],
    },
  ],
  mcp: {
    name: "mailarr",
    url: (apiBase, workspaceId) => `${apiBase}/ext/mailarr/mcp/${workspaceId}`,
  },
  contributes: () => [
    {
      kind: "skill",
      name: "sebe",
      dir: sebeSkillDir,
      description: "Sebe outreach persona and Mailarr run protocol.",
    },
  ],
  activate: (ctx) => {
    const db = openMailarrDatabase(ctx.dataDir);
    db.close();
    startScheduler(ctx);
  },
  deactivate: (ctx) => stopScheduler(ctx),
  registerRoutes: (app, getCtx) => {
    registerMailarrRoutes(app, getCtx);

    app.all<{ Params: { workspace: string } }>(
      "/ext/mailarr/mcp/:workspace",
      async (req, reply) => {
        const ctx = getCtx(req);

        if (!ctx) return reply.code(409).send({ error: "no project open" });

        const workspaceId = Number(req.params.workspace);

        if (!Number.isInteger(workspaceId) || workspaceId < 0) {
          return reply.code(400).send({ error: "workspace must be a non-negative integer" });
        }

        const sid = req.headers["mcp-session-id"] as string | undefined;
        let transport = sid ? sessions.get(sid) : undefined;

        if (!transport) {
          const ref = { params: req.params, headers: req.headers };
          const requireCtx = () => {
            const current = getCtx(ref);

            if (!current) throw new Error("project closed");

            return current;
          };
          const server = mailarrMcpServer(requireCtx);
          const next = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
              sessions.set(id, next);
            },
          });

          next.onclose = () => {
            if (next.sessionId) sessions.delete(next.sessionId);
          };

          await server.connect(next);
          transport = next;
        }

        reply.hijack();
        await transport.handleRequest(req.raw, reply.raw, req.body);
      },
    );
  },
});
