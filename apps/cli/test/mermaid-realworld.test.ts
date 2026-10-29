import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { renderMermaid } from "../src/view/mermaid"
import { parseFlowchart } from "../src/view/mermaid/flowchart"
import { textWidth } from "../src/view/wrap"

const text = (line: Line) => line.map((span) => span.text).join("")

function draw(source: string, width = 100): string[] {
  const result = renderMermaid(source, width)
  if (!("lines" in result)) throw new Error(`fell back (${result.note}) for:\n${source}`)
  return result.lines.map(text)
}

/** Every label must survive layout as one contiguous run: a label split or overwritten by an edge or a box means overlap. */
function expectIntact(lines: string[], labels: string[]) {
  const all = lines.join("\n")
  for (const label of labels) expect(all).toContain(label)
}

describe("F36 reported diagrams", () => {
  test("a forward-referenced node belongs to the subgraph containing its declaration", () => {
    const flow = parseFlowchart(['A[Laptop] --> B', 'subgraph VPS[Tu VPS]', 'B[Development]', 'end'], "TD")!
    expect(flow.groups?.get("B")).toBe("Tu VPS")
    const rows = draw('flowchart TD\nA[Laptop] --> B\nsubgraph VPS[Tu VPS]\nB[Development]\nend')
    expect(rows.findIndex((row) => row.includes("Tu VPS"))).toBeLessThan(rows.findIndex((row) => row.includes("Development")))
  })

  test("grouped connections stay near their endpoints instead of forming a trailing curtain", () => {
    const source = `flowchart TD
      A[Laptop] -->|SSH| B
      subgraph VPS[Tu VPS]
        B[Development]
        C[Credentials] -->|Authorized| B
        B --> D[Executor]
        E[Results] --> B
      end
      D --> F{Authorized?}
      F -->|Yes| G[Remote build]
      F -->|No| H[Local build]
      G --> E
      G --> I[Cleanup]
      I --> J[Finished]`
    for (const width of [72, 120, 160]) {
      const rows = draw(source, width)
      expectIntact(rows, ["Laptop", "Tu VPS", "Development", "Credentials", "Executor", "Results", "Remote build", "Local build", "Cleanup", "Finished", "SSH", "Authorized", "Yes", "No"])
      for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
      const lastNode = rows.findIndex((row) => row.includes("Finished"))
      expect(rows.length - lastNode).toBeLessThanOrEqual(5)
      expect(rows.findIndex((row) => row.includes("SSH"))).toBeLessThan(rows.findIndex((row) => row.includes("Development")))
    }
  })

  test("sequence with actor and a participant name containing a space", () => {
    const lines = draw(`sequenceDiagram
    actor Persona
    participant Editor
    participant Vista previa
    Persona->>Editor: Escribe texto Markdown
    Editor->>Vista previa: Interpreta el documento
    Vista previa-->>Persona: Muestra el resultado`)
    expectIntact(lines, ["Persona", "Editor", "Vista previa", "Escribe texto Markdown", "Interpreta el documento", "Muestra el resultado"])
    expect(lines.join("\n")).toContain("▶")
    expect(lines.join("\n")).toContain("◀┄")
  })

  test("aliases, autonumber, comments, title and init directives parse leniently", () => {
    const lines = draw(`%%{init: {"theme": "dark", "sequence": {"mirrorActors": false}}}%%
sequenceDiagram
    title Flujo de pago
    autonumber
    %% a comment
    participant A as Long Name
    participant B as Servicio de pagos
    A->>B: Hola
    B-->>A: Listo`)
    expectIntact(lines, ["Long Name", "Servicio de pagos", "1. Hola", "2. Listo"])
    expect(lines.join("\n")).not.toContain("participant")
  })

  test("every arrow form, box groups, create/destroy and the config suffix parse", () => {
    const lines = draw(`sequenceDiagram
    box Aqua Equipo
      participant A@{ "type": "database" }
      participant B as Bob
    end
    create participant C as Carla
    A->B: abierta
    A-->B: punteada abierta
    A-xB: cruz
    A--xB: cruz punteada
    A-)B: asincrona
    A<<->>B: bidireccional
    A->>+B: activa
    B-->>-A: responde
    destroy C`)
    expectIntact(lines, ["bidireccional", "asincrona", "cruz punteada", "Bob"])
  })

  test("a branch merge draws one joined arrow into the node", () => {
    const lines = draw(`flowchart TD
  A[Inicio] --> B{Valido?}
  B -->|Si| C[Guardar]
  B -->|No| D[Rechazar]
  C --> E[Fin]
  D --> E`)
    const fin = lines.findIndex((line) => line.includes("│ Fin │"))
    const arrowRows = lines.slice(0, fin).filter((line) => line.includes("▼"))
    expect(arrowRows.at(-1)!.match(/▼/g)).toHaveLength(1)
    expect(lines.join("\n").match(/▼/g)).toHaveLength(4)
    expect(lines.slice(fin - 4, fin).some((line) => /├─+┘|└─+┤|└─+┴─+┘/u.test(line))).toBe(true)
  })

  test("a class relation connector touches both boxes", () => {
    const lines = draw(`classDiagram
  class Documento
  class Diagrama
  Documento o-- Diagrama
  Documento : +titulo`)
    const row = lines.find((line) => line.includes("◇"))!
    expect(row).toMatch(/│◇─+│/u)
    const inheritance = draw("classDiagram\n  Animal <|-- Perro\n  Animal : +nombre").find((line) => line.includes("◁"))!
    expect(inheritance).toMatch(/│◁─+│/u)
    const association = draw("classDiagram\n  A --> B").find((line) => line.includes("▶"))!
    expect(association).toMatch(/│─+▶│/u)
  })
})

const realistic: Array<{ name: string; source: string; labels: string[] }> = [
  {
    name: "reported VPS build and cleanup flow",
    source: `flowchart TD
    A["Laptop ligera<br/>Terminal y editor remoto"] -->|"SSH cifrado"| B
    subgraph VPS["Tu VPS"]
        B["Usuario de desarrollo sin root<br/>MendCode + proyectos + Git"]
        C["Credenciales de proveedores<br/>y API de InstaBox"]
        D["Ejecutor de builds<br/>Cola: 1 trabajo simultáneo"]
        E["Resultados<br/>Artefactos + logs + estado"]
        P["TerraPredict: producción<br/>Fuera del entorno de desarrollo"]
        C -->|"Solo procesos autorizados"| B
        B --> D
        E --> B
    end
    D --> F{"¿Autorizaste enviar<br/>el código de este proyecto?"}
    F -->|"No"| G["Build en entorno confiable<br/>Con límites de CPU y RAM"]
    F -->|"Sí"| H["Preparar copia mínima<br/>Sin Git, claves ni datos reales"]
    H --> I["InstaBox temporal<br/>Código necesario + dependencias"]
    I --> J{"Resultado del build"}
    J -->|"Éxito"| K["Descargar artefactos<br/>Verificar integridad"]
    J -->|"Error o cancelación"| L["Recuperar diagnóstico<br/>Marcar trabajo fallido"]
    K --> E
    L --> E
    K --> M["Solicitar eliminación<br/>de la máquina temporal"]
    L --> M
    M --> N{"¿Eliminación confirmada?"}
    N -->|"Sí"| O["Cerrar trabajo"]
    N -->|"No"| Q["Avisar y dejar limpieza pendiente<br/>No declarar el entorno limpio"]`,
    labels: ["Laptop ligera", "Tu VPS", "MendCode", "Credenciales", "Ejecutor de builds", "Resultados", "TerraPredict", "SSH cifrado", "InstaBox temporal", "Cerrar trabajo"],
  },
  {
    name: "flowchart with subgraphs and decisions",
    source: `flowchart TD
  subgraph Cliente
    A[Usuario inicia sesión] --> B{¿Credenciales válidas?}
  end
  subgraph Servidor
    C[Generar token] --> D[(Base de datos)]
  end
  B -->|Sí| C
  B -->|No| E[Mostrar error]
  D --> F[Fin]
  E --> F`,
    labels: ["Cliente", "Servidor", "Usuario inicia sesión", "Credenciales válidas", "Generar token", "Base de datos", "Mostrar error", "Fin"],
  },
  {
    name: "sequence with alt and loop",
    source: `sequenceDiagram
    autonumber
    participant U as Usuario
    participant API as Servicio de Pagos
    participant DB as Base de datos
    U->>API: Solicitar cobro
    activate API
    loop Cada intento
        API->>DB: Consultar saldo
        DB-->>API: Saldo disponible
    end
    alt Saldo suficiente
        API-->>U: Cobro aprobado ✔
    else Saldo insuficiente
        API-->>U: Cobro rechazado
    end
    deactivate API`,
    labels: ["Usuario", "Servicio de Pagos", "Base de datos", "1. Solicitar cobro", "Cada intento", "Saldo suficiente", "Saldo insuficiente", "Cobro aprobado ✔"],
  },
  {
    name: "state diagram",
    source: `stateDiagram-v2
    [*] --> Pendiente
    Pendiente --> EnProceso: iniciar
    EnProceso --> Completado: terminar
    EnProceso --> Fallido: error
    Fallido --> Pendiente: reintentar
    Completado --> [*]`,
    labels: ["Pendiente", "EnProceso", "Completado", "Fallido", "iniciar", "terminar", "reintentar"],
  },
  {
    name: "entity relationship diagram",
    source: `erDiagram
    CLIENTE ||--o{ PEDIDO : realiza
    PEDIDO ||--|{ LINEA : contiene
    PRODUCTO ||--o{ LINEA : aparece
    CLIENTE {
        int id
        string nombre
    }`,
    labels: ["CLIENTE", "PEDIDO", "LINEA", "PRODUCTO", "nombre", "realiza", "contiene"],
  },
  {
    name: "gantt",
    source: `gantt
    title Plan de lanzamiento
    dateFormat YYYY-MM-DD
    section Diseño
    Investigación :a1, 2026-01-01, 10d
    Prototipo :after a1, 7d
    section Desarrollo
    Backend :2026-01-15, 20d`,
    labels: ["Plan de lanzamiento", "Diseño", "Investigación", "Prototipo", "Backend"],
  },
  {
    name: "pie",
    source: `pie title Ventas por región
    "Panamá" : 45
    "Colombia" : 30
    "México" : 25`,
    labels: ["Ventas por región", "Panamá", "Colombia", "México"],
  },
  {
    name: "mindmap",
    source: `mindmap
  root((Proyecto))
    Planificación
      Alcance
      Riesgos
    Ejecución
      Desarrollo
      Pruebas`,
    labels: ["Proyecto", "Planificación", "Alcance", "Riesgos", "Ejecución", "Desarrollo", "Pruebas"],
  },
  {
    name: "gitGraph",
    source: `gitGraph
   commit id: "inicio"
   branch funcionalidad
   checkout funcionalidad
   commit
   commit
   checkout main
   merge funcionalidad
   commit`,
    labels: ["main", "funcionalidad"],
  },
  {
    name: "user journey",
    source: `journey
    title Un día en la oficina
    section Mañana
      Llegar: 5: Yo
      Café: 4: Yo, Equipo
    section Tarde
      Reunión: 2: Equipo`,
    labels: ["Un día en la oficina", "Mañana", "Llegar", "Café", "Tarde", "Reunión"],
  },
  {
    name: "xychart",
    source: `xychart-beta
    title "Ventas mensuales"
    x-axis [ene, feb, mar, abr]
    y-axis "Unidades" 0 --> 100
    bar [20, 45, 60, 80]
    line [20, 45, 60, 80]`,
    labels: ["Ventas mensuales", "ene", "feb", "mar", "abr"],
  },
]

describe("realistic model-style diagrams", () => {
  for (const { name, source, labels } of realistic) {
    for (const width of [72, 120]) {
      test(`${name} renders without fallback within ${width} columns`, () => {
        const lines = draw(source, width)
        for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(width)
        expectIntact(lines, labels)
        if (name === "reported VPS build and cleanup flow") {
          const lastText = lines.findLastIndex((line) => /entorno limpio/.test(line))
          expect(lastText).toBeGreaterThan(0)
          expect(lines.length - lastText).toBeLessThanOrEqual(5)
          expect(lines.findIndex((line) => line.includes("Tu VPS"))).toBeLessThan(lines.findIndex((line) => line.includes("MendCode")))
        }
      })
    }
  }
})
