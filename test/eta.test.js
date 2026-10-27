// -----------------------------------------------------------------------------
// The answers of the ETAtouch (pure): XML reader, menu, values, varinfo,
// errors, and their mapping to Gladys kinds and states.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  buildDevices,
  classify,
  errorStates,
  kindOfFeature,
  parseFeatureId,
  stateOf,
  variablesToRead,
} from '../src/devices.js';
import {
  INVALID_TEXTS,
  cleanText,
  errorKey,
  numberOf,
  parseAnswer,
  parseApiVersion,
  parseErrors,
  parseMenu,
  parseValue,
  parseVarInfo,
} from '../src/eta.js';
import { XmlError, parseXml } from '../src/xml.js';
import { PEK, errorsXml, value, xml } from './helpers/eta.js';

test('XML: elements, attributes, entities, CDATA, comments, prefixes', () => {
  const root = parseXml(
    '<?xml version="1.0"?><!-- c --><a:eta xmlns="x" k=\'v &amp; &lt;w&gt; &#233;&#x41;\'><b>t&quot;</b><![CDATA[<raw>]]><c/></a:eta>',
  );
  assert.equal(root.name, 'eta');
  assert.equal(root.namespace, 'x');
  assert.equal(root.attrs.k, 'v & <w> éA');
  assert.equal(root.children[0].text, 't"');
  assert.equal(root.text, '<raw>');
  assert.equal(root.children[1].name, 'c');
});

test('XML: DOCTYPE, malformed documents and limits are refused', () => {
  const bad = [
    '<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>',
    '<!DOCTYPE eta><eta/>',
    '<a><b></a></b>',
    '<a>',
    '<a></a><b></b>',
    '<a b="1"c="2"/>',
    '<a b=1/>',
    'text<a/>',
    '<a b="<"/>',
    '',
  ];
  for (const text of bad) {
    assert.throws(() => parseXml(text), XmlError, text);
  }
  assert.throws(() => parseXml('<a>'.repeat(40) + '</a>'.repeat(40), { maxDepth: 32 }), /too deep/);
  assert.throws(() => parseXml(`<a>${'<b/>'.repeat(30)}</a>`, { maxNodes: 20 }), /too many/);
});

test('XML: no prototype pollution, unknown entities kept', () => {
  const root = parseXml('<a __proto__="x" constructor="y" t="&foo;"/>');
  assert.equal(Object.getPrototypeOf(root.attrs), null);
  assert.equal(root.attrs.__proto__, 'x');
  assert.equal({}.polluted, undefined);
  assert.equal(root.attrs.t, '&foo;');
});

test('XML: linear on a long hostile input', () => {
  const start = performance.now();
  assert.throws(() => parseXml(`<a b="${'&'.repeat(500_000)}`));
  parseXml(`<a>${'&amp;'.repeat(200_000)}</a>`);
  parseXml(`<a>${'<b x="1" y="2"/>'.repeat(19_000)}</a>`);
  assert.ok(performance.now() - start < 2000);
});

test('answers: the root must be an ETAtouch one', () => {
  assert.throws(() => parseAnswer('<html/>'), /not an ETAtouch/);
  assert.throws(() => parseAnswer('<eta xmlns="http://other"/>'), /not an ETAtouch/);
  assert.throws(() => parseAnswer('{"a":1}'), /bad XML/);
  assert.equal(parseAnswer(Buffer.from(xml('<api version="1.2"/>'))).name, 'eta');
});

test('API version', () => {
  assert.deepEqual(parseApiVersion(parseAnswer(PEK['/user/api'])), [1, 2]);
  assert.deepEqual(parseApiVersion(parseAnswer(xml('<api version="1.1" />'))), [1, 1]);
  assert.equal(parseApiVersion(parseAnswer(xml('<api version="x" />'))), undefined);
});

test('menu: blocks, each uri once, path names, bounded', () => {
  const menu = parseMenu(parseAnswer(PEK['/user/menu']));
  assert.deepEqual(
    menu.blocks.map((b) => `${b.node}-${b.fub} ${b.name}`),
    [
      '120-10111 WW',
      '120-10101 HK',
      '120-10102 Fbh',
      '120-10241 Sys',
      '40-10021 Kessel',
      '40-10211 LagerUm.',
    ],
  );
  const uris = menu.objects.map((o) => o.uri);
  assert.equal(new Set(uris).size, uris.length);
  const boiler = menu.objects.find((o) => o.uri === '/40/10021/0/0/12001');
  assert.deepEqual(boiler.path, ['Kessel', 'Kessel', 'Kessel Soll']);
  const small = parseMenu(parseAnswer(PEK['/user/menu']), { max: 10 });
  assert.equal(small.objects.length, 10);
  assert.equal(small.truncated, true);
  // An object of another block, a malformed uri: ignored.
  const odd = parseMenu(
    parseAnswer(
      xml(
        '<menu><fub uri="/40/10021" name="K"><object uri="/41/10021/0/0/1" name="x"/><object uri="/40/10021/0/0/../1" name="y"/><object uri="/40/10021/0/0/2" name="ok"/></fub></menu>',
      ),
    ),
  );
  assert.deepEqual(
    odd.objects.map((o) => o.uri),
    ['/40/10021/0/0/2'],
  );
});

test('values: scale, invalid texts, strict numbers', () => {
  const v = parseValue(parseAnswer(PEK['/user/var/40/10021/0/0/12161']));
  assert.equal(v.uri, '/40/10021/0/0/12161');
  assert.equal(numberOf(v), 67.3);
  assert.equal(numberOf(parseValue(parseAnswer(PEK['/user/var/40/10021/0/0/12153']))), 24986500);
  for (const str of INVALID_TEXTS) {
    const parsed = parseValue(
      parseAnswer(value('/1/2/0/0/3', { str, raw: 0, unit: '°C', scale: 10 })),
    );
    assert.equal(numberOf(parsed), undefined, `"${str}"`);
  }
  for (const raw of ['', '0x10', '1e400', ' ', 'NaN', 'Infinity', '1,5']) {
    const parsed = parseValue(parseAnswer(value('/1/2/0/0/3', { str: '1', raw, unit: '°C' })));
    assert.equal(numberOf(parsed), undefined, `raw "${raw}"`);
  }
  for (const scale of ['0', '-10', '1.5', '']) {
    const parsed = parseValue(
      parseAnswer(value('/1/2/0/0/3', { str: '1', raw: 10, unit: '°C', scale })),
    );
    assert.equal(numberOf(parsed), undefined, `scale "${scale}"`);
  }
  assert.throws(() => parseValue(parseAnswer(xml('<error>no</error>'))), /error answer/);
});

test('varinfo', () => {
  const info = parseVarInfo(parseAnswer(PEK['/user/varinfo/40/10021/0/0/12001']));
  assert.equal(info.fullName, 'Kessel > Kessel > Kessel Soll');
  assert.equal(info.unit, '°C');
  assert.equal(info.type, 'DEFAULT');
  assert.equal(info.writable, false);
  const slot = parseVarInfo(parseAnswer(PEK['/user/varinfo/120/10111/12130/0/1082']));
  assert.equal(slot.type, 'TIMESLOT');
});

test('errors: the document example, bounded, keys stable', () => {
  const errors = parseErrors(
    parseAnswer(
      errorsXml([
        {
          msg: 'Flue gas sensor Interrupted',
          time: '2011-06-29 12:47:50',
          text: 'Sensor or Cable broken',
        },
        { msg: 'Water pressure too low 0,00 bar', time: '2011-06-29 12:48:12' },
      ]),
    ),
  );
  assert.equal(errors.length, 2);
  assert.deepEqual(errors[0], {
    block: '40-10021',
    blockName: 'Kessel',
    msg: 'Flue gas sensor Interrupted',
    priority: 'Error',
    time: '2011-06-29 12:47:50',
    text: 'Sensor or Cable broken',
  });
  assert.equal(errorKey(errors[0]), '40-10021|2011-06-29 12:47:50|Flue gas sensor Interrupted');
  const many = parseErrors(
    parseAnswer(errorsXml(Array.from({ length: 80 }, (_, i) => ({ msg: `e${i}` })))),
  );
  assert.equal(many.length, 50);
  assert.equal(parseErrors(parseAnswer(errorsXml([]))).length, 0);
});

test('texts: control and invisible characters removed, cut', () => {
  assert.equal(cleanText('a\u0000b\u202ec\u200b'), 'a b c');
  assert.equal(cleanText('   '), undefined);
  assert.equal([...cleanText('é'.repeat(300))].length, 160);
});

test('kinds: from the value and varinfo, as the reference', () => {
  const v = (uri) => parseValue(parseAnswer(PEK[`/user/var${uri}`]));
  const i = (uri) => parseVarInfo(parseAnswer(PEK[`/user/varinfo${uri}`]));
  assert.deepEqual(classify(v('/40/10021/0/0/12161'), i('/40/10021/0/0/12161')), {
    kind: 'temperature',
    unit: '°C',
  });
  assert.deepEqual(classify(v('/40/10021/0/0/12153'), i('/40/10021/0/0/12153')), {
    kind: 'hours',
    unit: 's',
  });
  assert.deepEqual(classify(v('/40/10021/0/0/12016'), i('/40/10021/0/0/12016')), {
    kind: 'number',
    unit: 'kg',
  });
  assert.deepEqual(classify(v('/40/10021/0/0/12017'), i('/40/10021/0/0/12017')), {
    kind: 'number',
    unit: '',
  });
  assert.deepEqual(classify(v('/40/10021/0/0/19402'), i('/40/10021/0/0/19402')), {
    kind: 'text',
    unit: '',
  });
  assert.deepEqual(classify(v('/40/10021/0/0/12180'), undefined), { kind: 'bar', unit: 'bar' });
  // A time of day ("21:00") and a time slot: no kind.
  assert.equal(classify(v('/40/10021/0/0/12248'), i('/40/10021/0/0/12248')), undefined);
  assert.equal(classify(v('/120/10111/12130/0/1082'), i('/120/10111/12130/0/1082')), undefined);
  // Reduced mode: a text from its offset.
  assert.deepEqual(classify(v('/40/10021/0/0/19402'), undefined), { kind: 'text', unit: '' });
});

test('states: units checked, ranges, hours', () => {
  const temp = (str, raw, unit = '°C') =>
    parseValue(parseAnswer(value('/1/2/0/0/3', { str, raw, unit, scale: 10 })));
  assert.deepEqual(stateOf('temperature', temp('67', 673)), { state: 67.3 });
  assert.equal(stateOf('temperature', temp('67', 673, '%')), undefined);
  assert.equal(stateOf('temperature', temp('xxx', 0)), undefined);
  assert.equal(stateOf('temperature', temp('2000', 20000)), undefined);
  assert.equal(stateOf('nope', temp('1', 10)), undefined);
  const hours = parseValue(parseAnswer(value('/1/2/0/0/3', { str: '1h', raw: 5400, unit: 's' })));
  assert.deepEqual(stateOf('hours', hours), { state: 1.5 });
  const text = parseValue(
    parseAnswer(value('/1/2/0/0/3', { str: 'Heizen', raw: 4002, offset: 4000 })),
  );
  assert.deepEqual(stateOf('text', text), { text: 'Heizen' });
});

test('feature ids and kinds of created features', () => {
  const gladys = createFakeGladys({ selector: 'eta' });
  const devices = buildDevices(
    gladys,
    {
      blocks: [{ node: 40, fub: 10021, name: 'Kessel' }],
      entries: [
        {
          uri: '/40/10021/0/0/12161',
          node: 40,
          fub: 10021,
          fkt: 0,
          io: 0,
          id: 12161,
          name: 'Kessel',
          kind: 'temperature',
          unit: '°C',
        },
        {
          uri: '/40/10021/0/0/12016',
          node: 40,
          fub: 10021,
          fkt: 0,
          io: 0,
          id: 12016,
          name: 'Total',
          kind: 'number',
          unit: 'kg',
        },
      ],
    },
    [],
    'fr',
  );
  assert.equal(devices.length, 2);
  const [boiler, errors] = devices;
  assert.equal(boiler.external_id, 'ext:eta:eta:40-10021');
  assert.equal(boiler.features[0].external_id, 'ext:eta:eta:40-10021:0-0-12161');
  assert.equal(boiler.features[1].name, 'Total (kg)');
  assert.deepEqual(parseFeatureId(boiler.features[0].external_id), {
    block: '40-10021',
    uri: '/40/10021/0/0/12161',
  });
  assert.equal(parseFeatureId('ext:eta:eta:40-10021:0-0-../1'), undefined);
  assert.equal(parseFeatureId('ext:eta:eta:errors:alarm').role, 'alarm');
  assert.equal(parseFeatureId('ext:eta:eta:errors:__proto__'), undefined);
  assert.equal(errors.name, 'Erreurs ETA');
  assert.deepEqual(boiler.features.map(kindOfFeature), ['temperature', 'number']);
  const list = variablesToRead([boiler, errors]);
  assert.deepEqual(
    list.map((v) => v.uri),
    ['/40/10021/0/0/12161', '/40/10021/0/0/12016'],
  );
  assert.equal(variablesToRead([boiler], new Map(), 1).length, 1);
});

test('the errors device states', () => {
  assert.deepEqual(errorStates([], 'en'), {
    alarm: { state: 0 },
    'error-count': { state: 0 },
    'last-error': { text: 'No active error' },
  });
  const states = errorStates(
    [
      {
        block: '1-2',
        blockName: 'K',
        msg: 'old',
        priority: 'Warnung',
        time: '2026-01-01 10:00:00',
      },
      { block: '1-2', blockName: 'K', msg: 'new', priority: 'Fehler', time: '2026-02-01 10:00:00' },
    ],
    'fr',
  );
  assert.equal(states['last-error'].text, 'K: new (Fehler, 2026-02-01 10:00:00)');
  assert.equal(states['error-count'].state, 2);
});
