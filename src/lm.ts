import * as vscode from 'vscode';

export type TokenUsage = {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
};

export type ChatRunResult = {
	text: string;
	usage: TokenUsage;
};

export async function selectDefaultChatModel(): Promise<vscode.LanguageModelChat> {
	const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
	if (!models || models.length === 0) {
		throw new Error('No language model available. Ensure GitHub Copilot Chat is available and enabled.');
	}
	return models[0];
}

export async function runChat(model: vscode.LanguageModelChat, prompt: string, token?: vscode.CancellationToken): Promise<string> {
	const response = await model.sendRequest(
		[vscode.LanguageModelChatMessage.User(prompt)],
		{
			justification: 'Generate a customer feedback report from GitHub issues.',
		},
		token
	);

	let text = '';
	for await (const part of response.stream) {
		if (part instanceof vscode.LanguageModelTextPart) {
			text += part.value;
		}
	}

	return text.trim();
}

function safeNumber(n: unknown): number {
	return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

async function safeCountTokens(model: vscode.LanguageModelChat, value: string | vscode.LanguageModelChatMessage, token?: vscode.CancellationToken): Promise<number> {
	try {
		return safeNumber(await model.countTokens(value, token));
	} catch {
		return 0;
	}
}

export async function runChatWithUsage(model: vscode.LanguageModelChat, prompt: string, token?: vscode.CancellationToken): Promise<ChatRunResult> {
	const userMsg = vscode.LanguageModelChatMessage.User(prompt);
	const inputTokens = await safeCountTokens(model, userMsg, token);

	const response = await model.sendRequest(
		[userMsg],
		{
			justification: 'Generate a customer feedback report from GitHub issues.',
		},
		token
	);

	let text = '';
	for await (const part of response.stream) {
		if (part instanceof vscode.LanguageModelTextPart) {
			text += part.value;
		}
	}

	const trimmed = text.trim();
	const outputTokens = await safeCountTokens(model, trimmed, token);

	return {
		text: trimmed,
		usage: {
			inputTokens,
			outputTokens,
			totalTokens: inputTokens + outputTokens,
		},
	};
}

export function truncateForPrompt(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}
	return value.slice(0, maxChars) + `\n\n[TRUNCATED: ${value.length - maxChars} chars omitted]`;
}
