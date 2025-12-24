import * as vscode from 'vscode';

export interface GitHubIssue {
	repo: string;
	number: number;
	title: string;
	body: string;
	url: string;
	updatedAt: string;
	commentsUrl: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function getAbortSignal(token?: vscode.CancellationToken): AbortSignal | undefined {
	if (!token) {
		return undefined;
	}
	const controller = new AbortController();
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}

async function ghRequestJson<T>(url: string, githubToken: string, token?: vscode.CancellationToken): Promise<T> {
	const response = await fetch(url, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${githubToken}`,
			'Accept': 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
		},
		signal: getAbortSignal(token),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}${body ? `\n${body}` : ''}`);
	}

	return response.json() as Promise<T>;
}

export async function fetchOpenIssuesForRepo(repo: string, githubToken: string, token?: vscode.CancellationToken): Promise<GitHubIssue[]> {
	const issues: GitHubIssue[] = [];
	const perPage = 100;
	let page = 1;

	while (true) {
		const url = `https://api.github.com/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=${perPage}&page=${page}`;
		const batch = await ghRequestJson<any[]>(url, githubToken, token);
		if (batch.length === 0) {
			break;
		}

		for (const item of batch) {
			// /issues endpoint returns PRs too. Filter those out.
			if (item && typeof item === 'object' && item.pull_request) {
				continue;
			}
			issues.push({
				repo,
				number: item.number,
				title: item.title ?? '',
				body: item.body ?? '',
				url: item.html_url ?? '',
				updatedAt: item.updated_at ?? '',
				commentsUrl: item.comments_url ?? '',
			});
		}

		page += 1;
		await sleep(100);
	}

	return issues;
}

export async function fetchAllIssueCommentsText(commentsUrl: string, githubToken: string, token?: vscode.CancellationToken): Promise<string> {
	if (!commentsUrl) {
		return '';
	}
	const perPage = 100;
	let page = 1;
	let text = '';

	while (true) {
		const url = `${commentsUrl}?per_page=${perPage}&page=${page}`;
		const batch = await ghRequestJson<any[]>(url, githubToken, token);
		if (batch.length === 0) {
			break;
		}
		for (const comment of batch) {
			const body = comment?.body ?? '';
			if (body) {
				text += `\n\nComment: ${body}`;
			}
		}
		page += 1;
		await sleep(100);
	}

	return text;
}
