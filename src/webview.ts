import * as vscode from 'vscode';

export type WebviewStartMessage = {
	type: 'start';
	reposText: string;
};

export type WebviewReadyMessage = {
	type: 'ready';
};

export type WebviewToExtensionMessage = WebviewStartMessage | WebviewReadyMessage;

export type ExtensionProgressMessage = {
	type: 'progress';
	step: 'fetch' | 'summarize' | 'report';
	status: 'not-started' | 'in-progress' | 'done' | 'error';
	message?: string;
	current?: number;
	total?: number;
	percent?: number;
};

export type ExtensionResultMessage = {
	type: 'result';
	status: 'done' | 'error';
	message: string;
	reportPath?: string;
};

export type ExtensionToWebviewMessage = ExtensionProgressMessage | ExtensionResultMessage;

function getNonce(): string {
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

export class IssueSummaryViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'github-issue-summary.issueSummaryView';

	private view?: vscode.WebviewView;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onStart: (reposText: string, view: vscode.WebviewView) => Promise<void>
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		this.disposeDisposables();
		this.disposables.push(
			webviewView.webview.onDidReceiveMessage(async (msg: WebviewToExtensionMessage) => {
				if (!msg || typeof msg.type !== 'string') {
					return;
				}
				if (msg.type === 'ready') {
					void webviewView.webview.postMessage({ type: 'result', status: 'done', message: 'Ready.' });
					return;
				}
				if (msg.type === 'start') {
					await this.onStart(msg.reposText, webviewView);
				}
			})
		);
		this.disposables.push(
			webviewView.onDidDispose(() => {
				this.disposeDisposables();
			})
		);
	}

	postMessage(message: ExtensionToWebviewMessage): void {
		void this.view?.webview.postMessage(message);
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'));

		const nonce = getNonce();
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource} https:`,
			`style-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Issue Summary</title>
	<link href="${styleUri}" rel="stylesheet">

</head>
<body>
	<label for="repos">Repositories (owner/repo, separated by commas or spaces)</label>
	<textarea id="repos" placeholder="microsoft/vscode, owner/repo"></textarea>
	<div class="row">
		<button id="start">Start</button>
	</div>

	<div class="steps">
		<div class="step"><span class="badge" id="badge-fetch">not started</span><strong>Fetch issues</strong> <span class="mono" id="msg-fetch"></span></div>
		<div class="step"><span class="badge" id="badge-summarize">not started</span><strong>Summarize each issue</strong> <span class="mono" id="msg-summarize"></span></div>
		<div class="step"><span class="badge" id="badge-report">not started</span><strong>Generate report</strong> <span class="mono" id="msg-report"></span></div>
		<div class="step"><progress id="bar" value="0" max="100"></progress></div>
		<div class="log" id="log" aria-label="progress log"></div>
	</div>

	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private disposeDisposables(): void {
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}
}
