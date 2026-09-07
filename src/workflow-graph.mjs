const SATISFIED_DEPENDENCY_STATES = new Set(['succeeded', 'skipped'])

function graphError(code, message, nodeId, details = {}) {
  return { code, message, nodeId, ...details }
}

function nodeState(nodeStates, nodeId) {
  return nodeStates[nodeId] ?? 'pending'
}

export function validateGraph(graph) {
  const errors = []

  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes)) {
    return {
      ok: false,
      errors: [graphError('INVALID_GRAPH', 'Graph must contain a nodes array')],
    }
  }

  if (graph.nodes.length === 0) {
    return {
      ok: false,
      errors: [graphError('EMPTY_GRAPH', 'Graph must contain at least one node')],
    }
  }

  const nodesById = new Map()

  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || node.id.trim().length === 0) {
      errors.push(graphError('INVALID_NODE_ID', 'Node id must be a non-empty string'))
      continue
    }

    if (nodesById.has(node.id)) {
      errors.push(
        graphError('DUPLICATE_NODE_ID', `Duplicate node id: ${node.id}`, node.id),
      )
      continue
    }

    nodesById.set(node.id, node)

    if (!Array.isArray(node.requires)) {
      errors.push(
        graphError(
          'INVALID_DEPENDENCIES',
          `Node ${node.id} requires must be an array`,
          node.id,
        ),
      )
    }
  }

  for (const node of nodesById.values()) {
    if (!Array.isArray(node.requires)) continue

    const dependencies = new Set()
    for (const dependencyId of node.requires) {
      if (dependencies.has(dependencyId)) {
        errors.push(
          graphError(
            'DUPLICATE_DEPENDENCY',
            `Node ${node.id} repeats dependency ${dependencyId}`,
            node.id,
            { dependencyId },
          ),
        )
      }
      dependencies.add(dependencyId)

      if (dependencyId === node.id) {
        errors.push(
          graphError(
            'SELF_DEPENDENCY',
            `Node ${node.id} cannot depend on itself`,
            node.id,
          ),
        )
      } else if (!nodesById.has(dependencyId)) {
        errors.push(
          graphError(
            'MISSING_DEPENDENCY',
            `Node ${node.id} depends on missing node ${dependencyId}`,
            node.id,
            { dependencyId },
          ),
        )
      }
    }
  }

  if (errors.length === 0) {
    const inDegree = new Map()
    const dependents = new Map()

    for (const node of nodesById.values()) {
      inDegree.set(node.id, node.requires.length)
      dependents.set(node.id, [])
    }

    for (const node of nodesById.values()) {
      for (const dependencyId of node.requires) {
        dependents.get(dependencyId).push(node.id)
      }
    }

    const queue = [...inDegree.entries()]
      .filter(([, degree]) => degree === 0)
      .map(([nodeId]) => nodeId)
      .sort()
    const visited = []

    while (queue.length > 0) {
      const current = queue.shift()
      visited.push(current)

      for (const dependentId of dependents.get(current)) {
        const nextDegree = inDegree.get(dependentId) - 1
        inDegree.set(dependentId, nextDegree)
        if (nextDegree === 0) {
          queue.push(dependentId)
          queue.sort()
        }
      }
    }

    if (visited.length !== nodesById.size) {
      const cycleNodeIds = [...inDegree.entries()]
        .filter(([, degree]) => degree > 0)
        .map(([nodeId]) => nodeId)
        .sort()

      errors.push(
        graphError(
          'CYCLE_DETECTED',
          `Graph contains a cycle involving: ${cycleNodeIds.join(', ')}`,
          undefined,
          { cycleNodeIds },
        ),
      )
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors }
}

export function findRunnableNodes(graph, nodeStates = {}) {
  const validation = validateGraph(graph)
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, nodeIds: [] }
  }

  const nodeIds = graph.nodes
    .filter((node) => {
      if (nodeState(nodeStates, node.id) !== 'pending') return false

      return node.requires.every((dependencyId) =>
        SATISFIED_DEPENDENCY_STATES.has(nodeState(nodeStates, dependencyId)),
      )
    })
    .map((node) => node.id)
    .sort()

  return { ok: true, errors: [], nodeIds }
}

export function deriveRunStatus(graph, nodeStates = {}) {
  const validation = validateGraph(graph)
  if (!validation.ok) {
    return { ok: false, errors: validation.errors }
  }

  const states = graph.nodes.map((node) => nodeState(nodeStates, node.id))

  if (states.every((state) => SATISFIED_DEPENDENCY_STATES.has(state))) {
    return { ok: true, status: 'completed' }
  }

  if (states.includes('running')) {
    return { ok: true, status: 'running' }
  }

  const runnable = findRunnableNodes(graph, nodeStates)
  if (states.includes('ready') || runnable.nodeIds.length > 0) {
    return { ok: true, status: 'ready' }
  }

  if (states.includes('waiting')) {
    return { ok: true, status: 'waiting' }
  }

  if (states.includes('failed')) {
    return { ok: true, status: 'failed' }
  }

  if (states.includes('cancelled')) {
    return { ok: true, status: 'cancelled' }
  }

  return { ok: true, status: 'blocked' }
}
