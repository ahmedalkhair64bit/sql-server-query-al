export function detectEncoding(b) {
  if (b[0] === 255 && b[1] === 254 && b[2] === 0 && b[3] === 0)
    return "utf-32le";
  if (b[0] === 0 && b[1] === 0 && b[2] === 254 && b[3] === 255)
    return "utf-32be";
  if (b[0] === 255 && b[1] === 254) return "utf-16le";
  if (b[0] === 254 && b[1] === 255) return "utf-16be";
  if (b[0] === 60 && b[1] === 0 && b[2] === 0 && b[3] === 0) return "utf-32le";
  if (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 60) return "utf-32be";
  let even = 0,
    odd = 0;
  const len = Math.min(b.length - (b.length % 2), 200);
  for (let i = 0; i < len; i += 2) {
    if (b[i] === 0) even++;
    if (b[i + 1] === 0) odd++;
  }
  if (odd > len / 6 && len >= 4) return "utf-16le";
  if (even > len / 6 && len >= 4) return "utf-16be";
  return "utf-8";
}
export function createDecoder(encoding) {
  if (!encoding.startsWith("utf-32")) {
    const dec = new TextDecoder(encoding, { fatal: true });
    return {
      write: (b) => dec.decode(b, { stream: true }),
      end: () => dec.decode(),
    };
  }
  let carry = new Uint8Array();
  let first = true;
  return {
    write(b) {
      const data = new Uint8Array(carry.length + b.length);
      data.set(carry);
      data.set(b, carry.length);
      const end = data.length - (data.length % 4),
        view = new DataView(data.buffer),
        chars = [];
      for (let i = 0; i < end; i += 4) {
        const cp = view.getUint32(i, encoding === "utf-32le");
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
          throw new Error("Invalid UTF-32 code point");
        if (!(first && cp === 0xfeff)) chars.push(String.fromCodePoint(cp));
        first = false;
      }
      carry = data.slice(end);
      return chars.join("");
    },
    end() {
      if (carry.length) throw new Error("Incomplete UTF-32 character");
      return "";
    },
  };
}
export function decodeBytes(b) {
  try {
    const d = createDecoder(detectEncoding(b));
    return (d.write(b) + d.end()).replace(/^\uFEFF/, "");
  } catch {
    throw new Error(
      "Unsupported or malformed plan encoding. Save as UTF-8, UTF-16, or UTF-32 XML.",
    );
  }
}
