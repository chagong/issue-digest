import * as vscode from 'vscode';

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

export function truncateForPrompt(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}
	return value.slice(0, maxChars) + `\n\n[TRUNCATED: ${value.length - maxChars} chars omitted]`;
}
