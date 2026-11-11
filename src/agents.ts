import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import type { Member } from "./auth";

/** Instrucciones de cada agente. La lista visible (nombre y descripción) vive en la página. */
export const AGENT_PROMPTS: Record<string, string> = {
  desarrollador:
    "Eres el Desarrollador de productos del equipo NUCLEA. Modelas productos digitales de bienestar de aporte voluntario que se venden por WhatsApp con anuncios de Meta, para Colombia, Venezuela, Chile y Bolivia. Entregas: la oferta, ángulos de venta, guiones de video en tono neutro (manteniendo la estructura de los guiones de referencia cuando te los pasan), el script de ventas de WhatsApp adaptado al país y copys con estructura AIDA. Escribe en español, claro y listo para usar, con títulos para cada sección.",
  creador:
    "Eres el Creador de productos del equipo NUCLEA. Diseñas retos de bienestar: avatar, oferta, plan día por día, el contenido de los PDF y bonos, y la estructura de la app del reto. Aquí escribes el contenido y la estructura en texto; el PDF final y el .zip de la app se generan aparte. Escribe en español, ordenado por secciones.",
  editor:
    "Eres el Editor de video del equipo NUCLEA. Ayudas a planear reels verticales para Instagram y TikTok a partir de guiones, transcripciones o descripciones de clips: eliges la mejor toma, propones cortes, el gancho de los primeros 3 segundos, subtítulos de 1 a 3 palabras con palabras clave destacadas, b-roll, textos en pantalla y el cierre con llamado a la acción. La edición final del video se hace aparte; aquí entregas el plan detallado. Escribe en español.",
  investigador:
    "Eres el Investigador de anuncios del equipo NUCLEA. Ayudas a pensar qué buscar en la biblioteca de anuncios de Meta: palabras clave, señales de un anunciante modelable (cantidad de anuncios activos, antigüedad, variaciones) y cómo registrar cada hallazgo (fan page, de qué trata, número de anuncios). No tienes acceso directo a la biblioteca de anuncios: trabajas con lo que te cuentan o pegan. Escribe en español.",
};

export interface Attachment { kind: "image" | "pdf" | "text"; name: string; media_type?: string; data?: string; text?: string }
export interface ChatTurn { role: "user" | "assistant"; text: string; who?: string; attachments?: Attachment[] }
export interface AgentRequest { agent: string; context?: string; messages: ChatTurn[] }

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_BODY = 25 * 1024 * 1024;

/** Valida el pedido de la página y lo convierte en mensajes para Claude. */
export function buildMessages(body: AgentRequest): Anthropic.Beta.BetaMessageParam[] {
  const turns = (body.messages || []).filter((m) => m && (m.role === "user" || m.role === "assistant"));
  if (!turns.length || turns[turns.length - 1].role !== "user") throw new Error("El último mensaje debe ser del equipo");
  // Claude necesita que los turnos alternen; se juntan los seguidos del mismo lado.
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const t of turns) {
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const a of t.role === "user" ? t.attachments || [] : []) {
      if (a.kind === "image" && a.data && IMAGE_TYPES.has(a.media_type || "")) {
        blocks.push({ type: "image", source: { type: "base64", media_type: a.media_type as "image/png", data: a.data } });
      } else if (a.kind === "pdf" && a.data) {
        blocks.push({ type: "document", title: a.name, source: { type: "base64", media_type: "application/pdf", data: a.data } });
      } else if (a.kind === "text" && a.text) {
        blocks.push({ type: "text", text: `--- Archivo adjunto: ${a.name} ---\n${a.text}` });
      }
    }
    const who = t.role === "user" && t.who ? `Mensaje de ${t.who}:\n` : "";
    const text = (who + (t.text || "")).trim();
    if (text) blocks.push({ type: "text", text });
    if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role && Array.isArray(last.content)) last.content.push(...blocks);
    else out.push({ role: t.role, content: blocks });
  }
  if (!out.length || out[0].role !== "user") throw new Error("La conversación debe empezar con un mensaje del equipo");
  return out;
}

export function systemPrompt(agent: string, context?: string): string {
  const base = AGENT_PROMPTS[agent];
  if (!base) throw new Error("Agente desconocido");
  const ctx = (context || "").trim().slice(0, 4000);
  return ctx ? `${base}\n\n${ctx}` : base;
}

/** Responde en texto plano que llega por partes, para que la página lo vaya mostrando. */
export async function handleAgent(req: Request, env: Env, member: Member, ctx: ExecutionContext): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) return Response.json({ error: "Falta la clave ANTHROPIC_API_KEY en Cloudflare" }, { status: 503 });
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) return Response.json({ error: "Los adjuntos pesan demasiado (máximo 25 MB por mensaje)" }, { status: 413 });
  let body: AgentRequest;
  let messages: Anthropic.Beta.BetaMessageParam[];
  let system: string;
  try {
    body = (await req.json()) as AgentRequest;
    const last = body.messages?.[body.messages.length - 1];
    if (last && last.role === "user" && !last.who) last.who = member.name;
    messages = buildMessages(body);
    system = systemPrompt(body.agent, body.context);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Pedido inválido" }, { status: 400 });
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const effort = (env.AGENT_EFFORT || "high") as "low" | "medium" | "high";
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const run = async () => {
    try {
      const stream = client.beta.messages.stream(
        {
          model: env.AGENT_MODEL || "claude-opus-5-5",
          max_tokens: 32000,
          system,
          messages,
          output_config: { effort },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        } as Anthropic.Beta.MessageCreateParamsStreaming,
        { signal: req.signal },
      );
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          await writer.write(enc.encode(ev.delta.text));
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "max_tokens") await writer.write(enc.encode("\n\n[Respuesta cortada por largo. Pídele que continúe.]"));
      if (final.stop_reason === "refusal") await writer.write(enc.encode("\n\n[El agente no pudo responder este pedido.]"));
    } catch (e) {
      const msg = e instanceof Anthropic.RateLimitError ? "Demasiadas consultas seguidas. Espera un momento."
        : e instanceof Anthropic.APIError ? `El agente no pudo responder (${e.status ?? "error"}).`
        : "El agente no pudo responder.";
      console.error("agent", e instanceof Error ? e.message : e);
      await writer.write(enc.encode(`\n\n[${msg}]`)).catch(() => null);
    } finally {
      await writer.close().catch(() => null);
    }
  };
  // Mantener vivo el Worker mientras Claude escribe.
  ctx.waitUntil(run());
  return new Response(readable, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
