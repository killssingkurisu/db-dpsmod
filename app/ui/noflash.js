'use strict';
const message = document.getElementById('message');
window.dbLauncher.state().then((s) => {
    const list = document.getElementById('list');
    for (const r of (s && s.flashRejected) || []) {
        const li = document.createElement('li');
        const p = document.createElement('span');
        p.className = 'path';
        p.textContent = r.path;
        li.append(p, ' ' + r.problem);
        list.append(li);
    }
    document.getElementById('skipped').hidden = !list.children.length;
});
document.getElementById('choose').addEventListener('click', async () => {
    message.hidden = true;
    const r = await window.dbLauncher.cmd('chooseFlash');
    if (r && r.error) {
        message.textContent = r.error;
        message.hidden = false;
    }
});
document.getElementById('releases').addEventListener('click', () => window.dbLauncher.cmd('openProject'));
document.getElementById('logs').addEventListener('click', () => window.dbLauncher.cmd('openLogs'));
document.getElementById('choose').focus();
