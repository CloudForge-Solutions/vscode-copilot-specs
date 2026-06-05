import * as vscode from "vscode";

type ChatModelLike = vscode.LanguageModelChat & {
  id?: string;
  name?: string;
  family?: string;
  vendor?: string;
};

export interface ResolvedChatModel {
  model: vscode.LanguageModelChat;
  matchedBy: string;
}

const DEFAULT_MODEL_FALLBACKS = [
  "opus-4.5",
  "opus",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5",
  "sonnet-4.5",
  "sonnet",
  "deepseek-pro-max",
  "deepseek",
  "kimi-2.6",
  "kimi",
  "gpt-4o",
];

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function getModelStrings(model: vscode.LanguageModelChat): string[] {
  const candidate = model as ChatModelLike;
  return [candidate.id, candidate.name, candidate.family, candidate.vendor]
    .map(normalize)
    .filter(Boolean);
}

function matchesPreference(
  model: vscode.LanguageModelChat,
  preference: string,
): boolean {
  const wanted = normalize(preference);
  if (!wanted) {
    return false;
  }

  return getModelStrings(model).some(
    (candidate) => candidate === wanted || candidate.includes(wanted),
  );
}

export async function resolveChatModel(): Promise<ResolvedChatModel | undefined> {
  const config = vscode.workspace.getConfiguration("copilot-specs");
  const explicitModel = normalize(config.get<string>("model", ""));
  const configuredFallbacks = config.get<string[]>(
    "modelFallbacks",
    DEFAULT_MODEL_FALLBACKS,
  );

  const availableModels = await vscode.lm.selectChatModels({});
  if (availableModels.length === 0) {
    return undefined;
  }

  if (explicitModel) {
    const explicitMatch = availableModels.find((model) =>
      matchesPreference(model, explicitModel),
    );
    if (explicitMatch) {
      return { model: explicitMatch, matchedBy: explicitModel };
    }
  }

  for (const preference of configuredFallbacks) {
    const normalizedPreference = normalize(preference);
    if (!normalizedPreference) {
      continue;
    }

    const match = availableModels.find((model) =>
      matchesPreference(model, normalizedPreference),
    );
    if (match) {
      return { model: match, matchedBy: normalizedPreference };
    }
  }

  return { model: availableModels[0], matchedBy: "first-available" };
}
