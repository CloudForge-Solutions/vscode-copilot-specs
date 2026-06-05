import * as vscode from "vscode";

type ChatModelLike = vscode.LanguageModelChat & {
  id?: string;
  name?: string;
  family?: string;
  vendor?: string;
  version?: string;
  maxInputTokens?: number;
};

export interface ResolvedChatModel {
  model: vscode.LanguageModelChat;
  matchedBy: string;
  descriptor: string;
  isFallback: boolean;
}

const DEFAULT_MODEL_FALLBACKS = [
  "opus-4.6",
  "opus-4.5",
  "opus",
  "gpt-5.5",
  "gpt-5.4",
  "sonnet-4.6",
  "deepseek-pro-max",
  "kimi-2.6",
];

const MIN_BIG_CONTEXT_TOKENS = 1_000_000;

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function getModelMetadata(model: vscode.LanguageModelChat): ChatModelLike {
  return model as ChatModelLike;
}

function getModelStrings(model: vscode.LanguageModelChat): string[] {
  const candidate = getModelMetadata(model);
  return [
    candidate.id,
    candidate.name,
    candidate.family,
    candidate.vendor,
    candidate.version,
  ]
    .map(normalize)
    .filter(Boolean);
}

function getPrimaryDescriptor(model: vscode.LanguageModelChat): string {
  const candidate = getModelMetadata(model);
  return (
    candidate.name ??
    candidate.id ??
    candidate.family ??
    candidate.vendor ??
    "unknown"
  );
}

function parseVersion(text: string): number | undefined {
  const match = text.match(/(?:^|[^\d])(\d+(?:\.\d+)?)(?:[^\d]|$)/);
  if (!match) {
    return undefined;
  }

  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getBestDetectedVersion(model: vscode.LanguageModelChat): number | undefined {
  for (const value of getModelStrings(model)) {
    const parsed = parseVersion(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function isSonnetModel(model: vscode.LanguageModelChat): boolean {
  return getModelStrings(model).some((value) => value.includes("sonnet"));
}

function isGptModel(model: vscode.LanguageModelChat): boolean {
  return getModelStrings(model).some((value) => value.includes("gpt"));
}

function hasBigContext(model: vscode.LanguageModelChat): boolean {
  const candidate = getModelMetadata(model);
  return (candidate.maxInputTokens ?? 0) >= MIN_BIG_CONTEXT_TOKENS;
}

function isStrongEnough(model: vscode.LanguageModelChat): boolean {
  const version = getBestDetectedVersion(model);

  if (isGptModel(model) && version !== undefined && version < 5.4) {
    return false;
  }

  if (isSonnetModel(model) && version !== undefined && version < 4.6) {
    return false;
  }

  return true;
}

function passesContextRequirement(model: vscode.LanguageModelChat): boolean {
  if (isSonnetModel(model)) {
    return true;
  }

  return hasBigContext(model);
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

function isEligible(model: vscode.LanguageModelChat): boolean {
  return isStrongEnough(model) && passesContextRequirement(model);
}

export async function resolveChatModel(): Promise<ResolvedChatModel | undefined> {
  const config = vscode.workspace.getConfiguration("copilot-specs");
  const explicitModel = normalize(config.get<string>("model", ""));
  const configuredFallbacks = config.get<string[]>(
    "modelFallbacks",
    DEFAULT_MODEL_FALLBACKS,
  );

  const availableModels = await vscode.lm.selectChatModels({});
  const eligibleModels = availableModels.filter(isEligible);
  if (eligibleModels.length === 0) {
    return undefined;
  }

  if (explicitModel) {
    const explicitMatch = eligibleModels.find((model) =>
      matchesPreference(model, explicitModel),
    );
    if (explicitMatch) {
      return {
        model: explicitMatch,
        matchedBy: explicitModel,
        descriptor: getPrimaryDescriptor(explicitMatch),
        isFallback: false,
      };
    }
  }

  for (const preference of configuredFallbacks) {
    const normalizedPreference = normalize(preference);
    if (!normalizedPreference) {
      continue;
    }

    const match = eligibleModels.find((model) =>
      matchesPreference(model, normalizedPreference),
    );
    if (match) {
      return {
        model: match,
        matchedBy: normalizedPreference,
        descriptor: getPrimaryDescriptor(match),
        isFallback: false,
      };
    }
  }

  const fallbackModel = eligibleModels[0];
  return {
    model: fallbackModel,
    matchedBy: "first-eligible",
    descriptor: getPrimaryDescriptor(fallbackModel),
    isFallback: true,
  };
}
