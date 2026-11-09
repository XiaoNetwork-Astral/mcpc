/**
 * Result rendering for MCPC (design §8).
 *
 * Tool results, resource contents and prompt results are turned into the plain
 * text a host agent reads. Binary blocks and oversized text are written to the
 * per-workspace results directory so the text only carries the saved path.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_TOKENS = 25000;
const DEFAULT_MAX_CHARS = 50000;
const MAX_CHARS_CAP = 500000;
const LARGE_OUTPUT_TOKENS = 10000;
const TRUNCATION_PREVIEW_CHARS = 2000;
const ERROR_MAX_CHARS = 11000;
const ERROR_KEEP_CHARS = 5000;
const DEFAULT_BINARY_MIME = 'application/octet-stream';
const DEFAULT_TEXT_MIME = 'text/plain';
const UNSUPPORTED = '[unsupported content type: ';

const EXTENSION_BY_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/wave', 'wav'],
  ['audio/ogg', 'ogg'],
  ['application/ogg', 'ogg'],
  ['audio/webm', 'webm'],
  ['video/webm', 'webm'],
  ['audio/mp4', 'm4a'],
  ['application/pdf', 'pdf'],
  ['application/json', 'json'],
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
  ['text/html', 'html'],
  ['text/csv', 'csv'],
  ['application/zip', 'zip'],
]);

/**
 * Estimate the number of tokens in a piece of text using Claude's
 * four-characters-per-token rule.
 *
 * @param {string} text Text to measure.
 * @returns {number} Estimated token count.
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Pick a file extension for an arbitrary MIME type.
 *
 * @param {string} [mime] MIME type, possibly with parameters (`; charset=...`).
 * @returns {string} A known extension or `bin`.
 */
export function extensionForMime(mime) {
  if (typeof mime !== 'string') return 'bin';
  const base = mime.split(';', 1)[0].trim().toLowerCase();
  return EXTENSION_BY_MIME.get(base) ?? 'bin';
}

/**
 * Format a byte count the way result markers show it.
 *
 * @param {number} bytes Number of bytes.
 * @returns {string} `12 B`, `12.3 KB` or `4.5 MB`.
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Truncate error text while keeping both ends visible.
 *
 * @param {string} text Error text.
 * @returns {string} The original text when it fits, otherwise the first and
 *   last 5000 characters with an omission marker.
 */
export function truncateError(text) {
  if (text.length <= ERROR_MAX_CHARS) return text;
  const omitted = text.length - ERROR_KEEP_CHARS * 2;
  return `${text.slice(0, ERROR_KEEP_CHARS)}\n…[${omitted} chars omitted]…\n${text.slice(
    -ERROR_KEEP_CHARS,
  )}`;
}

/**
 * Render a `CallToolResult` for the host agent, saving binary blocks and
 * oversized text into `resultsDir`.
 *
 * @param {{content?: object[], structuredContent?: object, isError?: boolean}} result
 *   MCP tool call result.
 * @param {object} options Rendering options.
 * @param {string} options.callId Call id used in saved file names.
 * @param {string} options.tool Fully qualified tool id.
 * @param {string} options.resultsDir Directory for saved files.
 * @param {number} [options.maxTokens=25000] Token limit before saving text.
 * @param {number} [options.maxChars=50000] Character limit before saving text.
 * @param {object} [options.toolMeta] Tool `_meta`; may raise the char limit.
 * @returns {{text: string, json: object, files: string[], isError: boolean}}
 *   Rendered text (no trailing newline), the JSON form, every file written and
 *   whether the tool reported an error.
 */
export function renderToolResult(result, options = {}) {
  const {
    callId,
    tool,
    resultsDir,
    maxTokens = DEFAULT_MAX_TOKENS,
    maxChars = DEFAULT_MAX_CHARS,
    toolMeta,
  } = options;
  const isError = result?.isError === true;
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const files = [];
  const parts = [];
  const content = [];
  let savedCount = 0;

  if (blocks.length === 0) parts.push(`(${tool} returned no content)`);

  for (const block of blocks) {
    const type = block?.type;

    if (type === 'text') {
      parts.push(typeof block.text === 'string' ? block.text : '');
      content.push({ ...block });
      continue;
    }

    if (type === 'image' || type === 'audio') {
      const mime = block.mimeType || DEFAULT_BINARY_MIME;
      const bytes = decodeBase64(block.data);
      const file = saveToResults(
        resultsDir,
        `${callId}-${++savedCount}.${extensionForMime(mime)}`,
        bytes,
        files,
      );
      parts.push(`[${type} ${mime} ${formatBytes(bytes.length)} → ${file}]`);
      content.push({ ...block, data: { path: file, bytes: bytes.length } });
      continue;
    }

    if (type === 'resource') {
      const resource = block.resource ?? {};
      const uri = resource.uri ?? '';
      const mime = resourceMime(resource);

      if (typeof resource.text === 'string') {
        const heading = `[resource ${uri} ${mime}]`;
        parts.push(resource.text.length > 0 ? `${heading}\n${resource.text}` : heading);
        content.push({ ...block, resource: { ...resource } });
        continue;
      }

      const bytes = decodeBase64(resource.blob);
      const file = saveToResults(
        resultsDir,
        `${callId}-${++savedCount}.${extensionForMime(mime)}`,
        bytes,
        files,
      );
      parts.push(`[resource ${uri} ${mime} ${formatBytes(bytes.length)} → ${file}]`);
      content.push({
        ...block,
        resource: { ...resource, blob: { path: file, bytes: bytes.length } },
      });
      continue;
    }

    if (type === 'resource_link') {
      const mime = block.mimeType || DEFAULT_BINARY_MIME;
      parts.push(`[resource link ${block.uri ?? ''} ${block.name ?? ''} ${mime}]`);
      content.push({ ...block });
      continue;
    }

    parts.push(`${UNSUPPORTED}${type}]`);
    content.push({ ...block });
  }

  let text = parts.join('\n\n');
  const structuredContent = result?.structuredContent;
  if (structuredContent !== undefined && !isSameJson(text, structuredContent)) {
    parts.push(`[structured content]\n${JSON.stringify(structuredContent, null, 2)}`);
    text = parts.join('\n\n');
  }

  const tokens = estimateTokens(text);
  let output;
  let savedText = null;

  if (isError) {
    output = `Tool error:\n${truncateError(text)}`;
  } else if (tokens > maxTokens || text.length > effectiveMaxChars(maxChars, toolMeta)) {
    const file = saveToResults(resultsDir, `${callId}.txt`, text, files);
    savedText = file;
    output = `${text.slice(0, TRUNCATION_PREVIEW_CHARS)}\n[output truncated: ${
      text.length
    } chars, ~${tokens} tokens → ${file}]`;
  } else {
    output = tokens > LARGE_OUTPUT_TOKENS ? `${text}\n[large output: ~${tokens} tokens]` : text;
  }

  return {
    text: output,
    json: { callId, tool, isError, content, structuredContent, savedText },
    files,
    isError,
  };
}

/**
 * Render `ReadResourceResult.contents` for the host agent, saving blob contents
 * and oversized text into `resultsDir`.
 *
 * @param {object[]} contents Resource contents (`uri`, `mimeType`, `text` or `blob`).
 * @param {object} options Rendering options.
 * @param {string} options.id Id used in saved file names.
 * @param {string} options.resultsDir Directory for saved files.
 * @param {number} [options.maxTokens=25000] Token limit before saving text.
 * @param {number} [options.maxChars=50000] Character limit before saving text.
 * @returns {{text: string, json: object, files: string[]}} Rendered text (no
 *   trailing newline), the JSON form and every file written.
 */
export function renderResourceContents(contents, options = {}) {
  const { id, resultsDir, maxTokens = DEFAULT_MAX_TOKENS, maxChars = DEFAULT_MAX_CHARS } = options;
  const items = Array.isArray(contents) ? contents : [];
  const parts = [];
  const jsonContents = [];
  const files = [];
  let savedCount = 0;

  for (const item of items) {
    const uri = item?.uri ?? '';
    const mime = resourceMime(item);
    const heading = `[resource ${uri} ${mime}]`;

    if (typeof item?.text === 'string') {
      parts.push(item.text.length > 0 ? `${heading}\n${item.text}` : heading);
      jsonContents.push({ ...item });
      continue;
    }

    const bytes = decodeBase64(item?.blob);
    const file = saveToResults(
      resultsDir,
      `${id}-${++savedCount}.${extensionForMime(mime)}`,
      bytes,
      files,
    );
    parts.push(`${heading}\n[blob ${mime} ${formatBytes(bytes.length)} → ${file}]`);
    jsonContents.push({ ...item, blob: { path: file, bytes: bytes.length } });
  }

  const text = parts.join('\n\n');
  const tokens = estimateTokens(text);
  let output = text;
  let savedText = null;

  if (tokens > maxTokens || text.length > effectiveMaxChars(maxChars)) {
    const file = saveToResults(resultsDir, `${id}.txt`, text, files);
    savedText = file;
    output = `${text.slice(0, TRUNCATION_PREVIEW_CHARS)}\n[output truncated: ${
      text.length
    } chars, ~${tokens} tokens → ${file}]`;
  } else if (tokens > LARGE_OUTPUT_TOKENS) {
    output = `${text}\n[large output: ~${tokens} tokens]`;
  }

  return { text: output, json: { id, contents: jsonContents, savedText }, files };
}

/**
 * Render a `GetPromptResult` for the host agent. Non-text blocks are
 * summarized rather than saved.
 *
 * @param {{description?: string, messages?: object[]}} result Prompt result.
 * @returns {string} Rendered prompt text without a trailing newline.
 */
export function renderPromptResult(result) {
  const sections = [];
  if (typeof result?.description === 'string' && result.description.length > 0) {
    sections.push(result.description);
  }

  const messages = Array.isArray(result?.messages) ? result.messages : [];
  for (const message of messages) {
    const role = message?.role ?? 'unknown';
    const blocks = Array.isArray(message?.content) ? message.content : [message?.content];
    const body = blocks
      .map(renderPromptBlock)
      .filter((part) => part.length > 0)
      .join('\n');
    sections.push(body.length > 0 ? `[${role}]\n${body}` : `[${role}]`);
  }

  return sections.join('\n\n');
}

/**
 * Render one content block inside a prompt message as a single line (or raw
 * text for text blocks).
 *
 * @param {object} block Content block.
 * @returns {string} Rendered block.
 */
function renderPromptBlock(block) {
  const type = block?.type;
  if (type === 'text') return typeof block.text === 'string' ? block.text : '';
  if (type === 'image') return `[image ${block.mimeType || DEFAULT_BINARY_MIME}]`;
  if (type === 'audio') return `[audio ${block.mimeType || DEFAULT_BINARY_MIME}]`;
  if (type === 'resource') return `[resource ${block.resource?.uri ?? ''}]`;
  if (type === 'resource_link') return `[resource link ${block.uri ?? ''}]`;
  return `${UNSUPPORTED}${type}]`;
}

/**
 * Resolve the character limit for a result, honoring a tool's
 * `_meta["anthropic/maxResultSizeChars"]` raise within the global cap.
 *
 * @param {number} maxChars Caller-provided base limit.
 * @param {object} [toolMeta] Tool metadata.
 * @returns {number} Effective character limit.
 */
function effectiveMaxChars(maxChars, toolMeta) {
  let limit = typeof maxChars === 'number' ? maxChars : DEFAULT_MAX_CHARS;
  const raised = toolMeta?.['anthropic/maxResultSizeChars'];
  if (typeof raised === 'number' && raised > limit) limit = raised;
  return Math.min(limit, MAX_CHARS_CAP);
}

/**
 * Compare a JSON text representation with structured content.
 *
 * @param {string} text Joined text parts.
 * @param {unknown} structured Parsed structured content.
 * @returns {boolean} True when the text parses to a deeply equal value.
 */
function isSameJson(text, structured) {
  try {
    return deepEqual(JSON.parse(text), structured);
  } catch {
    return false;
  }
}

/**
 * Recursively compare JSON values without depending on object key order.
 *
 * @param {unknown} a First value.
 * @param {unknown} b Second value.
 * @returns {boolean} True when both values are deeply equal.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/**
 * Decode a base64 payload, tolerating missing data.
 *
 * @param {unknown} value Base64 string.
 * @returns {Buffer} Decoded bytes.
 */
function decodeBase64(value) {
  return Buffer.from(typeof value === 'string' ? value : '', 'base64');
}

/**
 * Choose the MIME type shown for a resource, defaulting by payload kind.
 *
 * @param {object} resource Resource contents.
 * @returns {string} MIME type.
 */
function resourceMime(resource) {
  if (typeof resource?.mimeType === 'string' && resource.mimeType.length > 0) {
    return resource.mimeType;
  }
  return typeof resource?.text === 'string' ? DEFAULT_TEXT_MIME : DEFAULT_BINARY_MIME;
}

/**
 * Write one results file, creating the results directory on first use.
 *
 * @param {string} resultsDir Directory for saved files.
 * @param {string} name File name.
 * @param {string|Buffer} data File contents.
 * @param {string[]} files Accumulator for written paths.
 * @returns {string} The written path.
 */
function saveToResults(resultsDir, name, data, files) {
  mkdirSync(resultsDir, { recursive: true });
  const file = join(resultsDir, name);
  writeFileSync(file, data);
  files.push(file);
  return file;
}
