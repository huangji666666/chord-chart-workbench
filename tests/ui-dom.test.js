/**
 * `ui/dom.js` 里几个「防呆」契约的回归测试。
 *
 * 为什么单独立一个文件：这类 bug 的特点是**不报错、不抛异常**，
 * 只是页面上多了点东西。阶段三的浏览器验证里就漏掉过一次——
 * `paperEl.replaceChildren(chart, exitHint)` 在编辑模式下 `exitHint` 是 `null`，
 * 原生的 `replaceChildren` 把 `null` 字符串化成了一个字面的「null」文本节点。
 * 单元测试和 DOM 断言都没抓到（那个文本节点是 `.paper` 的兄弟节点，
 * 查子树查不到），最后是截图里看见的。
 *
 * 所以这里把契约钉死：空值必须被丢掉，而不是变成字符串。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { replaceChildren, input, el } from '../src/ui/dom.js';
import { JSDOM } from 'jsdom';

/**
 * 一个假的父节点。
 *
 * 真 `replaceChildren` 会把非 Node 参数字符串化成文本节点，
 * 这正是要防的行为；这里如实照做，好让测试能验出「有没有被过滤掉」。
 * 直接用真 DOM 需要 jsdom，不值得为这一条引入依赖。
 */
function fakeParent() {
  return {
    received: null,
    replaceChildren(...nodes) {
      this.received = nodes.map((node) => {
        if (typeof node === 'string') return `text:${node}`;
        return node === null ? 'text:null' : node;
      });
    },
  };
}

test('replaceChildren：null / undefined / false 必须被丢掉，不能变成字符串', () => {
  const parent = fakeParent();
  replaceChildren(parent, 'a', null, undefined, false, 'b');
  assert.deepEqual(parent.received, ['text:a', 'text:b']);
});

test('replaceChildren：全是空值时等于清空，不会留下 "null" 文本节点', () => {
  const parent = fakeParent();
  replaceChildren(parent, null, undefined);
  assert.deepEqual(parent.received, []);
});

test('replaceChildren：正常节点原样传入，顺序不变', () => {
  const parent = fakeParent();
  const one = { tag: 'one' };
  const two = { tag: 'two' };
  replaceChildren(parent, one, null, two);
  assert.deepEqual(parent.received, [one, two]);
});

test('replaceChildren：返回父节点，便于串起来写', () => {
  const parent = fakeParent();
  assert.equal(replaceChildren(parent, null), parent);
});

test('范围和步长初始化不会把字号与音量的真实值变成最小值',()=>{
  const previous=globalThis.document;
  globalThis.document=new JSDOM('').window.document;
  try{
    assert.equal(input({type:'range',value:1,min:.8,max:1.6,step:.05}).value,'1');
    assert.equal(input({type:'range',value:1.6,min:.6,max:2,step:.05}).value,'1.6');
    assert.equal(el('input',{type:'range',value:.32,min:0,max:.7,step:.02}).value,'0.32');
  }finally{globalThis.document=previous;}
});
