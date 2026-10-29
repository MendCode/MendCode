export type AcpRegistryEntry = {
  id: string
  name: string
  command: string
  args: string[]
  install: string
  website: string
  installed: boolean
  configured: boolean
}

export type AcpRegistryReport = { agents: AcpRegistryEntry[] }
