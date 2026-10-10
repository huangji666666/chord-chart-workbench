/**
 * 应用入口。
 *
 * 这一层只做三件事：拿到挂载节点、启动应用、在启动失败时给出一句人话。
 * 真正的装配在 `src/ui/app.js` —— 页面上的每一个和弦都来自内存里那一份
 * `Song` 对象，不存在第二份影子数据（docs/SPEC.md §2.3）。
 *
 * @module main
 */

import './styles.css';
import './single-workbench.css';

import { createApp } from './ui/studio-app.js';

const root = document.getElementById('app');
if (!root) {
  throw new Error('index.html 缺少 #app 挂载节点');
}

try {
  createApp({ root });
} catch (error) {
  // 启动就炸的话，页面会是一片空白，用户只看到「什么都没发生」。
  // 这里至少把原因写出来——用 textContent，不拼接 HTML。
  const box = document.createElement('div');
  box.className = 'banner banner--danger';
  const title = document.createElement('p');
  title.className = 'banner__title';
  title.textContent = '应用启动失败';
  const detail = document.createElement('pre');
  detail.className = 'code';
  detail.textContent = String(error?.stack ?? error);
  box.append(title, detail);
  root.replaceChildren(box);
  throw error;
}
