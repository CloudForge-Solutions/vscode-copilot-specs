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
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "gpt-5.5",
  "gpt-5.4",
  "claude-sonnet-4.6",
  "9r@deepseek-v4-pro-max",
  "h@deepseek-v4-pro-max",
  "9r@combo-kimi-2.6",
  "h@combo-kimi-2.6",
];

const MIN_BIG_CONTEXT_TOKENS = 1_000_000;

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function getModelMetadata(model: vscode.LanguageModelChat): ChatModelLike {
  return model as ChatModelLike;
}

function getExactFields(model: vscode.LanguageModelChat): string[] {
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
  return candidate.id ?? candidate.name ?? candidate.family ?? candidate.vendor ?? "unknown";
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
  const candidate = getModelMetadata(model);
  const idVersion = parseVersion(normalize(candidate.id));
  if (idVersion !== undefined) {
    return idVersion;
  }

  const nameVersion = parseVersion(normalize(candidate.name));
  if (nameVersion !== undefined) {
    return nameVersion;
  }

  const familyVersion = parseVersion(normalize(candidate.family));
  if (familyVersion !== undefined) {
    return familyVersion;
  }

  const explicitVersion = parseVersion(normalize(candidate.version));
  if (explicitVersion !== undefined) {
    return explicitVersion;
  }

  return undefined;
}

function getId(model: vscode.LanguageModelChat): string {
  return normalize(getModelMetadata(model).id);
}

function isClaudeModel(model: vscode.LanguageModelChat): boolean {
  const id = getId(model);
  if (id.startsWith("claude-")) {
    return true;
  }

  return getExactFields(model).some((value) => value.includes("claude"));
}

function isSonnetModel(model: vscode.LanguageModelChat): boolean {
  return getExactFields(model).some((value) => value.includes("sonnet"));
}

function isGptModel(model: vscode.LanguageModelChat): boolean {
  return getExactFields(model).some((value) => value.includes("gpt"));
}

function isDeepSeekModel(model: vscode.LanguageModelChat): boolean {
  return getExactFields(model).some((value) => value.includes("deepseek"));
}

function isKimiModel(model: vscode.LanguageModelChat): boolean {
  return getExactFields(model).some((value) => value.includes("kimi"));
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

function passesProviderExpectation(model: vscode.LanguageModelChat): boolean {
  const id = getId(model);

  if (isClaudeModel(model)) {
    return id.startsWith("claude-") || id.includes("/claude-");
  }

  if (isDeepSeekModel(model) || isKimiModel(model)) {
    return id.includes("@");
  }

  return true;
}

function matchesPreferenceExact(
  model: vscode.LanguageModelChat,
  preference: string,
): boolean {
  const wanted = normalize(preference);
  if (!wanted) {
    return false;
  }

  return getExactFields(model).includes(wanted);
}

function matchesKnownAlias(
  model: vscode.LanguageModelChat,
  preference: string,
): boolean {
  const wanted = normalize(preference);
  const id = getId(model);

  if (!wanted) {
    return false;
  }

  if (wanted.startsWith("claude-opus-") || wanted.startsWith("claude-sonnet-")) {
    return id === wanted || id.endsWith(`/${wanted}`);
  }

  if (wanted.startsWith("gpt-")) {
    return id === wanted;
  }

  if (wanted.includes("deepseek") || wanted.includes("kimi")) {
    return id === wanted;
  }

  return false;
}

function isEligible(model: vscode.LanguageModelChat): boolean {
  return (
    isStrongEnough(model) &&
    passesContextRequirement(model) &&
    passesProviderExpectation(model)
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
  const eligibleModels = availableModels.filter(isEligible);
  if (eligibleModels.length === 0) {
    return undefined;
  }

  if (explicitModel) {
    const explicitMatch = eligibleModels.find(
      (model) =>
        matchesPreferenceExact(model, explicitModel) ||
        matchesKnownAlias(model, explicitModel),
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

    const match = eligibleModels.find(
      (model) =>
        matchesPreferenceExact(model, normalizedPreference) ||
        matchesKnownAlias(model, normalizedPreference),
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
