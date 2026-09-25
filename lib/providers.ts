// OpenAI-compatible providers the analyst can use. Picking one fills the base URL; model names are
// suggestions only (providers rename models often) and the connection test lists what the key can use.
export type Provider = {
  id: string;
  label: string;
  baseUrl: string;
  /** Shown under the URL field when the URL needs editing, e.g. an Azure resource name. */
  urlHint?: string;
  keyHint: string;
  models: string[];
};
export const PROVIDERS: Provider[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "platform.openai.com → API keys",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o-mini"],
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
    urlHint:
      "Replace YOUR-RESOURCE with your Azure OpenAI resource name; the model is your deployment name.",
    keyHint: "Azure portal → your OpenAI resource → Keys and Endpoint",
    models: [],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyHint: "Google AI Studio → Get API key",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyHint: "openrouter.ai → Keys",
    models: [],
  },
  {
    id: "ollama",
    label: "Ollama (self-hosted)",
    baseUrl: "http://host.docker.internal:11434/v1",
    urlHint:
      "From Docker, host.docker.internal reaches the machine running Ollama. Any key works.",
    keyHint: "Ollama ignores the key: enter any text, e.g. ollama",
    models: ["qwen3:32b", "llama3.3:70b"],
  },
  {
    id: "vllm",
    label: "vLLM (self-hosted)",
    baseUrl: "http://host.docker.internal:8000/v1",
    urlHint: "Point at your vLLM server's /v1 endpoint.",
    keyHint:
      "The --api-key your vLLM server was started with, or any text if none",
    models: [],
  },
  {
    id: "custom",
    label: "Other OpenAI-compatible",
    baseUrl: "",
    keyHint: "Your provider's API key",
    models: [],
  },
];
export const providerFor = (baseUrl: string) => {
  if (!baseUrl) return PROVIDERS[0];
  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return "";
    }
  };
  if (/\.openai\.azure\.com$/.test(host(baseUrl)))
    return PROVIDERS.find((p) => p.id === "azure")!;
  return (
    PROVIDERS.find(
      (p) =>
        p.baseUrl &&
        p.id !== "azure" &&
        host(p.baseUrl) === host(baseUrl) &&
        baseUrl.startsWith(p.baseUrl.split("/v")[0]),
    ) ?? PROVIDERS.find((p) => p.id === "custom")!
  );
};
