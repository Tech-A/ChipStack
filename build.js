// Builds two single-file outputs from src/:
//   dist/artifact.html — page fragment for publishing as a claude.ai artifact
//   docs/index.html    — full standalone page for GitHub Pages (uses PeerJS for multiplayer)
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');

const shell = read('shell.html');
const scripts = ['engine.js', 'transport.js', 'app.js'].map((f) => `<script>\n${read(f)}\n</script>`).join('\n');
const fragment = `${shell}\n${scripts}\n`;

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'docs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'artifact.html'), fragment);

const reset = 'html{-webkit-text-size-adjust:100%}:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}';
const standalone = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0d3a31">
<meta name="apple-mobile-web-app-capable" content="yes">
<style>${reset}</style>
</head>
<body>
${fragment}
</body>
</html>
`;
fs.writeFileSync(path.join(__dirname, 'docs', 'index.html'), standalone);
console.log('Built dist/artifact.html (%d KB) and docs/index.html', Math.round(fragment.length / 1024));
