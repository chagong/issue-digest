import * as vscode from 'vscode';

import { fetchAllIssueCommentsText, fetchOpenIssuesForRepo, type GitHubIssue } from './github';
import { runChat, selectDefaultChatModel, truncateForPrompt } from './lm';

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('github-issue-summary.generateIssueReport', async () => {
		await generateIssueReport();
	});
	context.subscriptions.push(disposable);
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

async function summarizeIssue(model: vscode.LanguageModelChat, issue: GitHubIssue, commentsText: string, token: vscode.CancellationToken): Promise<string> {
	const title = truncateForPrompt(issue.title ?? '', 400);
	const body = truncateForPrompt(issue.body ?? '', 6000);
	const comments = truncateForPrompt(commentsText ?? '', 6000);

	const prompt = [
		'You summarize GitHub issues for product feedback triage.',
		'',
		'Analyze the following GitHub issue and provide a concise summary of what the user is requesting or what problem they are reporting.',
		'Focus on the core ask/requirement.',
		'Output: 1-2 sentences.',
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
