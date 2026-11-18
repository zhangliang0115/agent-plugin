import http from 'node:http'
import fs from 'node:fs'

const LOG = '/tmp/mcp-probe/requests.jsonl'
const tasks = new Map()
let seq = 0

function rec(obj) {
  fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n')
}

const srv = http.createServer(async (req, res) => {
  if (req.method !== 'POST') return res.writeHead(405).end()
  let raw = ''
  for await (const c of req) raw += c
  let msg
  try { msg = JSON.parse(raw) } catch { return res.writeHead(400).end() }

  rec({ dir: 'in', headers: { sessionId: req.headers['mcp-session-id'] ?? null, accept: req.headers.accept ?? null }, msg })

  const reply = (result) => {
    const out = { jsonrpc: '2.0', id: msg.id, result }
    rec({ dir: 'out', msg: out })
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out))
  }
  const fail = (code, message) => {
    const out = { jsonrpc: '2.0', id: msg.id, error: { code, message } }
    rec({ dir: 'out', msg: out })
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out))
  }

  // notifications have no id
  if (msg.id === undefined) { rec({ note: 'notification, acked' }); return res.writeHead(202).end() }

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: '2026-07-28',
        capabilities: {
          tools: {},
          tasks: {},                                        // 旧版形状：空对象
          extensions: { 'io.modelcontextprotocol/tasks': {} } // 新版形状
        },
        serverInfo: { name: 'probe', version: '0.0.1' }
      })

    case 'server/discover':
      return reply({
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: {
          tools: {},
          extensions: { 'io.modelcontextprotocol/tasks': {} }
        },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'probe', version: '0.0.1' } },
        ttlMs: 3600000,
        cacheScope: 'public'
      })

    case 'tools/list':
      return reply({ tools: [{
        name: 'slow',
        description: 'Wait the given milliseconds, then return. Long jobs.',
        inputSchema: { type: 'object', properties: { ms: { type: 'number', description: 'how long to wait' } }, required: ['ms'] },
        execution: { taskSupport: 'required' }
      }]})

    case 'tools/call': {
      const ms = Number(msg.params?.arguments?.ms ?? 1000)
      const taskId = 't_' + (++seq)
      const now = new Date().toISOString()
      tasks.set(taskId, { state: 'working', started: Date.now(), ms, createdAt: now })
      setTimeout(() => {
        const t = tasks.get(taskId)
        t.state = 'completed'
        t.updatedAt = new Date().toISOString()
        t.result = { content: [{ type: 'text', text: `slow done after ${ms}ms` }] }
      }, ms)
      rec({ note: 'returning CreateTaskResult', taskId, clientDeclaredTasks: !!(msg.params?._meta?.['io.modelcontextprotocol/clientCapabilities']?.extensions?.['io.modelcontextprotocol/tasks']) })
      return reply({
        resultType: 'task', taskId, status: 'working',
        createdAt: now, lastUpdatedAt: now,
        ttlMs: 600000, pollIntervalMs: 300
      })
    }

    case 'tasks/get': {
      const t = tasks.get(msg.params?.taskId)
      if (!t) return fail(-32602, 'unknown task')
      return reply({ resultType: 'complete', taskId: msg.params.taskId, status: t.state, createdAt: t.createdAt, lastUpdatedAt: t.updatedAt ?? t.createdAt, ...(t.state === 'completed' ? { result: t.result } : {}) })
    }
    case 'tasks/result': {
      const t = tasks.get(msg.params?.taskId)
      if (!t) return fail(-32602, 'unknown task')
      const wait = () => t.state === 'completed' ? reply({ taskId: msg.params.taskId, status: t.state, result: t.result }) : setTimeout(wait, 200)
      return wait()
    }
    case 'tasks/list':
      return reply({ tasks: [...tasks.entries()].map(([taskId, t]) => ({ taskId, status: t.state })) })
    case 'tasks/cancel': {
      const t = tasks.get(msg.params?.taskId)
      if (t) t.state = 'cancelled'
      return reply({})
    }
    default:
      return fail(-32601, 'method not found: ' + msg.method)
  }
})

srv.listen(8789, '127.0.0.1', () => rec({ note: 'listening on 127.0.0.1:8789' }))
