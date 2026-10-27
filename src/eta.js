// -----------------------------------------------------------------------------
// The answers of the ETAtouch webservices (pure): the API version, the menu,
// a variable's value and its description (varinfo), the active errors.
// Formats from the manufacturer's document "ETAtouch RESTful Webservices"
// 1.2; the handling of invalid values ("xxx", "---", empty) and of the units
// from Tidone/homeassistant_eta_integration 1.4.2 (MIT, see
// THIRD_PARTY_NOTICES.md).
//
// Every answer is untrusted: bounded XML (src/xml.js), own attributes only,
// strict numbers, texts cleaned of control and invisible characters and cut.
// -----------------------------------------------------------------------------

import { INTERFACE, LIMITS } from './constants.js';
import { attr, childOf, childrenOf, parseXml, XmlError } from './xml.js';

export class AnswerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnswerError';
  }
}

/** A variable address: `/<node>/<fub>/<fkt>/<io>/<var>` (leading slash optional). */
const ADDRESS = /^\/?([0-9]{1,5})\/([0-9]{1,6})\/([0-9]{1,6})\/([0-9]{1,6})\/([0-9]{1,6})$/;
/** A functional block: `/<node>/<fub>`. */
const BLOCK = /^\/?([0-9]{1,5})\/([0-9]{1,6})$/;

/** `{ node, fub, fkt, io, id, uri }` of an address, or undefined. */
export function parseAddress(text) {
  const match = ADDRESS.exec(String(text ?? ''));
  if (!match) {
    return undefined;
  }
  const [node, fub, fkt, io, id] = match.slice(1).map(Number);
  return { node, fub, fkt, io, id, uri: `/${node}/${fub}/${fkt}/${io}/${id}` };
}

/** `{ node, fub }` of a block uri, or undefined. */
export function parseBlock(text) {
  const match = BLOCK.exec(String(text ?? ''));
  return match ? { node: Number(match[1]), fub: Number(match[2]) } : undefined;
}

// Control, format and invisible characters (bidi marks, zero-width, BOM).
const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** A text of the device, cleaned and cut; undefined when empty. */
export function cleanText(value, max = LIMITS.textLength) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (text === '') {
    return undefined;
  }
  return [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;
}

/** The root of an answer: an `<eta>` element, else an AnswerError. */
export function parseAnswer(body) {
  let root;
  try {
    root = parseXml(Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? ''), {
      maxNodes: LIMITS.xmlNodes,
      maxDepth: LIMITS.xmlDepth,
    });
  } catch (err) {
    throw new AnswerError(err instanceof XmlError ? `bad XML: ${err.message}` : 'bad XML');
  }
  if (root.name !== 'eta' || (root.namespace && root.namespace !== INTERFACE.namespace)) {
    throw new AnswerError('not an ETAtouch answer');
  }
  return root;
}

/** The error an ETAtouch may answer instead of the resource (`<eta><error>…`). */
export function answerError(root) {
  const error = childOf(root, 'error');
  return error ? (cleanText(error.text) ?? 'error') : undefined;
}

/** `/user/api`: `[major, minor]`, or undefined. */
export function parseApiVersion(root) {
  const version = attr(childOf(root, 'api'), 'version');
  const match = /^([0-9]{1,3})\.([0-9]{1,3})(?:\.[0-9]{1,5})?$/.exec(String(version ?? '').trim());
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** True when `version` ([major, minor]) is at least `wanted`. */
export const atLeast = (version, wanted) =>
  Array.isArray(version) &&
  (version[0] > wanted[0] || (version[0] === wanted[0] && version[1] >= wanted[1]));

/**
 * `/user/menu`: `{ blocks, objects }`. `blocks`: `[{ node, fub, name }]`;
 * `objects`: `[{ ...address, name, path }]` in the order of the menu, each
 * uri once (the menu may list a variable twice), at most `max`. `path` is
 * the names from the block down, as the display shows them.
 */
export function parseMenu(root, { max = LIMITS.menuObjects } = {}) {
  const menu = childOf(root, 'menu');
  if (!menu) {
    throw new AnswerError('no menu');
  }
  const blocks = [];
  const objects = [];
  const seen = new Set();
  let truncated = false;
  for (const fub of childrenOf(menu, 'fub')) {
    const block = parseBlock(attr(fub, 'uri'));
    if (!block || blocks.length >= LIMITS.blocks) {
      continue;
    }
    const name = cleanText(attr(fub, 'name'), LIMITS.nameLength);
    blocks.push({ ...block, name });
    // Depth first, without recursion: the XML depth is bounded anyway.
    const todo = childrenOf(fub, 'object')
      .reverse()
      .map((node) => ({ node, path: [] }));
    while (todo.length > 0) {
      const { node, path } = todo.pop();
      const address = parseAddress(attr(node, 'uri'));
      const label = cleanText(attr(node, 'name'), LIMITS.nameLength) ?? '?';
      const here = [...path, label].slice(-6);
      if (address && address.node === block.node && address.fub === block.fub) {
        if (!seen.has(address.uri)) {
          if (objects.length >= max) {
            truncated = true;
            break;
          }
          seen.add(address.uri);
          objects.push({ ...address, name: label, path: here });
        }
      }
      for (const child of childrenOf(node, 'object').reverse()) {
        todo.push({ node: child, path: here });
      }
    }
    if (truncated) {
      break;
    }
  }
  return { blocks, objects, truncated };
}

const INTEGER = /^-?[0-9]{1,12}$/;
const NUMBER = /^-?(?:[0-9]{1,15}(?:\.[0-9]{1,15})?|\.[0-9]{1,15})(?:[eE][-+]?[0-9]{1,3})?$/;

/** A strict integer attribute within [min, max], else undefined. */
function integer(value, min, max) {
  const text = String(value ?? '').trim();
  if (!INTEGER.test(text)) {
    return undefined;
  }
  const number = Number(text);
  return number >= min && number <= max ? number : undefined;
}

/** strValue marking a value the boiler does not have now. */
export const INVALID_TEXTS = new Set(['', 'xxx', '---', '--', '-']);

/**
 * `/user/var/...`: `{ uri, text, unit, raw, scale, decimals, textOffset }`;
 * `raw` is the number of the element (undefined when it is none), `text` the
 * strValue cleaned (undefined when invalid).
 */
export function parseValue(root) {
  const node = childOf(root, 'value');
  if (!node) {
    throw new AnswerError(answerError(root) ? 'error answer' : 'no value');
  }
  const rawText = node.text.trim();
  const raw = NUMBER.test(rawText) ? Number(rawText) : undefined;
  const str = attr(node, 'strValue');
  return {
    uri: parseAddress(String(attr(node, 'uri') ?? '').replace(/^\/user\/var/, ''))?.uri,
    text: INVALID_TEXTS.has(String(str ?? '').trim()) ? undefined : cleanText(str),
    unit: cleanText(attr(node, 'unit'), 16) ?? '',
    raw: Number.isFinite(raw) ? raw : undefined,
    scale: integer(attr(node, 'scaleFactor'), 1, 1_000_000),
    decimals: integer(attr(node, 'decPlaces'), 0, 10),
    textOffset: integer(attr(node, 'advTextOffset'), 0, 1_000_000_000),
  };
}

/**
 * `/user/varinfo/...` (API 1.2): `{ name, fullName, unit, type, writable }`.
 * `type`: DEFAULT, TEXT, TIMESLOT, IEEE-754… as the device says it.
 */
export function parseVarInfo(root) {
  const variable = childOf(childOf(root, 'varInfo'), 'variable');
  if (!variable) {
    throw new AnswerError(answerError(root) ? 'error answer' : 'no varinfo');
  }
  const type = cleanText(childOf(variable, 'type')?.text, 16) ?? '';
  return {
    name: cleanText(attr(variable, 'name'), LIMITS.nameLength),
    fullName: cleanText(attr(variable, 'fullName'), LIMITS.nameLength * 2),
    unit: cleanText(attr(variable, 'unit'), 16) ?? '',
    type: /^[A-Z0-9-]{1,16}$/.test(type) ? type : '',
    writable: attr(variable, 'isWritable') === '1',
  };
}

/** The value of a variable as a number: raw / scaleFactor; undefined when invalid. */
export function numberOf(value) {
  if (!value || value.text === undefined || value.raw === undefined || value.scale === undefined) {
    return undefined;
  }
  const number = value.raw / value.scale;
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : undefined;
}

/**
 * `/user/errors`: the active errors, `[{ block, blockName, msg, priority,
 * time, text }]`, at most LIMITS.errors.
 */
export function parseErrors(root) {
  const errors = childOf(root, 'errors');
  if (!errors) {
    throw new AnswerError('no error list');
  }
  const list = [];
  for (const fub of childrenOf(errors, 'fub')) {
    const block = parseBlock(attr(fub, 'uri'));
    const blockName = cleanText(attr(fub, 'name'), LIMITS.nameLength);
    for (const error of childrenOf(fub, 'error')) {
      if (list.length >= LIMITS.errors) {
        return list;
      }
      const time = String(attr(error, 'time') ?? '').trim();
      list.push({
        block: block ? `${block.node}-${block.fub}` : '',
        blockName,
        msg: cleanText(attr(error, 'msg')) ?? '?',
        priority: cleanText(attr(error, 'priority'), 32) ?? '',
        time: /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(time) ? time : '',
        text: cleanText(error.text) ?? '',
      });
    }
  }
  return list;
}

/** The key of an error, the same from one read to the next. */
export const errorKey = (error) => `${error.block}|${error.time}|${error.msg}`.slice(0, 400);
