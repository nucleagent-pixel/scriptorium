import type { Env } from "./env";
import { approved, currentMember } from "./auth";
import { cachedRoas } from "./roas";
import { handleMcp } from "./mcp";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/health") return json({ ok: true });

    // Conector de Claude (MCP): /mcp/<MCP_KEY> o /mcp con Authorization: Bearer <MCP_KEY>
    const mcp = path.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (mcp) return handleMcp(req, env, mcp[1] ? decodeURIComponent(mcp[1]) : null);

    // Datos públicos que necesita la página para iniciar sesión con Supabase.
    if (path === "/api/config") {
      return json({ supabaseUrl: env.SUPABASE_URL, supabaseAnonKey: env.SUPABASE_ANON_KEY });
    }

    if (path.startsWith("/api/")) {
      // Mi ficha (la crea la primera vez que alguien entra).
      if (path === "/api/me") {
        const me = await currentMember(req, env, true);
        return me ? json(me) : json({ error: "Inicia sesión" }, 401);
      }

      const me = await currentMember(req, env);
      if (!me) return json({ error: "Inicia sesión" }, 401);
      if (!approved(me)) return json({ error: "Tu acceso está pendiente de aprobación" }, 403);

      // ROAS de los últimos 3 días por producto y país, leído del NUCLEA Dashboard.
      if (path === "/api/roas" && req.method === "GET") {
        return json(await cachedRoas(env, ctx));
      }

      // URL del conector MCP para que el equipo lo agregue en Claude.
      if (path === "/api/mcp") {
        const ok = env.MCP_KEY && env.MCP_KEY.length >= 16;
        return json({ url: ok ? `${url.origin}/mcp/${encodeURIComponent(env.MCP_KEY as string)}` : null });
      }

      return json({ error: "Ruta no encontrada" }, 404);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
