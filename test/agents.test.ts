import { describe, expect, it } from "vitest";
import { buildMessages, systemPrompt } from "../src/agents";

describe("agentes", () => {
  it("arma los mensajes con adjuntos y quién escribe", () => {
    const m = buildMessages({
      agent: "desarrollador",
      messages: [
        { role: "user", text: "Hola", who: "Anyelita", attachments: [
          { kind: "image", name: "a.png", media_type: "image/png", data: "AAAA" },
          { kind: "pdf", name: "b.pdf", data: "BBBB" },
          { kind: "text", name: "c.txt", text: "guion" },
          { kind: "image", name: "x.svg", media_type: "image/svg+xml", data: "CCCC" },
        ] },
      ],
    });
    expect(m).toHaveLength(1);
    const c = m[0].content as { type: string }[];
    expect(c.map((b) => b.type)).toEqual(["image", "document", "text", "text"]);
  });

  it("junta turnos seguidos y exige terminar en el equipo", () => {
    const m = buildMessages({ agent: "editor", messages: [
      { role: "user", text: "a" }, { role: "user", text: "b" }, { role: "assistant", text: "c" }, { role: "user", text: "d" },
    ] });
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(() => buildMessages({ agent: "editor", messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }] })).toThrow();
  });

  it("rechaza agentes desconocidos y agrega el contexto", () => {
    expect(() => systemPrompt("otro")).toThrow();
    expect(systemPrompt("creador", "Producto: Reto")).toContain("Producto: Reto");
  });
});
