// Test-only access to the installed DSH's unmodified Lexical runtime, shell
// actions and keymap. No production modules or exports are changed.
import { readFileSync } from 'node:fs'
import { extractedRoot } from './dsh-runtime.mjs'

export function realComposerLayout() {
  const source = readFileSync(`${extractedRoot}/dsh-client-ui-conversation/lib/client.js`, 'utf8')
  const modules = {}
  for (const name of ['ConversationRoot', 'InputBar']) {
    const marker = `@deepseek-ai/dsh-client-ui-conversation/${name}.module.css`
    const markerIndex = source.indexOf(`"${marker}"`)
    if (markerIndex < 0) throw Error(`DSH layout module not found: ${name}`)
    const before = source.slice(0, markerIndex)
    const css = [...before.matchAll(/const css(?:\$\d+)? = ("(?:\\.|[^"\\])*");/gu)].at(-1)
    const classes = source.match(new RegExp(`var ${name}_module_css_default = (\\{[\\s\\S]*?\\n\\t\\t\\});`, 'u'))
    if (!before || !css || !classes) throw Error(`DSH layout module not found: ${name}`)
    modules[name] = { css: JSON.parse(css[1]), classes: JSON.parse(classes[1]) }
  }
  return modules
}

export function realInputBundle() {
  const source = readFileSync(`${extractedRoot}/dsh-client-ui-conversation/lib/client.js`, 'utf8')
  const end = source.indexOf('//#region lib/types/client/input/submission-analytics.js')
  if (end < 0) throw Error('DSH input shell boundary not found')
  const keymapStart = source.indexOf('function registerComposerKeymap(')
  const keymapEnd = source.indexOf('//#endregion', keymapStart)
  const composingStart = source.indexOf('function isComposingEvent(')
  const composingEnd = source.indexOf('\n\t\t}', composingStart) + 5
  const platformStart = source.indexOf('function isApplePlatform(')
  const platformEnd = source.indexOf('\n\t\t}', platformStart) + 5
  if (composingStart < 0 || composingEnd <= composingStart || keymapStart < 0 || keymapEnd < 0 || platformStart >= 0 && platformEnd <= platformStart) {
    throw Error('DSH composer keymap helpers not found')
  }
  const platformHelper = platformStart < 0 ? '' : `\n${source.slice(platformStart, platformEnd)}`
  return source.slice(0, end) + '\n' + source.slice(composingStart, composingEnd) + platformHelper + '\n' + source.slice(keymapStart, keymapEnd) + `
  exports.ReviewInputShell = SessionInputShell;
  exports.ReviewKeymap = registerComposerKeymap;
  exports.ReviewUndo = Qe$2;
  exports.ReviewRedo = Ze$2;
  return module.exports;
  }
});`
}

// Unrelated business services are inert in this isolated editor test. React,
// Lexical, DraftEditorRuntime and SessionInputShell are the real implementations.
export const realInputLoader = `
let dshInputRuntime;
const inert = new Proxy(function(){return inert},{get:(_,key)=>key===Symbol.toPrimitive?()=>'' : key==='prototype'?{}:inert});
const snapshotStore = initial => {
  let value=initial;const listeners=new Set();return {
    getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
    set:next=>{if(Object.is(value,next))return;value=next;for(const fn of listeners)fn()},
  };
};
window.__ModuleLoader__={load:r=>{
  if(r.id==='dsh-prompt-prediction'){plugin=r.factory(n=>{if(n==='react')return React;throw Error(n)});return}
  dshInputRuntime=r.factory(n=>{
    if(n==='react')return React;
    if(n==='react-dom')return ReactDOM;
    if(n==='react/jsx-runtime')return {jsx:(t,p)=>React.createElement(t,p),jsxs:(t,p)=>React.createElement(t,p),Fragment:React.Fragment};
    if(n==='@deepseek-ai/dsh-client-store')return {createSnapshotStore:snapshotStore};
    return inert;
  });
}};
`

export const realInputSetup = `
const shell = new dshInputRuntime.ReviewInputShell({});window.realShell=shell;
shell.editor.setRootElement(document.querySelector('[data-composer-input]'));
shell.actions.setDraft('');window.changeDraft=text=>shell.actions.setDraft(text);
const originalInsert=shell.actions.insertText;
const inputActions={...shell.actions,insertText:(text,span)=>{const applied=originalInsert(text,span);if(applied)inserts.push(text);return applied}};
window.sent=[];
const keymapOff=dshInputRuntime.ReviewKeymap(shell.editor,{
  arbitrate:()=>document.querySelector('[role="listbox"]')?'consumed':'pass',
  dismissPopup:()=>{},space:()=>false,canSubmit:()=>shell.snapshot.draft!=='',
  submit:()=>sent.push(shell.snapshot.draft),intakeFiles:()=>{},
  pasteText:text=>shell.actions.insertText(text,shell.actions.captureInsertion()),
});
window.undoDraft=()=>shell.editor.dispatchCommand(dshInputRuntime.ReviewUndo,undefined);
window.redoDraft=()=>shell.editor.dispatchCommand(dshInputRuntime.ReviewRedo,undefined);
function useInput(select){return select(React.useSyncExternalStore(shell.state.subscribe,shell.state.getSnapshot))}
`
