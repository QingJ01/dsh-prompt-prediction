import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { createHostFixture, extractedRoot } from './support/dsh-runtime.mjs'

const available = existsSync(`${extractedRoot}/dsh-client-connection/lib/index.js`) &&
  existsSync(`${extractedRoot}/dsh-llm/lib/index.js`)
const integration = (name, fn) => test(name, { skip: available ? false : 'set DSH_EXTRACTED_ROOT to the extracted installed runtime' }, fn)

integration('actual DSH HTTP bridge serves GET state/config/ping and streamed POST feedback', async () => {
  const fixture = await createHostFixture()
  try {
    for (const route of ['ping', 'config']) {
      const response = await fetch(`${fixture.origin}/api/dsh-prompt-prediction/${route}`)
      assert.equal(response.status, 200)
      assert.equal((await response.json()).build ?? 'pp-host-10', 'pp-host-10')
    }
    let state
    for (let n = 0; n < 5; n++) {
      const response = await fetch(`${fixture.origin}/api/dsh-prompt-prediction/state?sessionId=review-session`)
      assert.equal(response.status, 200)
      state = await response.json()
      if (state.status === 'ready') break
    }
    assert.equal(state.text, '跑一下测试吧')
    const response = await fetch(`${fixture.origin}/api/dsh-prompt-prediction/feedback`, {
      method: 'POST', body: JSON.stringify({ sessionId: 'review-session', action: 'accepted', turnSeq: state.turnSeq, text: state.text }),
    })
    assert.equal(response.status, 200)
    assert.equal(fixture.requests[0].tools.length, 0, 'defined empty current tools are preserved')
    assert.equal(fixture.requests[0].toolHistory.tools[0].name, 'old_tool')
    assert.ok(fixture.requests[0].messages.at(-1).id)
    assert.deepEqual(fixture.requests[0].messages.at(-1).source, { kind: 'user' })
  } finally { await fixture.close() }
})

integration('carrier regression reproduces why streaming GET was invalid', async () => {
  const fixture = await createHostFixture()
  try {
    const route = fixture.routes.get('/api/dsh-prompt-prediction/ping')
    assert.equal(route.requestBody, 'buffered')
    route.requestBody = 'streaming'
    const response = await fetch(`${fixture.origin}/api/dsh-prompt-prediction/ping`)
    assert.equal(response.status, 500)
    assert.match(await response.text(), /GET\/HEAD method cannot have body/)
  } finally { await fixture.close() }
})

integration('actual DSH owner registry rejects guest and wrong methods', async () => {
  const fixture = await createHostFixture()
  try {
    const path = `${fixture.origin}/api/dsh-prompt-prediction/ping`
    assert.equal((await fetch(path, { headers: { 'x-review-principal': 'guest' } })).status, 403)
    assert.equal((await fetch(path, { method: 'POST' })).status, 404)
    assert.equal((await fetch(`${fixture.origin}/api/dsh-prompt-prediction/feedback`, { method: 'POST', body: JSON.stringify({ sessionId: 'review-session', action: 'mounted', overflow: 'x'.repeat(9000) }) })).status, 400)
  } finally { await fixture.close() }
})

integration('configured compact route passes the real DSH assistant provenance boundary', async () => {
  const fixture = await createHostFixture({ override: true })
  try {
    let state
    for (let n = 0; n < 5; n++) {
      state = await (await fetch(`${fixture.origin}/api/dsh-prompt-prediction/state?sessionId=review-session`)).json()
      if (state.status === 'ready') break
    }
    assert.equal(state.status, 'ready')
    const request = fixture.requests[0]
    const assistant = request.messages.find(message => message.role === 'assistant')
    assert.equal(assistant.id, 'a1')
    assert.deepEqual(assistant.source, { kind: 'model', provider: 'original', model: 'original-model' })
    assert.equal(request.tools, undefined)
    assert.equal(request.toolHistory, undefined)
  } finally { await fixture.close() }
})
