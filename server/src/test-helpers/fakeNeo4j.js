// A recording stand-in for the neo4j-driver, used by the unit tests. It does NOT interpret Cypher:
// `handler(cypher, params)` returns the rows a statement should "return". What the tests can check is
// WHICH statements run, with WHICH parameters, in WHICH transaction. Real Cypher behaviour is only
// covered by graphStore.integration.test.js (needs a live Neo4j, skipped otherwise).
export function makeFakeDriver(handler = () => []) {
  const calls = []
  const state = { transactions: 0, failWith: null, calls }
  const result = (list) => ({ records: list.map((row) => ({ keys: Object.keys(row), get: (k) => row[k] })) })
  const run = async (cypher, params) => {
    if (state.failWith) throw state.failWith
    calls.push({ cypher, params })
    return result(handler(cypher, params) ?? [])
  }
  const tx = { run }
  const session = {
    executeRead: async (fn) => { if (state.failWith) throw state.failWith; return fn(tx) },
    executeWrite: async (fn) => { if (state.failWith) throw state.failWith; state.transactions += 1; return fn(tx) },
    run,
    close: async () => {},
  }
  const driver = { session: () => session, verifyConnectivity: async () => { if (state.failWith) throw state.failWith }, close: async () => {} }
  return Object.assign(driver, { state })
}

export function setGraphEnv() {
  process.env.NEO4J_URI = 'bolt://localhost:7687'
  process.env.NEO4J_USERNAME = 'neo4j'
  process.env.NEO4J_PASSWORD = 'test-password'
}
export function clearGraphEnv() {
  delete process.env.NEO4J_URI
  delete process.env.NEO4J_USERNAME
  delete process.env.NEO4J_PASSWORD
}
