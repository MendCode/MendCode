const stages = ["Intake", "Identity", "Tenant", "Consent", "Catalog", "Inventory", "Pricing", "Discount", "Checkout", "Payment", "Fraud", "Ledger", "Fulfillment", "Shipping", "Receipt", "Analytics"]
const labels = ["Intake recepción 🌱", "Identity signed customer credentials", "Tenant regional workspace authorization", "Consent privacidad audit", "Catalog product availability", "Inventory warehouse reconciliation", "Pricing cross currency conversion", "Discount contractual eligibility", "Checkout durable order reservation", "Payment idempotent bank submission", "Fraud asynchronous risk scoring", "Ledger immutable double entry journal", "Fulfillment inventory allocation", "Shipping carrier delivery confirmation", "Receipt factura electrónica", "Analytics privacy preserving report"]
const links = stages.slice(1).map((id, index) => `${stages[index]} --> ${id}: accepted transition ${index + 1}`).join("\n")

export const largeMermaidFixtures = [
  {
    kind: "flowchart", count: 16, tokens: stages,
    source: `flowchart TD
subgraph Commerce[Commerce platform 🌱]
subgraph Frontend[Trusted storefront]
${stages.slice(0, 8).map((id, index) => `${id}["${labels[index]}"]`).join("\n")}
end
subgraph Backend[Settlement and delivery]
${stages.slice(8).map((id, index) => `${id}["${labels[index + 8]}"]`).join("\n")}
end
end
${stages.slice(1).map((id, index) => `${stages[index]} -->|accepted| ${id}`).join("\n")}`,
  },
  {
    kind: "sequence", count: 18, tokens: Array.from({ length: 18 }, (_, index) => `event${String(index + 1).padStart(2, "0")}`),
    source: `sequenceDiagram
actor Customer as Buyer 🌱
participant API as Orders API
participant Store as Durable ledger
participant Bank as Payment bank
autonumber
Customer->>API: event01 checkout with signed tenant context
activate API
API->>Store: event02 reserve inventory in Panamá
Store-->>API: event03 reservation persisted
loop Idempotent reconciliation while settlement is pending
API->>Bank: event04 authorize payment across regional boundary
alt Payment accepted
Bank-->>API: event05 signed authorization token
API->>Store: event06 append durable authorization receipt
else Deferred review
Bank-->>API: event07 pending fraud review
API->>Store: event08 persist asynchronous retry checkpoint
end
API->>Bank: event09 query settlement status
Bank-->>API: event10 authorized and confirmed
end
API->>Store: event11 allocate warehouse inventory
Store-->>API: event12 allocation committed
API->>Bank: event13 capture reserved payment
Bank-->>API: event14 capture reference reconciled
API->>Store: event15 attach immutable journal entry
Store-->>API: event16 order ready for delivery
API-->>Customer: event17 factura electrónica ready
deactivate API
Customer->>API: event18 request shipping confirmation`,
  },
  {
    kind: "class", count: 16, tokens: stages,
    source: `classDiagram
direction TB
namespace Commerce {
namespace Application {
${stages.slice(0, 8).map((id) => `class ${id} {\n+UUID tenantIdentifier\n+String descripción🌱\n+validateSignedContext()\n}`).join("\n")}
}
namespace Settlement {
${stages.slice(8).map((id) => `class ${id} {\n+UUID transactionIdentifier\n+String immutableAuditReference\n+reconcileRegionalOperation()\n}`).join("\n")}
}
}
${links}`,
  },
  {
    kind: "state", count: 16, tokens: stages,
    source: `stateDiagram-v2
direction TB
state "Commerce 🌱" as Commerce {
state "Storefront" as Frontend {
${stages.slice(0, 8).map((id, index) => `state "${labels[index]}" as ${id}`).join("\n")}
}
state "Settlement" as Backend {
${stages.slice(8).map((id, index) => `state "${labels[index + 8]}" as ${id}`).join("\n")}
}
${links}
}`,
  },
  {
    kind: "er", count: 16, tokens: stages,
    source: `erDiagram
${stages.map((id) => `${id} {\n uuid tenant_id PK\n string descripción\n string immutable_audit_reference\n}`).join("\n")}
${stages.slice(1).map((id, index) => `${stages[index]} ||--o{ ${id} : "regional relationship 🌱 ${index + 1}"`).join("\n")}`,
  },
  {
    kind: "gantt", count: 16, tokens: stages,
    source: `gantt
title Commerce delivery 🌱
dateFormat YYYY-MM-DD
excludes weekends
section Storefront
${stages.slice(0, 8).map((id, index) => `${labels[index]} : ${index === 0 ? "done," : ""}task${index},${index === 0 ? "2026-10-01" : `after task${index - 1}`},3d`).join("\n")}
section Settlement
${stages.slice(8).map((id, index) => `${labels[index + 8]} : ${index === 0 ? "crit," : ""}task${index + 8},after task${index + 7},2d`).join("\n")}`,
  },
  {
    kind: "mindmap", count: 18, tokens: stages,
    source: `mindmap
  root((Commerce 🌱))
    Storefront
${stages.slice(0, 8).map((id, index) => `${" ".repeat(index % 2 ? 8 : 6)}${labels[index]}`).join("\n")}
    Settlement
${stages.slice(8).map((id, index) => `${" ".repeat(index % 2 ? 8 : 6)}${labels[index + 8]}`).join("\n")}`,
  },
  {
    kind: "gitGraph", count: 18, tokens: stages,
    source: `gitGraph
commit id: "Intake recepción 🌱"
branch storefront
${stages.slice(1, 8).map((id, index) => `commit id: "${labels[index + 1]}"`).join("\n")}
checkout main
merge storefront
branch settlement
${stages.slice(8).map((id, index) => `commit id: "${labels[index + 8]}"`).join("\n")}
checkout main
merge settlement`,
  },
]
