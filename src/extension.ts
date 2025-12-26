import * as vscode from 'vscode';

import { fetchAllIssueCommentsText, fetchOpenIssuesForRepo, type GitHubIssue } from './github';
import { runChat, selectDefaultChatModel, truncateForPrompt } from './lm';
import { IssueSummaryViewProvider, type ExtensionProgressMessage } from './webview';

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('issue-digest.generateIssueReport', async () => {
		await generateIssueReport();
	});
	context.subscriptions.push(disposable);

	const viewProvider = new IssueSummaryViewProvider(context.extensionUri, async (reposText, view) => {
		await generateIssueReportFromWebview(reposText, view);
	});
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(IssueSummaryViewProvider.viewType, viewProvider)
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}

type IssueAnalysis = {
	repo: string;
	number: number;
	url: string;
	ask: string;
};

function parseRepos(input: string): string[] {
	return input
		.split(/[\s,]+/g)
		.map(s => s.trim())
		.filter(Boolean);
}

function defaultReportUri(): vscode.Uri {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		return vscode.Uri.joinPath(folder.uri, 'issue_analysis_report.md');
	}
	return vscode.Uri.joinPath(vscode.Uri.file(process.env.USERPROFILE ?? process.env.HOME ?? '.'), 'issue_analysis_report.md');
}

function formatTimestamp(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

async function getGitHubToken(): Promise<string> {
	const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
	if (!session?.accessToken) {
		throw new Error('Unable to acquire a GitHub access token from VS Code authentication.');
	}
	return session.accessToken;
}

function reportUriForWebview(): vscode.Uri {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		return vscode.Uri.joinPath(folder.uri, 'issue_analysis_report.md');
	}
	return vscode.Uri.joinPath(vscode.Uri.file(process.env.USERPROFILE ?? process.env.HOME ?? '.'), 'issue_analysis_report.md');
}

function postProgress(view: vscode.WebviewView, msg: ExtensionProgressMessage): void {
	void view.webview.postMessage(msg);
}

function percentFor(step: 'fetch' | 'summarize' | 'report', current?: number, total?: number): number {
	// Simple overall weighting: fetch 20%, summarize 60%, report 20%
	const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
	const ratio = total && total > 0 && typeof current === 'number' ? clamp01(current / total) : 0;
	if (step === 'fetch') {
		return Math.round(20 * ratio);
	}
	if (step === 'summarize') {
		return 20 + Math.round(60 * ratio);
	}
	return 80 + Math.round(20 * ratio);
}

async function summarizeIssue(model: vscode.LanguageModelChat, issue: GitHubIssue, commentsText: string, token: vscode.CancellationToken): Promise<string> {
	const title = truncateForPrompt(issue.title ?? '', 400);
	const body = truncateForPrompt(issue.body ?? '', 6000);
	const comments = truncateForPrompt(commentsText ?? '', 6000);

	const prompt = [
		'You summarize GitHub issues for product feedback triage.',
		'',
		'Analyze the following GitHub issue and provide a concise summary of what the user is requesting or what problem they are reporting.',
		'Focus on the core ask/requirement.',
		'Output: 1-4 sentences.',
		'',
		`Repository: ${issue.repo}`,
		`Issue: #${issue.number}`,
		`URL: ${issue.url}`,
		'',
		`Title: ${title}`,
		'',
		`Body:\n${body}`,
		'',
		`Comments:${comments ? `\n${comments}` : ' (none)'}`,
	].join('\n');

	const result = await runChat(model, prompt, token);
	return result || 'No summary produced.';
}

async function categorizeToReport(model: vscode.LanguageModelChat, analyses: IssueAnalysis[], repos: string[], token: vscode.CancellationToken): Promise<string> {
	const analysisText = analyses
		.map(a => `Repo: ${a.repo} | Issue: ${a.number} | Url: ${a.url} | Ask: ${a.ask}`)
		.join('\n');

	const prompt = [
		'You are a product manager analyzing GitHub issues to understand user needs and feature requests.',
		'',
		'Analyze the following GitHub issue summaries and categorize them into similar feature requests or problem types. Generate a report that:',
		'1. Groups similar requests together',
		'2. Identifies common patterns and themes',
		'3. Provides insights about what users are asking for most',
		'4. Suggests priorities based on frequency and severity keywords (crash, data loss, security, blocking, etc.)',
		'',
		'Instructions:',
		'- The report MUST be markdown.',
		'- Start with an "Executive summary" section with scope + top drivers + prioritization.',
		'- Each category should include: description, issue count, and a list of issue references.',
		'- Every issue reference must be a markdown hyperlink with issue_number as text and url as link, e.g. [123](https://github.com/owner/repo/issues/123).',
		'- Do not invent issues; only use the provided list.',
		'- Do not add any follow-up questions; just produce the report.',
		'- Aim for a professional and concise tone suitable for sharing with stakeholders.',
		'',
		'Here are the issue summaries to analyze:',
		'',
		`Repos: ${repos.join(', ')}`,
		`Total issue summaries: ${analyses.length}`,
		'',
		'Issue Analyses:',
		analysisText,
	].join('\n');

	const result = await runChat(model, prompt, token);
	return result || 'No report produced.';
}

async function generateIssueReport(): Promise<void> {
	const reposInput = await vscode.window.showInputBox({
		title: 'Generate GitHub Issue Summary Report',
		prompt: 'Enter repositories (owner/repo), separated by commas or spaces',
		placeHolder: 'microsoft/vscode, owner/repo',
		ignoreFocusOut: true,
	});
	if (!reposInput) {
		return;
	}
	const repos = parseRepos(reposInput);
	if (repos.length === 0) {
		vscode.window.showErrorMessage('No repositories provided.');
		return;
	}

	const outputUri = await vscode.window.showSaveDialog({
		title: 'Save Issue Report',
		defaultUri: defaultReportUri(),
		filters: { Markdown: ['md'] },
	});
	if (!outputUri) {
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Generating GitHub issue report',
			cancellable: true,
		},
		async (progress, token) => {
			progress.report({ message: 'Authenticating to GitHub…' });
			const githubToken = await getGitHubToken();

			progress.report({ message: 'Selecting language model…' });
			const model = await selectDefaultChatModel();

			progress.report({ message: 'Fetching issues…' });
			const allIssues: GitHubIssue[] = [];
			for (const repo of repos) {
				if (token.isCancellationRequested) {
					throw new Error('Cancelled');
				}
				progress.report({ message: `Fetching open issues: ${repo}` });
				const issues = await fetchOpenIssuesForRepo(repo, githubToken, token);
				allIssues.push(...issues);
			}

			progress.report({ message: `Summarizing ${allIssues.length} issues…` });
			const analyses: IssueAnalysis[] = [];
			for (let i = 0; i < allIssues.length; i++) {
				if (token.isCancellationRequested) {
					throw new Error('Cancelled');
				}
				const issue = allIssues[i];
				progress.report({ message: `Summarizing ${issue.repo}#${issue.number} (${i + 1}/${allIssues.length})` });
				const commentsText = await fetchAllIssueCommentsText(issue.commentsUrl, githubToken, token);
				const ask = await summarizeIssue(model, issue, commentsText, token);
				analyses.push({ repo: issue.repo, number: issue.number, url: issue.url, ask });
			}

			progress.report({ message: 'Generating categorized report…' });
			const reportBody = await categorizeToReport(model, analyses, repos, token);

			const header = [
				'# GitHub Issue Analysis Report',
				'',
				`**Generated on:** ${formatTimestamp()}`,
				'',
				`**Total Issues Analyzed:** ${analyses.length}`,
				'',
				`**Repositories:** ${repos.join(', ')}`,
				'',
				'---',
				'',
			].join('\n');

			const report = header + reportBody.trim() + '\n';
			await vscode.workspace.fs.writeFile(outputUri, Buffer.from(report, 'utf8'));

			const doc = await vscode.workspace.openTextDocument(outputUri);
			await vscode.window.showTextDocument(doc, { preview: false });
			vscode.window.showInformationMessage(`Issue report generated: ${outputUri.fsPath}`);
		}
	);
}

async function generateIssueReportFromWebview(reposText: string, view: vscode.WebviewView): Promise<void> {
	const repos = parseRepos(reposText);
	if (repos.length === 0) {
		postProgress(view, { type: 'progress', step: 'fetch', status: 'error', message: 'No repositories provided.', percent: 0 });
		void view.webview.postMessage({ type: 'result', status: 'error', message: 'Please enter at least one repository.' });
		return;
	}

	const outputUri = vscode.workspace.workspaceFolders?.[0] ? reportUriForWebview() : await vscode.window.showSaveDialog({
		title: 'Save Issue Report',
		defaultUri: reportUriForWebview(),
		filters: { Markdown: ['md'] },
	});
	if (!outputUri) {
		postProgress(view, { type: 'progress', step: 'fetch', status: 'error', message: 'No output path selected.', percent: 0 });
		void view.webview.postMessage({ type: 'result', status: 'error', message: 'Cancelled: no output file selected.' });
		return;
	}

	const cts = new vscode.CancellationTokenSource();
	try {
		postProgress(view, { type: 'progress', step: 'fetch', status: 'in-progress', message: 'Authenticating to GitHub…', percent: 0 });
		const githubToken = await getGitHubToken();

		postProgress(view, { type: 'progress', step: 'fetch', status: 'in-progress', message: 'Selecting language model…', percent: 0 });
		const model = await selectDefaultChatModel();

		postProgress(view, { type: 'progress', step: 'fetch', status: 'in-progress', message: 'Fetching issues…', current: 0, total: repos.length, percent: 0 });
		const allIssues: GitHubIssue[] = [];
		for (let i = 0; i < repos.length; i++) {
			if (cts.token.isCancellationRequested) {
				throw new Error('Cancelled');
			}
			const repo = repos[i];
			postProgress(view, {
				type: 'progress',
				step: 'fetch',
				status: 'in-progress',
				message: `Fetching open issues: ${repo} (${i + 1}/${repos.length})`,
				current: i + 1,
				total: repos.length,
				percent: percentFor('fetch', i + 1, repos.length),
			});
			const issues = await fetchOpenIssuesForRepo(repo, githubToken, cts.token);
			allIssues.push(...issues);
		}
		postProgress(view, { type: 'progress', step: 'fetch', status: 'done', message: `Fetched ${allIssues.length} open issues.`, percent: 20 });

		postProgress(view, { type: 'progress', step: 'summarize', status: 'in-progress', message: `Summarizing ${allIssues.length} issues…`, current: 0, total: allIssues.length, percent: 20 });
		const analyses: IssueAnalysis[] = [];
		for (let i = 0; i < allIssues.length; i++) {
			if (cts.token.isCancellationRequested) {
				throw new Error('Cancelled');
			}
			const issue = allIssues[i];
			postProgress(view, {
				type: 'progress',
				step: 'summarize',
				status: 'in-progress',
				message: `Summarizing ${issue.repo}#${issue.number} (${i + 1}/${allIssues.length})`,
				current: i + 1,
				total: allIssues.length,
				percent: percentFor('summarize', i + 1, allIssues.length),
			});
			const commentsText = await fetchAllIssueCommentsText(issue.commentsUrl, githubToken, cts.token);
			const ask = await summarizeIssue(model, issue, commentsText, cts.token);
			analyses.push({ repo: issue.repo, number: issue.number, url: issue.url, ask });
		}
		postProgress(view, { type: 'progress', step: 'summarize', status: 'done', message: 'Summaries complete.', percent: 80 });

		postProgress(view, { type: 'progress', step: 'report', status: 'in-progress', message: 'Generating categorized report…', percent: 85 });
		const reportBody = await categorizeToReport(model, analyses, repos, cts.token);
		postProgress(view, { type: 'progress', step: 'report', status: 'in-progress', message: 'Writing markdown report…', percent: 95 });

		const header = [
			'# GitHub Issue Analysis Report',
			'',
			`**Generated on:** ${formatTimestamp()}`,
			'',
			`**Total Issues Analyzed:** ${analyses.length}`,
			'',
			`**Repositories:** ${repos.join(', ')}`,
			'',
			'---',
			'',
		].join('\n');

		const report = header + reportBody.trim() + '\n';
		await vscode.workspace.fs.writeFile(outputUri, Buffer.from(report, 'utf8'));
		postProgress(view, { type: 'progress', step: 'report', status: 'done', message: 'Report generated.', percent: 100 });

		const doc = await vscode.workspace.openTextDocument(outputUri);
		await vscode.window.showTextDocument(doc, { preview: false });
		void view.webview.postMessage({ type: 'result', status: 'done', message: `Report generated: ${outputUri.fsPath}`, reportPath: outputUri.fsPath });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		postProgress(view, { type: 'progress', step: 'report', status: 'error', message: msg, percent: 0 });
		void view.webview.postMessage({ type: 'result', status: 'error', message: `Failed: ${msg}` });
	} finally {
		cts.dispose();
	}
}
