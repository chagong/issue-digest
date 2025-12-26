//@ts-check

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.
(function () {
	const vscode = acquireVsCodeApi();

	const startBtn = /** @type {HTMLButtonElement} */ (document.getElementById('start'));
	const reposEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('repos'));
	const bar = /** @type {HTMLProgressElement} */ (document.getElementById('bar'));
	const logEl = /** @type {HTMLElement} */ (document.getElementById('log'));

	// Restore state
	const oldState = vscode.getState() || { repos: '' };
	if (oldState.repos) {
		reposEl.value = oldState.repos;
	}

	function setBadge(step, status) {
		const el = document.getElementById('badge-' + step);
		if (el) {el.textContent = status;}
	}

	function setMsg(step, msg) {
		const el = document.getElementById('msg-' + step);
		if (el) {el.textContent = msg || '';}
	}

	function log(line) {
		if (!line) {return;}
		logEl.textContent = (logEl.textContent ? (logEl.textContent + '\n') : '') + line;
		logEl.scrollTop = logEl.scrollHeight;
	}

	function setPercent(p) {
		bar.value = Math.max(0, Math.min(100, p || 0));
	}

	// Save state on input
	reposEl.addEventListener('input', () => {
		vscode.setState({ repos: reposEl.value });
	});

	startBtn.addEventListener('click', () => {
		startBtn.disabled = true;
		logEl.textContent = '';
		setBadge('fetch', 'in-progress');
		setBadge('summarize', 'not started');
		setBadge('report', 'not started');
		setMsg('fetch', '');
		setMsg('summarize', '');
		setMsg('report', '');
		setPercent(0);
		try {
			vscode.postMessage({ type: 'start', reposText: reposEl.value || '' });
			log('Start requested.');
		} catch (e) {
			log('Failed to post message to extension: ' + (e && e.message ? e.message : String(e)));
			startBtn.disabled = false;
		}
	});

	// Handle messages sent from the extension to the webview
	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (!msg || !msg.type) {return;}

		if (msg.type === 'progress') {
			setBadge(msg.step, msg.status);
			setMsg(msg.step, msg.message || '');
			if (typeof msg.percent === 'number') {
				setPercent(msg.percent);
			}
			if (msg.message) {
				log('[' + msg.step + '] ' + msg.message);
			}
			if (msg.status === 'error') {
				startBtn.disabled = false;
			}
		}

		if (msg.type === 'result') {
			log(msg.message);
			startBtn.disabled = false;
		}
	});

	// Signal ready
	try {
		vscode.postMessage({ type: 'ready' });
		log('UI loaded.');
	} catch (e) {
		log('Failed to initialize messaging: ' + (e && e.message ? e.message : String(e)));
	}
}());
