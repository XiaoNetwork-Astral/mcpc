import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  estimateTokens,
  extensionForMime,
  formatBytes,
  renderPromptResult,
  renderResourceContents,
  renderToolResult,
  truncateError,
} from '../lib/render.mjs';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpc-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('estimateTokens uses four characters per token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('a'), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});

test('extensionForMime maps known types and falls back to bin', () => {
  assert.equal(extensionForMime('image/png'), 'png');
  assert.equal(extensionForMime('image/jpeg'), 'jpg');
  assert.equal(extensionForMime('image/gif'), 'gif');
  assert.equal(extensionForMime('image/webp'), 'webp');
  assert.equal(extensionForMime('image/svg+xml'), 'svg');
  assert.equal(extensionForMime('audio/mpeg'), 'mp3');
  assert.equal(extensionForMime('audio/wav'), 'wav');
  assert.equal(extensionForMime('audio/x-wav'), 'wav');
  assert.equal(extensionForMime('audio/ogg'), 'ogg');
  assert.equal(extensionForMime('video/webm'), 'webm');
  assert.equal(extensionForMime('audio/mp4'), 'm4a');
  assert.equal(extensionForMime('application/pdf'), 'pdf');
  assert.equal(extensionForMime('application/json'), 'json');
  assert.equal(extensionForMime('text/plain'), 'txt');
  assert.equal(extensionForMime('text/markdown'), 'md');
  assert.equal(extensionForMime('text/html'), 'html');
  assert.equal(extensionForMime('text/csv'), 'csv');
  assert.equal(extensionForMime('application/zip'), 'zip');
  assert.equal(extensionForMime('image/svg+xml; charset=utf-8'), 'svg');
  assert.equal(extensionForMime('IMAGE/PNG'), 'png');
  assert.equal(extensionForMime('application/octet-stream'), 'bin');
  assert.equal(extensionForMime(undefined), 'bin');
});

test('formatBytes formats B, KB and MB boundaries', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(12595), '12.3 KB');
  assert.equal(formatBytes(1024 * 1024 - 1), '1024.0 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(4.5 * 1024 * 1024), '4.5 MB');
});

test('renderToolResult renders mixed blocks and saves binary data', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
  const audio = Buffer.from([0x49, 0x44, 0x33, 0x01]);
  const blob = Buffer.from('blob-bytes');
  const result = {
    content: [
      { type: 'text', text: 'first' },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: 'second' },
      { type: 'audio', data: audio.toString('base64'), mimeType: 'audio/mpeg' },
      {
        type: 'resource',
        resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'embedded' },
      },
      {
        type: 'resource',
        resource: {
          uri: 'file:///data.bin',
          mimeType: 'application/octet-stream',
          blob: blob.toString('base64'),
        },
      },
      {
        type: 'resource_link',
        uri: 'file:///linked.txt',
        name: 'linked',
        mimeType: 'text/plain',
      },
      { type: 'video', data: 'ignored' },
    ],
  };

  const out = renderToolResult(result, {
    callId: 'call-1',
    tool: 'alpha/tool',
    resultsDir: dir,
  });
  const pngPath = join(dir, 'call-1-1.png');
  const audioPath = join(dir, 'call-1-2.mp3');
  const blobPath = join(dir, 'call-1-3.bin');

  const expected = [
    'first',
    `[image image/png 5 B → ${pngPath}]`,
    'second',
    `[audio audio/mpeg 4 B → ${audioPath}]`,
    '[resource file:///notes.txt text/plain]\nembedded',
    `[resource file:///data.bin application/octet-stream 10 B → ${blobPath}]`,
    '[resource link file:///linked.txt linked text/plain]',
    '[unsupported content type: video]',
  ].join('\n\n');

  assert.equal(out.text, expected);
  assert.equal(out.isError, false);
  assert.deepEqual(out.files, [pngPath, audioPath, blobPath]);
  assert.deepEqual(readFileSync(pngPath), png);
  assert.deepEqual(readFileSync(audioPath), audio);
  assert.deepEqual(readFileSync(blobPath), blob);

  assert.equal(out.json.callId, 'call-1');
  assert.equal(out.json.tool, 'alpha/tool');
  assert.equal(out.json.isError, false);
  assert.equal(out.json.savedText, null);
  assert.deepEqual(out.json.content[1].data, { path: pngPath, bytes: png.length });
  assert.deepEqual(out.json.content[3].data, { path: audioPath, bytes: audio.length });
  assert.deepEqual(out.json.content[4], {
    type: 'resource',
    resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'embedded' },
  });
  assert.deepEqual(out.json.content[5].resource.blob, {
    path: blobPath,
    bytes: blob.length,
  });
  assert.equal(out.json.content[7].type, 'video');
});

test('renderToolResult reports empty or missing content without creating a directory', () => {
  const resultsDir = join(dir, 'not-created');
  for (const result of [{ content: [] }, {}, { content: undefined }]) {
    const out = renderToolResult(result, {
      callId: 'call-2',
      tool: 'alpha/tool',
      resultsDir,
    });
    assert.equal(out.text, '(alpha/tool returned no content)');
    assert.deepEqual(out.files, []);
    assert.deepEqual(out.json.content, []);
    assert.equal(out.json.savedText, null);
  }
  assert.equal(existsSync(resultsDir), false);
});

test('renderToolResult omits structured content equal to the text', () => {
  const result = {
    content: [{ type: 'text', text: '{"b":{"c":2},"a":1}' }],
    structuredContent: { a: 1, b: { c: 2 } },
  };
  const out = renderToolResult(result, {
    callId: 'call-3',
    tool: 'alpha/tool',
    resultsDir: dir,
  });
  assert.equal(out.text, '{"b":{"c":2},"a":1}');
});

test('renderToolResult appends structured content when it differs', () => {
  const result = {
    content: [{ type: 'text', text: 'plain words' }],
    structuredContent: { a: 1 },
  };
  const out = renderToolResult(result, {
    callId: 'call-4',
    tool: 'alpha/tool',
    resultsDir: dir,
  });
  assert.equal(out.text, 'plain words\n\n[structured content]\n{\n  "a": 1\n}');
  assert.deepEqual(out.json.structuredContent, { a: 1 });
});

test('renderToolResult saves and truncates oversized text by token limit', () => {
  const full = 'a'.repeat(3000);
  const out = renderToolResult(
    { content: [{ type: 'text', text: full }] },
    { callId: 'call-5', tool: 'alpha/tool', resultsDir: dir, maxTokens: 10 },
  );
  const textPath = join(dir, 'call-5.txt');
  const expected = `${full.slice(0, 2000)}\n[output truncated: 3000 chars, ~750 tokens → ${textPath}]`;

  assert.equal(out.text, expected);
  assert.equal(readFileSync(textPath, 'utf8'), full);
  assert.deepEqual(out.files, [textPath]);
  assert.equal(out.json.savedText, textPath);
});

test('renderToolResult saves and truncates oversized text by character limit', () => {
  const full = 'b'.repeat(200);
  const out = renderToolResult(
    { content: [{ type: 'text', text: full }] },
    { callId: 'call-6', tool: 'alpha/tool', resultsDir: dir, maxChars: 100 },
  );
  const textPath = join(dir, 'call-6.txt');
  const expected = `${full}\n[output truncated: 200 chars, ~50 tokens → ${textPath}]`;

  assert.equal(out.text, expected);
  assert.equal(readFileSync(textPath, 'utf8'), full);
  assert.deepEqual(out.files, [textPath]);
});

test('renderToolResult honors maxResultSizeChars raises and caps them', () => {
  const raised = 'c'.repeat(120);
  const raisedOut = renderToolResult(
    { content: [{ type: 'text', text: raised }] },
    {
      callId: 'call-7',
      tool: 'alpha/tool',
      resultsDir: dir,
      maxChars: 100,
      maxTokens: 100000,
      toolMeta: { 'anthropic/maxResultSizeChars': 150 },
    },
  );
  assert.equal(raisedOut.text, raised);
  assert.deepEqual(raisedOut.files, []);

  const capped = 'd'.repeat(500001);
  const cappedOut = renderToolResult(
    { content: [{ type: 'text', text: capped }] },
    {
      callId: 'call-8',
      tool: 'alpha/tool',
      resultsDir: dir,
      maxTokens: 1000000000,
      toolMeta: { 'anthropic/maxResultSizeChars': 600000 },
    },
  );
  const cappedPath = join(dir, 'call-8.txt');
  assert.equal(
    cappedOut.text,
    `${capped.slice(0, 2000)}\n[output truncated: 500001 chars, ~125001 tokens → ${cappedPath}]`,
  );
  assert.equal(readFileSync(cappedPath, 'utf8'), capped);
});

test('renderToolResult warns about large output under the limits', () => {
  const resultsDir = join(dir, 'large');
  const full = 'x'.repeat(40004);
  const out = renderToolResult(
    { content: [{ type: 'text', text: full }] },
    { callId: 'call-9', tool: 'alpha/tool', resultsDir },
  );
  assert.equal(out.text, `${full}\n[large output: ~10001 tokens]`);
  assert.deepEqual(out.files, []);
  assert.equal(existsSync(resultsDir), false);
});

test('renderToolResult formats errors and never saves error text', () => {
  const resultsDir = join(dir, 'errors');
  const out = renderToolResult(
    { content: [{ type: 'text', text: 'boom' }], isError: true },
    { callId: 'call-10', tool: 'alpha/tool', resultsDir },
  );
  assert.equal(out.text, 'Tool error:\nboom');
  assert.equal(out.isError, true);
  assert.equal(out.json.isError, true);
  assert.equal(out.json.savedText, null);
  assert.deepEqual(out.files, []);

  const long = 'E'.repeat(12000);
  const truncated = renderToolResult(
    { content: [{ type: 'text', text: long }], isError: true },
    { callId: 'call-11', tool: 'alpha/tool', resultsDir },
  );
  const expected = `Tool error:\n${long.slice(0, 5000)}\n…[2000 chars omitted]…\n${long.slice(-5000)}`;
  assert.equal(truncated.text, expected);
  assert.deepEqual(truncated.files, []);
  assert.equal(existsSync(resultsDir), false);
});

test('truncateError keeps short text and folds long text', () => {
  assert.equal(truncateError('short'), 'short');
  const exact = 'e'.repeat(11000);
  assert.equal(truncateError(exact), exact);

  const long = 'f'.repeat(11001);
  assert.equal(
    truncateError(long),
    `${'f'.repeat(5000)}\n…[1001 chars omitted]…\n${'f'.repeat(5000)}`,
  );
});

test('renderToolResult produces the JSON form', () => {
  const out = renderToolResult(
    { content: [{ type: 'text', text: 'hi' }] },
    { callId: 'call-12', tool: 'alpha/tool', resultsDir: dir },
  );
  assert.deepEqual(out.json, {
    callId: 'call-12',
    tool: 'alpha/tool',
    isError: false,
    content: [{ type: 'text', text: 'hi' }],
    structuredContent: undefined,
    savedText: null,
  });
});

test('renderResourceContents renders text and blob items and saves blobs', () => {
  const png = Buffer.from([1, 2, 3, 4, 5, 6, 7]);
  const out = renderResourceContents(
    [
      { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'alpha' },
      { uri: 'file:///b.png', mimeType: 'image/png', blob: png.toString('base64') },
    ],
    { id: 'read-1', resultsDir: dir },
  );
  const blobPath = join(dir, 'read-1-1.png');
  const expected = [
    '[resource file:///a.txt text/plain]\nalpha',
    `[resource file:///b.png image/png]\n[blob image/png 7 B → ${blobPath}]`,
  ].join('\n\n');

  assert.equal(out.text, expected);
  assert.deepEqual(out.files, [blobPath]);
  assert.deepEqual(readFileSync(blobPath), png);
  assert.deepEqual(out.json, {
    id: 'read-1',
    contents: [
      { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'alpha' },
      {
        uri: 'file:///b.png',
        mimeType: 'image/png',
        blob: { path: blobPath, bytes: png.length },
      },
    ],
    savedText: null,
  });
});

test('renderResourceContents truncates oversized combined text', () => {
  const body = 'z'.repeat(3000);
  const full = `[resource file:///long text/plain]\n${body}`;
  const out = renderResourceContents(
    [{ uri: 'file:///long', mimeType: 'text/plain', text: body }],
    {
      id: 'read-2',
      resultsDir: dir,
      maxTokens: 10,
    },
  );
  const textPath = join(dir, 'read-2.txt');
  assert.equal(
    out.text,
    `${full.slice(0, 2000)}\n[output truncated: ${full.length} chars, ~${estimateTokens(
      full,
    )} tokens → ${textPath}]`,
  );
  assert.equal(readFileSync(textPath, 'utf8'), full);
  assert.deepEqual(out.files, [textPath]);
  assert.equal(out.json.savedText, textPath);
});

test('renderPromptResult renders description, roles and block summaries', () => {
  const result = {
    description: 'Demo prompt',
    messages: [
      { role: 'user', content: { type: 'text', text: 'hello' } },
      {
        role: 'assistant',
        content: { type: 'image', data: 'AA==', mimeType: 'image/png' },
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see attached' },
          { type: 'audio', data: 'AA==', mimeType: 'audio/mpeg' },
          { type: 'resource', resource: { uri: 'file:///x.txt', text: 'x' } },
          { type: 'resource_link', uri: 'file:///y.txt', name: 'y' },
        ],
      },
    ],
  };

  const expected = [
    'Demo prompt',
    '[user]\nhello',
    '[assistant]\n[image image/png]',
    [
      '[user]',
      'see attached',
      '[audio audio/mpeg]',
      '[resource file:///x.txt]',
      '[resource link file:///y.txt]',
    ].join('\n'),
  ].join('\n\n');

  assert.equal(renderPromptResult(result), expected);
  assert.equal(renderPromptResult({ messages: [] }), '');
});
