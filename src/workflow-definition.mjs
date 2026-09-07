import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { validateGraph } from './workflow-graph.mjs'

const nodeIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9-]*$/, 'must use lowercase kebab-case')

const workflowConditionSchema = z.strictObject({
  signalsAll: z.array(z.string().min(1)).min(1).optional(),
  signalsAny: z.array(z.string().min(1)).min(1).optional(),
  signalsNone: z.array(z.string().min(1)).min(1).optional(),
})

export const workflowNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.enum(['rule', 'command', 'manual', 'agent']),
  requires: z.array(nodeIdSchema).default([]),
  description: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  retry: z
    .strictObject({
      maxAttempts: z.number().int().min(1).max(10),
    })
    .optional(),
  when: workflowConditionSchema.optional(),
})

export const workflowDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: nodeIdSchema,
  version: z.number().int().positive(),
  description: z.string().min(1).optional(),
  nodes: z.array(workflowNodeSchema).min(1),
})

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }

  return value
}

export function normalizeWorkflowDefinition(definition) {
  return canonicalize({
    ...definition,
    nodes: definition.nodes
      .map((node) => ({
        ...node,
        requires: [...node.requires].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  })
}

export function hashWorkflowDefinition(definition) {
  const normalized = normalizeWorkflowDefinition(definition)
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function schemaErrors(error, source) {
  return error.issues.map((issue) => ({
    code: 'SCHEMA_VALIDATION_ERROR',
    source,
    path: issue.path.join('.'),
    message: issue.message,
  }))
}

export function loadWorkflowDefinition(yamlSource, source = '<workflow>') {
  let rawDefinition

  try {
    rawDefinition = parseYaml(yamlSource)
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          code: 'YAML_PARSE_ERROR',
          source,
          path: '',
          message: error.message,
        },
      ],
    }
  }

  const parsed = workflowDefinitionSchema.safeParse(rawDefinition)
  if (!parsed.success) {
    return { ok: false, errors: schemaErrors(parsed.error, source) }
  }

  const graphValidation = validateGraph(parsed.data)
  if (!graphValidation.ok) {
    return {
      ok: false,
      errors: graphValidation.errors.map((error) => ({
        ...error,
        code: `GRAPH_${error.code}`,
        source,
      })),
    }
  }

  const definition = normalizeWorkflowDefinition(parsed.data)

  return {
    ok: true,
    definition,
    graphHash: hashWorkflowDefinition(definition),
    errors: [],
  }
}
