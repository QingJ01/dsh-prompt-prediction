// Real Chromium + React DOM regression check. No production dependencies.
// Download React 18 UMD files to /tmp/pp-review-browser/{react,react-dom}.js first.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostFixture } from './support/dsh-runtime.mjs'
import { realInputBundle, realInputLoader, realInputSetup } from './support/real-input-browser.mjs'

const assets = '/tmp/pp-review-browser'
let html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
body{margin:0;background:#141414;color:#eee;font:18px Arial,sans-serif;padding:48px}
[data-composer-card]{position:relative;background:#2a2a2a;border-radius:24px;padding:24px;max-width:980px}
.grow{position:relative;min-height:64px} [contenteditable]{outline:none;line-height:28px;min-height:56px}
p{margin:0} [data-composer-placeholder]{position:absolute;top:0;left:0;color:#777;pointer-events:none;line-height:28px}
.tools{margin-top:24px;display:flex;justify-content:space-between;color:#bbb}button{background:transparent;color:inherit;border:0;font:inherit}
</style><style data-plugin-css="dsh-prompt-prediction/style">/* existing stylesheet from an older client */</style><div data-composer-card><div id="overlay"></div><div class="grow"><div data-composer-input contenteditable="true" data-phase="plain" data-placeholder="发消息或创建任务 / 调用指令，@ 文件或其它"><p><br></p></div><div data-composer-placeholder aria-hidden="true">发消息或创建任务 / 调用指令，@ 文件或其它</div></div><div class="tools"><button id="toolbar">＋　完全权限</button><span>GPT-6.1-Sol</span></div></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.feedback=[];window.inserts=[];window.predictionText='这条建议很长，用于验证窄窗口时只占一行，不会挤进下面的工具栏，也不会覆盖 Tab 提示。';
let plugin;window.__ModuleLoader__={load:r=>{plugin=r.factory(n=>{if(n==='react')return React;throw Error(n)})}};
</script><script src="/client.js"></script><script>
let Component;plugin.apply({slots:{inject:(_,fn)=>fn(),register:(_,c)=>{Component=c}}});
let state={draft:'',draftRev:0,attachmentIds:[],phase:'plain',occurrences:[],queue:[]};const listeners=new Set();
window.changeDraft=(draft)=>{state={...state,draft,draftRev:state.draftRev+1};const e=document.querySelector('[contenteditable]');e.textContent=draft;if(!draft)e.innerHTML='<p><br></p>';for(const f of listeners)f()};
const inputActions={captureInsertion:()=>({draftRev:state.draftRev}),insertText:(text,span)=>{if(state.draft!==''||span.draftRev!==state.draftRev)return false;inserts.push(text);changeDraft(text);return true}};
window.fetch=async(url,init)=>{if(String(url).includes('/feedback')){feedback.push(JSON.parse(init.body));return {ok:true}};const id=new URL(url,location.href).searchParams.get('sessionId');if(window.delayNext){window.delayNext=false;await new Promise(r=>window.releasePoll=r)};return {ok:true,json:async()=>({rev:3,status:'ready',turnSeq:42,text:id==='other'?'另一个会话的预测':predictionText})}};
function useInput(select){return select(React.useSyncExternalStore(cb=>{listeners.add(cb);return()=>listeners.delete(cb)},()=>state))}
let reviewSession={running:false,removed:false,openState:'open'},reviewPlan;
const lifecycleSubscribers=new Set();
const subscribeLifecycle=fn=>{lifecycleSubscribers.add(fn);return()=>lifecycleSubscribers.delete(fn)};
function useSession(select){return select(React.useSyncExternalStore(subscribeLifecycle,()=>reviewSession))}
function useProjection(_key,select){return select(React.useSyncExternalStore(subscribeLifecycle,()=>reviewPlan))}
window.setBusy=running=>{reviewSession={...reviewSession,running};for(const fn of lifecycleSubscribers)fn()};
window.setPlan=active=>{reviewPlan={active,pending:false};for(const fn of lifecycleSubscribers)fn()};
let sessionId='first';const root=ReactDOM.createRoot(document.getElementById('overlay'));
window.render=()=>ReactDOM.flushSync(()=>root.render(React.createElement(Component,{sessionId,useInput,inputActions,useSession,useProjection})));
window.setSession=id=>{sessionId=id;render()};window.unmount=()=>ReactDOM.flushSync(()=>root.unmount());render();
</script></html>`
const integrated = process.argv.includes('--integrated')
let hostFixture
if (integrated) {
  hostFixture = await createHostFixture({ suggestionText: '这条建议很长，用于验证窄窗口时只占一行，不会挤进下面的工具栏，也不会覆盖 Tab 提示。' })
  const loaderStart = html.indexOf('let plugin;')
  const loaderEnd = html.indexOf('</script><script src="/client.js">', loaderStart)
  html = html.slice(0, loaderStart) + 'let plugin;'+realInputLoader + html.slice(loaderEnd)
  html = html.replace('<script src="/client.js">', '<script src="/real-input.js"></script><script src="/client.js">')
  const setupStart = html.indexOf('let state={')
  const setupEnd = html.indexOf('let reviewSession=', setupStart)
  html = html.slice(0,setupStart) + realInputSetup + `
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async(url,init)=>{
    if(String(url).includes('/state')&&window.delayNext){window.delayNext=false;await new Promise(r=>window.releasePoll=r)}
    const response=await nativeFetch(url,init);
    if(String(url).includes('/feedback'))feedback.push({...JSON.parse(init.body),serverStatus:response.status});
    return response;
  };
  ` + html.slice(setupEnd)
}
html = html.replace('<script src="/react.js">','<script>window.pageErrors=[];window.addEventListener("error",e=>pageErrors.push(e.message));</script><script src="/react.js">')
const files = {
  '/react.js': await readFile(join(assets, 'react.js')),
  '/react-dom.js': await readFile(join(assets, 'react-dom.js')),
  '/client.js': await readFile(new URL('../lib/client.js', import.meta.url)),
  ...(integrated ? { '/real-input.js': realInputBundle() } : {}),
}
const server = createServer(async (req, res) => {
  if (hostFixture && req.url.startsWith('/api/')) {
    try { await hostFixture.runtime.bridge(req, res, hostFixture.handler, { principal: { kind: 'owner' } }) }
    catch(error) { res.writeHead(500);res.end(String(error)) }
    return
  }
  res.setHeader('content-type', req.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript')
  res.end(req.url === '/' ? html : files[req.url] ?? '')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const profile = await mkdtemp(join(tmpdir(), 'pp-review-chrome-'))
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let ws
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Chrome CDP startup timed out')), 20000)
    let output = ''
    chrome.stderr.on('data', chunk => {
      output += chunk
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
    chrome.once('error', reject)
  })
  ws = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let serial = 0
  const pending = new Map()
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    const request = pending.get(message.id)
    if (request) { pending.delete(message.id); message.error ? request.reject(message.error) : request.resolve(message.result) }
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++serial
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const command = (method, params) => send(method, params, sessionId)
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const waitFor = async expression => {
    for (let n = 0; n < 100; n++) {
      if (await evaluate(expression)) return
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw Error(`Timed out: ${expression}; page errors: ${JSON.stringify(await evaluate("window.pageErrors"))}`)
  }
  await command('Page.enable')
  await command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 370, deviceScaleFactor: 1, mobile: false })
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
  await waitFor(`!!document.querySelector('[data-dsh-prediction="ghost"]')`)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-composer-placeholder]')).visibility`), 'hidden')
  assert.equal(await evaluate(`document.querySelector('[contenteditable]').getAttribute('data-placeholder')`), '发消息或创建任务 / 调用指令，@ 文件或其它')
  // Reproduce the original CSS assumption: hiding only editor ::before leaves
  // DraftEditor's actual sibling placeholder visible. This must fail visually.
  assert.equal(await evaluate(`(()=>{const c=document.querySelector('[data-composer-card]');c.removeAttribute('data-dsh-pp-active');const v=getComputedStyle(document.querySelector('[data-composer-placeholder]')).visibility;c.setAttribute('data-dsh-pp-active','');return v})()`), 'visible')
  const assertHintAlignment = async () => {
    const delta = await evaluate(`(()=>{const g=document.querySelector('[data-dsh-prediction="ghost"]');const text=g.firstElementChild.getBoundingClientRect();const hint=g.lastElementChild.getBoundingClientRect();return Math.abs((text.top+text.bottom)/2-(hint.top+hint.bottom)/2)})()`)
    assert.ok(delta <= 1, `Tab hint must be vertically centered on the text line, delta=${delta}px`)
  }
  await assertHintAlignment()
  const out = new URL('../artifacts/review/', import.meta.url)
  await mkdir(out, { recursive: true })
  await writeFile(new URL('ghost-fixed.png', out), Buffer.from((await command('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await command('Emulation.setDeviceMetricsOverride', { width: 420, height: 370, deviceScaleFactor: 1, mobile: false })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await evaluate(`(()=>{const g=document.querySelector('[data-dsh-prediction="ghost"]');const b=g.getBoundingClientRect();const t=document.querySelector('.tools').getBoundingClientRect();const hint=g.lastElementChild.getBoundingClientRect();return b.height<=parseFloat(getComputedStyle(g).lineHeight)+1&&b.bottom<=t.top&&b.right<=innerWidth&&hint.right<=b.right+1})()`), true)
  await assertHintAlignment()
  await writeFile(new URL('ghost-narrow.png', out), Buffer.from((await command('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  // The native placeholder must stay suppressed even if React replaces it.
  await evaluate(`{const p=document.querySelector('[data-composer-placeholder]');p.replaceWith(p.cloneNode(true))}`)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-composer-placeholder]')).visibility`), 'hidden')
  // Local session events must hide the old ghost immediately, not after polling.
  if (integrated) hostFixture.startTurn('first')
  await evaluate('setBusy(true)')
  await waitFor(`!document.querySelector('[data-dsh-prediction="ghost"]')`)
  if (integrated) hostFixture.endTurn('first')
  await evaluate('setBusy(false)')
  await waitFor(`!!document.querySelector('[data-dsh-prediction="ghost"]')`)
  await evaluate('setPlan(true)')
  await waitFor(`!document.querySelector('[data-dsh-prediction="ghost"]')`)
  await evaluate('setPlan(false)')
  await waitFor(`!!document.querySelector('[data-dsh-prediction="ghost"]')`)
  // Respect focus traversal, and another handler's preventDefault.
  await evaluate(`document.getElementById('toolbar').focus()`)
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  assert.equal(await evaluate('inserts.length'), 0)
  await evaluate(`document.querySelector('[contenteditable]').focus();window.preventOnce=e=>e.preventDefault();window.addEventListener('keydown',preventOnce,true)`)
  // A handler registered later cannot preempt window capture; use a pre-cancelled event.
  await evaluate(`{const e=new KeyboardEvent('keydown',{key:'Tab',cancelable:true,bubbles:true});e.preventDefault();document.querySelector('[contenteditable]').dispatchEvent(e);window.removeEventListener('keydown',preventOnce,true)}`)
  assert.equal(await evaluate('inserts.length'), 0)
  await evaluate(`{const m=document.createElement('div');m.setAttribute('role','listbox');m.style.height='100px';m.id='review-menu';document.querySelector('[data-composer-card]').appendChild(m)}`)
  await waitFor(`!document.querySelector('[data-dsh-prediction="ghost"]')`)
  assert.equal(await evaluate(`document.querySelector('[data-composer-card]').hasAttribute('data-dsh-pp-active')`), false)
  await evaluate(`document.getElementById('review-menu').remove();document.querySelector('[contenteditable]').focus()`)
  await waitFor(`!!document.querySelector('[data-dsh-prediction="ghost"]')`)
  await evaluate(`document.querySelector('[contenteditable]').dispatchEvent(new KeyboardEvent('keydown',{key:'Process',keyCode:229,bubbles:true}))`)
  await waitFor(`!document.querySelector('[data-dsh-prediction="ghost"]')`)
  await waitFor(`!!document.querySelector('[data-dsh-prediction="ghost"]')`)
  // IME must hide ghost and restore the actual placeholder before text publishes.
  await evaluate(`document.querySelector('[contenteditable]').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))`)
  await waitFor(`!document.querySelector('[data-dsh-prediction="ghost"]')`)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-composer-placeholder]')).visibility`), 'visible')
  await evaluate(`document.querySelector('[contenteditable]').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`)
  await waitFor(`!!document.querySelector('[data-dsh-prediction="ghost"]')`)
  // Changing sessions must never paint the old snapshot, including equal revisions.
  await evaluate(`delayNext=true;setSession('other')`)
  assert.equal(await evaluate(`!!document.querySelector('[data-dsh-prediction="ghost"]')`), false)
  await evaluate('releasePoll()')
  await waitFor(`document.querySelector('[data-dsh-prediction="ghost"]')?.textContent.includes('另一个会话')`)
  if (integrated) {
    await evaluate(`document.querySelector('[contenteditable]').focus()`)
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    assert.equal(await evaluate('sent.length'), 0)
    assert.equal(await evaluate('inserts.length'), 0, 'Enter does not accept an empty ghost')
  }
  // A genuine CDP key event must call insertion once, keep it a draft and restore placeholder.
  await evaluate(`document.querySelector('[contenteditable]').focus()`)
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await waitFor('inserts.length===1')
  assert.equal(await evaluate(`document.querySelector('[contenteditable]').textContent`), '另一个会话的预测')
  await waitFor(`feedback.filter(x=>x.action==='accepted').length===1`)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-composer-placeholder]')).visibility`), 'visible')
  await evaluate(`changeDraft('')`)
  await waitFor(`!!document.querySelector('[data-dsh-prediction="ghost"]')`)
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await waitFor('inserts.length===2')
  await waitFor(`feedback.filter(x=>x.action==='accepted').length===2`)
  if (integrated) {
    assert.equal(await evaluate(`feedback.filter(x=>x.action==='accepted').every(x=>x.serverStatus===200)`), true)
    assert.equal(await evaluate('sent.length'), 0, 'acceptance never submits')
    await evaluate('undoDraft()')
    await waitFor("realShell.snapshot.draft===''")
    await evaluate('redoDraft()')
    await waitFor("realShell.snapshot.draft==='另一个会话的预测'")
    assert.equal(await evaluate(`(()=>{const span=realShell.actions.captureInsertion();changeDraft('用户的新输入');return realShell.actions.insertText('不能覆盖',span)})()`), false)
    assert.equal(await evaluate('realShell.snapshot.draft'), '用户的新输入')
    // Enter still reaches the real DSH keymap and normal submission path.
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    assert.equal(await evaluate('sent.length'), 1)
  }
  // Whitespace is user input, not an empty draft.
  await evaluate(`changeDraft(' ')`)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(await evaluate(`!!document.querySelector('[data-dsh-prediction="ghost"]')`), false)
  await evaluate(`changeDraft('')`)
  await waitFor(`!!document.querySelector('[data-dsh-prediction="ghost"]')`)
  await evaluate(`document.querySelector('[contenteditable]').setAttribute('aria-disabled','true')`)
  await waitFor(`!document.querySelector('[data-dsh-prediction="ghost"]')`)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-composer-placeholder]')).visibility`), 'visible')
  await evaluate(`document.querySelector('[contenteditable]').removeAttribute('aria-disabled')`)
  await waitFor(`!!document.querySelector('[data-dsh-prediction="ghost"]')`)
  await evaluate('unmount()')
  assert.equal(await evaluate(`document.querySelector('[data-composer-card]').hasAttribute('data-dsh-pp-active')`), false)
  console.log((integrated ? 'INTEGRATED real DSH HTTP + adapter boundary + Lexical + input actions: ' : '') + 'PASS: real Chromium/React DOM stylesheet update, placeholder, narrow layout, replacement, IME, session isolation, Tab/ArrowRight draft insertion, whitespace, disabled state and cleanup')
} finally {
  ws?.close()
  chrome.kill('SIGTERM')
  await new Promise(resolve => server.close(resolve))
  await hostFixture?.close()
}
