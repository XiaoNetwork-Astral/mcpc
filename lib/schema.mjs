// JSON Schema validation for tool arguments and elicitation answers. Draft-07 is
// used when a schema says so or uses `definitions`; 2020-12 otherwise.

import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';

const options = { strict: false, allErrors: true, validateFormats: false, logger: false };
const draft7 = new Ajv(options);
const draft2020 = new Ajv2020(options);

const cache = new Map();
const CACHE_LIMIT = 256;

/**
 * Compile a schema once and cache the validator.
 *
 * @param {object} schema
 * @returns {{validate?: import('ajv').ValidateFunction, error?: string}}
 */
export function compileSchema(schema) {
  const key = JSON.stringify(schema);
  if (cache.has(key)) return cache.get(key);

  const dialect = String(schema?.$schema ?? '');
  const ajv =
    dialect.includes('draft-07') || dialect.includes('draft-06') || schema?.definitions
      ? draft7
      : draft2020;
  // `$schema` and `$id` would make Ajv look up or register meta-schemas; drop them.
  const { $schema, $id, ...body } = schema ?? {};

  let entry;
  try {
    entry = { validate: ajv.compile(body) };
  } catch (error) {
    entry = { error: error.message };
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, entry);
  return entry;
}

/**
 * Format Ajv errors as `- <path>: <message>` lines.
 *
 * @param {import('ajv').ErrorObject[]} errors
 * @param {number} [limit]
 */
export function formatErrors(errors = [], limit = 5) {
  const lines = errors.slice(0, limit).map((error) => {
    let where = error.instancePath || '/';
    if (error.keyword === 'required')
      where = `${error.instancePath}/${error.params.missingProperty}`;
    if (error.keyword === 'additionalProperties')
      where = `${error.instancePath}/${error.params.additionalProperty}`;
    const detail = error.keyword === 'additionalProperties' ? 'is not allowed' : error.message;
    return `- ${where}: ${detail}`;
  });
  if (errors.length > limit) lines.push(`- … ${errors.length - limit} more`);
  return lines;
}

/**
 * Validate a value; a schema that does not compile passes with a warning.
 *
 * @param {object} schema
 * @param {unknown} value
 * @returns {{valid: boolean, errors: string[], warning?: string}}
 */
export function validate(schema, value) {
  const { validate: check, error } = compileSchema(schema);
  if (!check) return { valid: true, errors: [], warning: `schema not checked: ${error}` };
  return check(value)
    ? { valid: true, errors: [] }
    : { valid: false, errors: formatErrors(check.errors) };
}
