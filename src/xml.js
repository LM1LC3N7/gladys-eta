// -----------------------------------------------------------------------------
// A small XML reader for the ETAtouch answers (pure, no dependency): elements,
// attributes, text, the five predefined entities and character references.
// Linear (each character is looked at a bounded number of times), bounded in
// elements and depth, no DOCTYPE (no entity of the document's own, no
// expansion), no prototype: attributes live in objects without one.
// -----------------------------------------------------------------------------

export class XmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlError';
  }
}

const NAME = /[A-Za-z_][-A-Za-z0-9_.:]*/y;
const SPACE = /[ \t\r\n]*/y;
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** The local part of a name ("eta:value" -> "value"). */
const local = (name) => name.slice(name.lastIndexOf(':') + 1);

/** Entities and character references of a text or an attribute value. */
export function decodeEntities(text) {
  if (!text.includes('&')) {
    return text;
  }
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    return Object.hasOwn(ENTITIES, ref) ? ENTITIES[ref] : whole;
  });
}

function element(name) {
  return { name: local(name), attrs: Object.create(null), children: [], text: '' };
}

/**
 * Parses `text`; returns the root element `{ name, attrs, children, text }`
 * (names without their prefix). Throws an XmlError on anything malformed or
 * over the limits.
 */
export function parseXml(text, { maxNodes = 20_000, maxDepth = 32 } = {}) {
  if (typeof text !== 'string') {
    throw new XmlError('not a text');
  }
  const stack = [];
  let root;
  let nodes = 0;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const chunk = lt === -1 ? text.slice(i) : text.slice(i, lt);
    if (chunk.length > 0) {
      if (stack.length > 0) {
        stack.at(-1).text += decodeEntities(chunk);
      } else if (chunk.trim() !== '') {
        throw new XmlError('text outside the root');
      }
    }
    if (lt === -1) {
      break;
    }
    i = lt;
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) throw new XmlError('unclosed declaration');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) throw new XmlError('unclosed comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end === -1 || stack.length === 0) throw new XmlError('bad CDATA');
      stack.at(-1).text += text.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', i)) {
      throw new XmlError('DOCTYPE refused');
    }
    if (text.startsWith('</', i)) {
      NAME.lastIndex = i + 2;
      const match = NAME.exec(text);
      if (!match) throw new XmlError('bad closing tag');
      SPACE.lastIndex = NAME.lastIndex;
      SPACE.exec(text);
      if (text[SPACE.lastIndex] !== '>') throw new XmlError('bad closing tag');
      const open = stack.pop();
      if (!open || open.name !== local(match[0])) throw new XmlError('mismatched tag');
      i = SPACE.lastIndex + 1;
      continue;
    }
    // An opening tag.
    NAME.lastIndex = i + 1;
    const match = NAME.exec(text);
    if (!match) throw new XmlError('bad tag');
    nodes += 1;
    if (nodes > maxNodes) throw new XmlError('too many elements');
    const node = element(match[0]);
    let j = NAME.lastIndex;
    let selfClosing = false;
    for (;;) {
      SPACE.lastIndex = j;
      SPACE.exec(text);
      const spaced = SPACE.lastIndex > j;
      j = SPACE.lastIndex;
      if (text.startsWith('/>', j)) {
        j += 2;
        selfClosing = true;
        break;
      }
      if (text[j] === '>') {
        j += 1;
        stack.push(node);
        if (stack.length > maxDepth) throw new XmlError('too deep');
        break;
      }
      if (!spaced) throw new XmlError('bad attribute');
      NAME.lastIndex = j;
      const attr = NAME.exec(text);
      if (!attr) throw new XmlError('bad attribute');
      j = NAME.lastIndex;
      SPACE.lastIndex = j;
      SPACE.exec(text);
      j = SPACE.lastIndex;
      if (text[j] !== '=') throw new XmlError('bad attribute');
      SPACE.lastIndex = j + 1;
      SPACE.exec(text);
      j = SPACE.lastIndex;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") throw new XmlError('bad attribute');
      const end = text.indexOf(quote, j + 1);
      if (end === -1) throw new XmlError('unclosed attribute');
      const value = text.slice(j + 1, end);
      if (value.includes('<')) throw new XmlError('bad attribute');
      const key = local(attr[0]);
      if (attr[0] !== 'xmlns' && !attr[0].startsWith('xmlns:')) {
        node.attrs[key] = decodeEntities(value);
      } else if (attr[0] === 'xmlns') {
        node.namespace = value;
      }
      j = end + 1;
    }
    const parent = stack.at(selfClosing ? -1 : -2);
    if (parent) {
      parent.children.push(node);
    } else if (root) {
      throw new XmlError('two roots');
    } else {
      root = node;
    }
    i = j;
  }
  if (!root || stack.length > 0) {
    throw new XmlError('incomplete document');
  }
  return root;
}

/** The children of `node` named `name`. */
export const childrenOf = (node, name) => (node?.children ?? []).filter((c) => c.name === name);

/** The first child of `node` named `name`, or undefined. */
export const childOf = (node, name) => (node?.children ?? []).find((c) => c.name === name);

/** An attribute of `node` (own property only), or undefined. */
export const attr = (node, name) =>
  node && Object.hasOwn(node.attrs, name) ? node.attrs[name] : undefined;
