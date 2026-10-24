import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { getStatus, startExperiment, adminUrl, repositoryRoot } from './experiment-manager.mjs';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('请安装 Node.js 24 或更高版本。');
try { await access(join(repositoryRoot, 'node_modules/qrcode-generator/package.json')); }
catch { throw new Error('尚未安装依赖，请在实验文件夹运行 npm ci 后重新启动。'); }
const name = 'a1-notification-pilot';
const existing = await getStatus(name);
if (existing.status !== 'unmanaged') await startExperiment(name);
const url = await adminUrl(name);
console.log(`实验后台：${url}\n退出请点击网页右上角“退出并关闭系统”。\n此终端窗口可以关闭。`);
if (!process.argv.includes('--no-open')) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`请手动打开 ${url}`)));
  });
}
