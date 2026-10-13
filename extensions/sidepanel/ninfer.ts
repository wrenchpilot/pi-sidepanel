import type {
  ExtensionAPI,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { SidepanelConfig } from "./config.js";
import { normalizeServiceBase } from "./prometheus.js";

interface NInferModelRecord {
  id?: string;
  owned_by?: string;
  max_model_len?: number;
  architecture?: { input_modalities?: string[] };
}

export async function discoverNinfer(
  pi: ExtensionAPI,
  cfg: SidepanelConfig["ninfer"],
): Promise<void> {
  const urls = (cfg?.urls ?? []).filter(
    (url) => url.trim().length > 0,
  );
  if (!urls.length) return;
  const apiKey = cfg?.apiKey ?? "";
  const headers: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : {};
  const lists = await Promise.all(
    urls.map(async (url) => {
      const baseUrl = normalizeServiceBase(url) + "/v1";
      try {
        const response = await fetch(`${baseUrl}/models`, {
          headers,
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) return [];
        const { data } = (await response.json()) as {
          data?: NInferModelRecord[];
        };
        return (data ?? []).flatMap(
          (m): ProviderModelConfig[] => {
            if (m.owned_by !== "ninfer" || !m.id) return [];
            const contextWindow = Math.max(
              1,
              Number(m.max_model_len) || 32768,
            );
            return [
              {
                id: m.id,
                name: m.id,
                baseUrl,
                reasoning: false,
                input:
                  m.architecture?.input_modalities?.includes(
                    "image",
                  )
                    ? ["text", "image"]
                    : ["text"],
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                compat: {
                  supportsDeveloperRole: false,
                  supportsReasoningEffort: true,
                  supportsUsageInStreaming: true,
                  supportsStore: false,
                  supportsStrictMode: false,
                  maxTokensField: "max_tokens",
                },
                contextWindow,
                maxTokens: Math.min(32768, contextWindow),
              },
            ];
          },
        );
      } catch {
        return [];
      }
    }),
  );
  const models: ProviderModelConfig[] = lists.flat();
  const baseUrl = models[0]?.baseUrl;
  if (!baseUrl) return;
  pi.registerProvider("ninfer", {
    api: "openai-completions",
    baseUrl,
    apiKey: apiKey || "ninfer",
    models,
  });
}
