import type { Env } from "./env";
import { approved, currentMember } from "./auth";
import { cachedRoas } from "./roas";
import { handleAgent } from "./agents";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/health") return json({ ok: true });

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

      // Chat con un agente.
      if (path === "/api/agent") {
        if (req.method !== "POST") return json({ error: "Usa POST" }, 405);
        return handleAgent(req, env, me, ctx);
      }

      return json({ error: "Ruta no encontrada" }, 404);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
