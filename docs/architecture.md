# Architecture

```mermaid
flowchart TD
  A[CSV / JSON Sources] --> B[Validation]
  B --> C[Normalization]
  C --> D[Customer Deduplication]
  D --> E[(PostgreSQL)]
  E --> F[AI Conversation Extraction]
  E --> G[Catalog Enrichment]
  F --> H[Hybrid Priority Engine]
  G --> H
  H --> I[Advisor Assignment]
  I --> E
  E --> J[Next.js Dashboard]
```

## Core decision

The system separates **purchase propensity**, **conversation intent**, and **operational urgency**. The LLM is used for structured extraction from WhatsApp, not to invent the final priority score.

## Tenant isolation

`companyId` is a mandatory boundary in every commercial entity and query. A customer may have multiple leads inside the same company; leads are never merged across companies.
