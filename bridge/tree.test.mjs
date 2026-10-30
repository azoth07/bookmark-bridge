import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DEPTH, MAX_NODES, mergeTrees, validateTree } from './tree.mjs';

const bookmark = (title, url) => ({ title, url });
const folder = (title, children = []) => ({ title, children });
const tree = (...children) => ({ children });

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function nested(depth) {
  let node = bookmark('书签', 'javascript:alert(1)');
  for (let level = 1; level < depth; level++) node = folder(`目录 ${level}`, [node]);
  return tree(node);
}

test('递归并集保留顺序与首个标题，同一网址仅在相同目录去重', () => {
  const left = freeze(tree(
    bookmark('最初标题', 'https://a/'),
    folder('工作', [bookmark('一', 'https://one/'), folder('子目录', [bookmark('原有', 'https://old/')])]),
    bookmark('大小写', 'https://A/'),
  ));
  const right = freeze(tree(
    bookmark('改名不会覆盖', 'https://a/'),
    folder('工作', [bookmark('重复', 'https://one/'), bookmark('新增', 'https://new/'),
      folder('子目录', [bookmark('另一个', 'https://another/')])]),
    folder('个人', [bookmark('不同目录保留', 'https://a/')]),
    bookmark('末尾', 'https://tail/'),
  ));
  const merged = mergeTrees(left, right);
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.tree, tree(
    bookmark('最初标题', 'https://a/'),
    folder('工作', [bookmark('一', 'https://one/'),
      folder('子目录', [bookmark('原有', 'https://old/'), bookmark('另一个', 'https://another/')]),
      bookmark('新增', 'https://new/')]),
    bookmark('大小写', 'https://A/'),
    folder('个人', [bookmark('不同目录保留', 'https://a/')]),
    bookmark('末尾', 'https://tail/'),
  ));
  assert.equal(mergeTrees(merged.tree, right).changed, false);
  assert.deepEqual(mergeTrees(merged.tree, tree()).tree, merged.tree);
});

test('输入内部重复目录递归合并，空目录和特殊 Map 键均保留', () => {
  const input = JSON.parse('{"children":[{"title":"__proto__","children":[{"title":"first","url":"constructor"}]},{"title":"__proto__","children":[{"title":"second","url":"constructor"},{"title":"new","url":"__proto__"}]},{"title":"constructor","children":[]},{"title":"__proto__","url":"https://same-title/"}]}');
  validateTree(input);
  const result = mergeTrees(tree(), input);
  assert.deepEqual(result.tree, tree(
    folder('__proto__', [bookmark('first', 'constructor'), bookmark('new', '__proto__')]),
    folder('constructor'), bookmark('__proto__', 'https://same-title/'),
  ));
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(mergeTrees(result.tree, input).changed, false);
});

test('只按完整网址及精确目录名匹配，允许浏览器内部页面与 bookmarklet', () => {
  const input = tree(folder('A'), folder('a'), bookmark('', 'javascript:alert(1)'),
    bookmark('设置', 'chrome://settings/'), bookmark('设置', 'edge://settings/'),
    bookmark('斜杠', 'https://example.com/'), bookmark('无斜杠', 'https://example.com'));
  assert.equal(validateTree(input), 7);
  assert.deepEqual(mergeTrees(tree(), input).tree, input);
});

test('严格拒绝错误结构、额外属性、空网址及歧义节点', () => {
  for (const invalid of [null, [], {}, { children: {}, extra: 1 },
    { children: [], extra: true }, tree(null), tree([]), tree({ title: 1, url: 'x' }),
    tree({ title: 'x', url: '' }), tree({ title: 'x', children: null }),
    tree({ title: 'x', children: [], url: 'x' }), tree({ title: 'x', url: 'x', id: '1' }),
    tree(new Date()), JSON.parse('{"children":[],"__proto__":{"polluted":true}}')]) {
    assert.throws(() => validateTree(invalid));
  }
});

test('节点与深度限制在边界处准确生效', () => {
  assert.equal(validateTree(nested(MAX_DEPTH)), MAX_DEPTH);
  assert.throws(() => validateTree(nested(MAX_DEPTH + 1)), RangeError);
  const nodes = Array.from({ length: MAX_NODES }, () => bookmark('重复也计数', 'https://a/'));
  assert.equal(validateTree({ children: nodes }), MAX_NODES);
  nodes.push(bookmark('超限', 'https://extra/'));
  assert.throws(() => validateTree({ children: nodes }), RangeError);
});
