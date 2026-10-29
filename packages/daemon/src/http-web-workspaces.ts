/** Browser workspace switcher: registered workspaces (`GET /experimental/workspace`) retarget every request with `x-mendcode-workspace`. */
export const WEB_WORKSPACES_BAR = String.raw`<label for="workspace">Workspace</label><select id="workspace" aria-label="Workspace" disabled></select>`

export const WEB_WORKSPACES_SCRIPT = String.raw`
let workspaceId = '', homeDirectory = '', workspaces = []
async function loadWorkspaces() {
  const select = el('workspace'); select.replaceChildren()
  select.append(node('option', 'Project', { value: '' }))
  workspaces = []
  try { workspaces = (await rest('GET', '/experimental/workspace')).workspaces || [] } catch (problem) { workspaces = [] }
  for (const item of workspaces) select.append(node('option', item.name, { value: item.id }))
  select.value = workspaceId; select.disabled = workspaces.length === 0
}
async function switchWorkspace() {
  const next = el('workspace').value
  if (next === workspaceId) return
  if (editorDirty()) { el('workspace').value = workspaceId; throw new Error('Save or reload the open file before switching workspace') }
  workspaceId = next
  const item = workspaces.find((candidate) => candidate.id === next)
  directory = item ? item.directory : homeDirectory
  clearConversation(); editorReset(); terminalReset()
  error()
  const sessions = await list(); if (sessions[0]) await select(sessions[0])
  if (!el('pane-files').hidden) filesShown()
}
function workspacesReset() { workspaceId = ''; workspaces = []; el('workspace').replaceChildren(); el('workspace').disabled = true }
el('workspace').onchange = () => switchWorkspace().catch(error)
`
