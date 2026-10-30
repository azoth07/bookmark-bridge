const MAX_DEPTH = 64;
const MAX_NODES = 100_000;

export { MAX_DEPTH, MAX_NODES };

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasOnlyKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function validateTree(tree) {
  if (!isRecord(tree) || !hasOnlyKeys(tree, ['children']) || !Array.isArray(tree.children)) {
    throw new TypeError('书签树必须只包含 children 数组。');
  }
  let count = 0;
  const stack = [{ children: tree.children, depth: 1 }];
  while (stack.length) {
    const { children, depth } = stack.pop();
    for (const node of children) {
      if (++count > MAX_NODES) throw new RangeError(`书签树最多允许 ${MAX_NODES} 个节点。`);
      if (depth > MAX_DEPTH) throw new RangeError(`书签树最多允许 ${MAX_DEPTH} 层节点。`);
      if (!isRecord(node) || typeof node.title !== 'string') {
        throw new TypeError('每个书签或文件夹必须具有字符串 title。');
      }
      if (hasOnlyKeys(node, ['title', 'url']) && typeof node.url === 'string' && node.url.length > 0) {
        continue;
      }
      if (hasOnlyKeys(node, ['title', 'children']) && Array.isArray(node.children)) {
        stack.push({ children: node.children, depth: depth + 1 });
        continue;
      }
      throw new TypeError('节点必须是 {title,url} 书签或 {title,children} 文件夹，且网址不能为空。');
    }
  }
  return count;
}

// Inputs must already pass validateTree. Preserve the left tree's order and titles.
// Maps keep titles and URLs such as "__proto__" safe and distinct from object keys.
export function mergeTrees(left, right) {
  let changed = false;
  function mergeChildren(leftChildren, rightChildren) {
    const children = [];
    const folders = new Map();
    const urls = new Map();
    function add(nodes, fromRight) {
      for (const node of nodes) {
        if (Object.hasOwn(node, 'url')) {
          if (urls.has(node.url)) continue;
          const copy = { title: node.title, url: node.url };
          urls.set(node.url, copy);
          children.push(copy);
          if (fromRight) changed = true;
        } else {
          const previous = folders.get(node.title);
          if (previous) {
            previous.children = mergeChildren(previous.children, node.children);
          } else {
            const copy = { title: node.title, children: mergeChildren(node.children, []) };
            folders.set(node.title, copy);
            children.push(copy);
            if (fromRight) changed = true;
          }
        }
      }
    }
    add(leftChildren, false);
    add(rightChildren, true);
    return children;
  }
  return { tree: { children: mergeChildren(left.children, right.children) }, changed };
}
