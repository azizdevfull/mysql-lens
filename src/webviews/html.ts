import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/** Builds a webview page that loads one bundle from dist/webview. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, bundle: string, title: string): string {
  const base = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(base, f)).toString();
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${uri('codicon.css')}">
<link rel="stylesheet" href="${uri('base.css')}">
<link rel="stylesheet" href="${uri(bundle + '.css')}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri(bundle + '.js')}"></script>
</body>
</html>`;
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
