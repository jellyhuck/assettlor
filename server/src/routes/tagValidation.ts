type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

interface TagMutation {
  tags: string[];
  source: string;
}

interface BatchTagMutation extends TagMutation {
  assetIds: string[];
  action: 'add' | 'remove';
}

function invalid(error: string): ValidationResult<never> {
  return { ok: false, error };
}

function asBody(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validTag(value: unknown): value is string {
  return typeof value === 'string' && value.replace(/^#/, '').trim().length > 0;
}

function parseTags(value: unknown, allowEmpty: boolean): ValidationResult<string[]> {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    return invalid(`tags must be ${allowEmpty ? 'an array' : 'a non-empty array'}`);
  }
  if (!value.every(validTag)) {
    return invalid('tags must contain non-empty strings');
  }
  return { ok: true, value };
}

function parseSource(value: unknown): ValidationResult<string> {
  if (value === undefined) return { ok: true, value: 'user' };
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalid('source must be a non-empty string');
  }
  return { ok: true, value: value.trim() };
}

export function parseTagName(value: unknown): ValidationResult<string> {
  return validTag(value)
    ? { ok: true, value }
    : invalid('tag must be a non-empty string');
}

export function parseTagMutation(
  value: unknown,
  mode: 'add' | 'remove' | 'set'
): ValidationResult<TagMutation> {
  const body = asBody(value);
  if (!body) return invalid('Body must be an object');

  const source = parseSource(body.source);
  if (!source.ok) return source;

  if (mode === 'set') {
    const tags = parseTags(body.tags, true);
    if (!tags.ok) return tags;
    return { ok: true, value: { tags: tags.value, source: source.value } };
  }

  const tags: string[] = [];
  if (body.tag !== undefined) {
    const tag = parseTagName(body.tag);
    if (!tag.ok) return tag;
    tags.push(tag.value);
  }
  if (body.tags !== undefined) {
    const parsed = parseTags(body.tags, true);
    if (!parsed.ok) return parsed;
    tags.push(...parsed.value);
  }
  if (tags.length === 0) {
    return invalid(mode === 'add' ? 'No tags provided' : 'No tags provided to remove');
  }
  return { ok: true, value: { tags, source: source.value } };
}

export function parseBatchTagMutation(value: unknown): ValidationResult<BatchTagMutation> {
  const body = asBody(value);
  if (!body) return invalid('Body must be an object');

  if (!Array.isArray(body.assetIds) || body.assetIds.length === 0 ||
      !body.assetIds.every((id) => typeof id === 'string' && id.trim().length > 0)) {
    return invalid('assetIds must be a non-empty array of strings');
  }
  const tags = parseTags(body.tags, false);
  if (!tags.ok) return tags;
  const source = parseSource(body.source);
  if (!source.ok) return source;

  const action = body.action === undefined ? 'add' : body.action;
  if (action !== 'add' && action !== 'remove') {
    return invalid('action must be add or remove');
  }

  return {
    ok: true,
    value: { assetIds: body.assetIds, tags: tags.value, source: source.value, action },
  };
}
