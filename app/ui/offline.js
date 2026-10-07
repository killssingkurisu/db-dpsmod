'use strict';
const q = new URLSearchParams(location.search);
document.getElementById('url').textContent = q.get('url') || '';
document.getElementById('error').textContent = q.get('error') || 'unknown';
document.getElementById('retry').addEventListener('click', () => window.dbLauncher.cmd('retry'));
document.getElementById('logs').addEventListener('click', () => window.dbLauncher.cmd('openLogs'));
document.getElementById('retry').focus();
