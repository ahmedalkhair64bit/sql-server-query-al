// Clipboard API requires HTTPS; the LAN deployment also supports plain HTTP.
export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const focused = document.activeElement as HTMLElement | null;
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("aria-label", "Text to copy");
  field.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(field);
  try {
    field.focus();
    field.select();
    if (!document.execCommand("copy"))
      throw new Error("Clipboard access failed");
  } finally {
    field.remove();
    focused?.focus({ preventScroll: true });
  }
}
