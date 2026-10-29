/** Browser file editor. Reads and saves go through `file.edit` (server opt-in `--edit`); without it the pane is a read-only viewer over `/file`. */
export const WEB_EDITOR_CSS = String.raw`
#entries { display: flex; flex-wrap: wrap; gap: 6px; max-height: 24vh; overflow: auto } #entries button { text-align: left; overflow-wrap: anywhere }
#editor { flex: 1; min-height: 12em; width: 100%; resize: none; white-space: pre; overflow: auto; tab-size: 2 } #editor:disabled { opacity: .5 }
#path { flex: 1; min-width: 12ch } #fileNote { color: #9bb8a6 }
`

export const WEB_EDITOR_PANE = String.raw`<section id="pane-files" role="tabpanel" aria-labelledby="tab-files" hidden>
<header><h2>Files</h2><span id="editState"></span></header>
<form id="fileForm"><label for="path">Path</label><input id="path" maxlength="4096" autocomplete="off" spellcheck="false" disabled><button id="open" disabled>Open</button><button id="up" type="button" disabled>Up</button></form>
<div id="entries" aria-label="Directory"></div>
<textarea id="editor" aria-label="File contents" spellcheck="false" disabled></textarea>
<div id="fileActions"><button id="save" type="button" disabled>Save</button><button id="reload" type="button" disabled>Reload</button><span id="fileNote" role="status"></span></div></section>`

export const WEB_EDITOR_SCRIPT = String.raw`
let dirPath = '', filePath = '', fileSha = null, editable = false, dirty = false, listed = false
const editorDirty = () => dirty
const fileNote = (text) => { el('fileNote').textContent = text || '' }
function editMark() { el('editState').textContent = filePath ? filePath + (dirty ? ' (unsaved)' : '') : '' }
function setEditor(text, canEdit) {
  const editor = el('editor')
  editor.value = text; editor.readOnly = !canEdit; editor.disabled = false
  editable = canEdit; dirty = false
  el('save').disabled = true; el('reload').disabled = false; el('path').value = filePath; editMark()
}
async function listDir(target) {
  const nodes = await rest('GET', '/file?path=' + encodeURIComponent(target))
  dirPath = target; listed = true
  el('entries').replaceChildren()
  for (const item of nodes) el('entries').append(node('button', item.name + (item.type === 'directory' ? '/' : ''), { type: 'button', onclick: () => (item.type === 'directory' ? listDir(item.path) : openFile(item.path)).catch(error) }))
  if (!nodes.length) el('entries').append(node('span', 'Empty directory'))
}
async function openFile(target, discard) {
  if (dirty && !discard) throw new Error('Unsaved changes: save or reload first')
  if (!target) throw new Error('Enter a file path')
  let edit
  try { edit = await call({ type: 'file.edit', directory, input: { operation: 'read', path: target } }) } catch (problem) { if (!/disabled/.test(problem.message)) throw problem }
  filePath = target
  if (edit) { setEditor(edit.content, true); fileSha = edit.sha256; fileNote(edit.sha256 === null ? 'New file: Save creates it' : ''); return }
  const content = await rest('GET', '/file/content?path=' + encodeURIComponent(target))
  fileSha = null
  setEditor(content.type === 'text' && content.encoding !== 'base64' ? content.content : '', false)
  fileNote(content.type === 'binary' ? 'Binary file' : content.encoding === 'base64' ? 'Image file (not shown)' : 'Read-only: start the server with --edit to save')
}
async function saveFile() {
  if (!editable || !filePath || !dirty) return
  const result = await call({ type: 'file.edit', directory, input: { operation: 'write', path: filePath, content: el('editor').value, expected: fileSha } })
  fileSha = result.sha256; dirty = false; el('save').disabled = true; editMark(); fileNote('Saved ' + result.bytes + ' bytes')
  void listDir(dirPath).catch(() => {})
}
function editorReset() {
  dirPath = ''; filePath = ''; fileSha = null; editable = false; dirty = false; listed = false
  el('editor').value = ''; el('editor').disabled = true; el('save').disabled = true; el('reload').disabled = true
  el('entries').replaceChildren(); el('path').value = ''; editMark(); fileNote()
}
function editorConnected() { for (const name of ['path', 'open', 'up']) el(name).disabled = readOnly }
function filesShown() { if (token && !readOnly && !listed) listDir(dirPath).catch((problem) => { listed = false; error(problem) }) }
el('fileForm').onsubmit = (event) => { event.preventDefault(); openFile(el('path').value.trim()).catch(error) }
el('up').onclick = () => listDir(dirPath.split('/').slice(0, -1).join('/')).catch(error)
el('save').onclick = () => saveFile().catch((problem) => { error(problem); fileNote('Not saved') })
el('reload').onclick = () => { if (filePath) openFile(filePath, true).catch(error) }
el('editor').oninput = () => { if (!editable) return; dirty = true; el('save').disabled = false; editMark(); fileNote() }
el('editor').onkeydown = (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); el('save').onclick() } }
`
