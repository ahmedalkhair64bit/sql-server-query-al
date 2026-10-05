export const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: any }> {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let at: number;
    while ((at = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, at); buf = buf.slice(at + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1] ?? "message";
      const raw = /^data: (.*)$/m.exec(frame)?.[1] ?? "";
      try { yield { event, data: JSON.parse(raw) }; } catch { /* keep-alive or unparsable frame */ }
    }
  }
}

export async function* openAiTextDeltas(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let at: number;
    while ((at = buf.indexOf("\n\n")) !== -1) {
      const line = (buf.slice(0, at).split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5).trim();
      buf = buf.slice(at + 2);
      if (!line) continue;
      if (line === "[DONE]") return;
      let delta: unknown;
      try { delta = JSON.parse(line)?.choices?.[0]?.delta?.content; } catch { continue; }
      if (typeof delta === "string" && delta) yield delta;
    }
  }
}
