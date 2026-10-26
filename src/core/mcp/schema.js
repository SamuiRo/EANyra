import { z } from 'zod';

export function jsonSchemaToZod(schema) {
  const shape = {};
  for (const [key, definition] of Object.entries(schema?.properties ?? {})) {
    let field = convert(definition);
    if (definition.type === 'integer' && definition.minimum === undefined) {
      field = field.min(key === 'limit' || key === 'history_limit' ? 1 : 0);
    }
    if (definition.description) field = field.describe(definition.description);
    if (!(schema.required ?? []).includes(key)) field = field.optional();
    if (definition.default !== undefined) field = field.default(definition.default);
    shape[key] = field;
  }
  return shape;
}

function convert(definition) {
  if (definition.oneOf) return z.union(definition.oneOf.map(convert));
  let field;
  switch (definition.type) {
    case 'integer':
    case 'number':
      field = z.number();
      if (definition.type === 'integer') field = field.int();
      if (definition.minimum !== undefined) field = field.min(definition.minimum);
      if (definition.maximum !== undefined) field = field.max(definition.maximum);
      return field;
    case 'string':
      field = definition.enum ? z.enum(definition.enum) : z.string();
      if (definition.minLength !== undefined) field = field.min(definition.minLength);
      if (definition.maxLength !== undefined) field = field.max(definition.maxLength);
      return field;
    case 'boolean': return z.boolean();
    case 'array': return z.array(convert(definition.items ?? {}));
    case 'object': return z.object(jsonSchemaToZod(definition));
    default: return z.any();
  }
}
