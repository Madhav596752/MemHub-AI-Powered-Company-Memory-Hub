# MemHub NLP Module 3: Entity & Relationship Extraction

This module implements **Module 3** of the MemHub AI/NLP system. It transforms unstructured organizational text (e.g., Slack threads, engineering PRDs, Jira/GitHub tickets, meeting transcripts, and RFC documents) into structured, graph-ready entities and semantic relationships suitable for downstream Knowledge Graph construction.

---

## 1. Scope & Design Philosophy

As specified for Module 3:
- **In Scope**:
  1. Named Entity Recognition (NER) with domain-specific mapping.
  2. Entity Normalization (canonical naming, alias mapping, deduplication).
  3. Relationship Extraction (strictly grounded on linguistic evidence).
  4. Graph-Ready JSON Output (for backend Knowledge Graph ingestion).
- **Out of Scope (Explicitly Excluded)**:
  - React UI / Frontend components
  - Graph visualization
  - Database persistence
  - RAG / Vector search
  - LLM question answering
  - Authentication & REST API endpoints

---

## 2. Project Structure

```
ai/
└── nlp/
    ├── __init__.py               # Package root
    ├── schemas.py                # Dataclasses & Enums for Entities, Relations, GraphReadyOutput
    ├── entity_extractor.py       # Hybrid NER (Base, spaCy adapter, Transformer stub, Domain matcher)
    ├── normalizer.py             # Canonicalization, alias resolution, stable entity IDs
    ├── relation_extractor.py     # Linguistic predicate & dependency relation extractor
    ├── pipeline.py               # End-to-end NLP orchestration pipeline
    ├── requirements.txt          # Module Python dependencies
    ├── README.md                 # Architecture, spaCy limitations & transformer upgrade guide
    └── tests/
        ├── __init__.py
        └── test_pipeline.py      # Comprehensive test suite covering all 6 required scenarios
```

---

## 3. Supported Entity & Relationship Types

### Entity Types (`EntityType`)
| Entity Type | Description | Examples |
|---|---|---|
| `PERSON` | Engineers, managers, stakeholders | Priya, Alex, Marcus |
| `ORGANIZATION` | External or parent companies | Google, Stripe, AWS |
| `TEAM` | Internal engineering or product groups | Core Platform team, Security squad |
| `PROJECT` | Internal initiatives and repositories | Project Phoenix, Project Apollo, Project Titan |
| `ISSUE` | Bugs, incidents, tickets, PRs | authentication issue, issue #402, memory leak |
| `DECISION` | Architectural or process decisions | decided to migrate to PostgreSQL, ADR-004 |
| `MEETING` | Synchronous discussions, reviews | Architecture Review meeting, weekly sync |
| `DOCUMENT` | Specifications, PRDs, RFCs | RFC-42, PRD, architecture doc |
| `TECHNOLOGY` | Frameworks, languages, databases, infra | PostgreSQL, Redis, Kafka, gRPC, Docker |
| `PRODUCT` | Customer-facing products | MemHub, Cloud SQL |
| `SERVICE` | Microservices, internal APIs | Auth Service, Billing Worker |
| `LOCATION` | Offices, datacenters, cities | San Francisco, us-east-1 |
| `DATE` | Timestamps, calendar dates | October 8, 2026, 2026-10-08 |

### Relationship Types (`RelationType`)
| Relationship | Typical Source $\to$ Target | Linguistic Trigger / Evidence |
|---|---|---|
| `RESOLVED` | `PERSON` / `TEAM` $\to$ `ISSUE` | resolved, fixed, closed, patched, addressed |
| `WORKED_ON` | `PERSON` $\to$ `PROJECT` / `ISSUE` | joined, works on, contributes to, developed |
| `BELONGS_TO` | `ISSUE` $\to$ `PROJECT` | in Project X, for Project Y, part of |
| `CREATED` | `PERSON` $\to$ `DOCUMENT` / `ISSUE` | authored, created, wrote, filed, opened |
| `ASSIGNED_TO` | `PERSON` $\to$ `ISSUE` | assigned to, owns, tasked with |
| `DECIDED` | `TEAM` / `PERSON` $\to$ `DECISION` | decided to, agreed to, approved |
| `AFFECTED` | `DECISION` / `ISSUE` $\to$ `PROJECT` | affected, impacted, disrupted, delayed |
| `PART_OF` | `PROJECT` / `TEAM` $\to$ `ORGANIZATION` | part of, module of, sub-team of |
| `USED` | `PROJECT` / `SERVICE` $\to$ `TECHNOLOGY` | uses, built with, adopted, employs |
| `DEPENDS_ON` | `PROJECT` / `SERVICE` $\to$ `TECHNOLOGY` | depends on, relies on, connects to |
| `MIGRATED_TO` | `TECHNOLOGY` $\to$ `TECHNOLOGY` | migrated from X to Y, upgraded to |
| `MENTIONED_IN` | `DECISION` / `ISSUE` $\to$ `MEETING` | discussed in meeting, reviewed in sync |

---

## 4. Limitations of Generic spaCy NER for Organizational Memory

While `spaCy` (`en_core_web_sm` / `en_core_web_trf`) provides a fast baseline, off-the-shelf NER has severe limitations for technical corporate text:

1. **OntoNotes 5.0 Dataset Bias**:
   - Pretrained spaCy models are trained on OntoNotes 5.0 (newswire, broadcast news, telephone conversations).
   - They have no understanding of software development lifecycle (SDLC) taxonomy.
2. **Missing Domain Categories**:
   - Generic models completely lack labels for `ISSUE`, `DECISION`, `TEAM`, `MEETING`, and `DOCUMENT`.
3. **Severe Label Misclassification**:
   - `PostgreSQL`, `Kafka`, `Redis` are often mislabeled as `ORG` (Organization).
   - `Project Phoenix` is misclassified as `PRODUCT` or split into `GPE` ("Phoenix" as a city).
   - `Core Platform team` is either tagged as `ORG` or truncated to just "Platform" or missed entirely.
   - Ticket identifiers like `issue #402` or `bug PROJ-99` are often tagged as `MONEY` or `CARDINAL`.
   - Descriptive issues like `the authentication issue` or `memory leaks` are parsed as generic noun phrases and completely ignored by NER.
4. **Boundary Truncation**:
   - Compound technical phrases (e.g. `Architecture Review meeting`) get fragmented into `EVENT` or isolated noun chunks.

### How Module 3 Overcomes These Limitations:
1. **Domain Mapping Layer**: Generic model labels (`PERSON`, `ORG`, `GPE`, `DATE`) are translated into MemHub's ontology via `GENERIC_MODEL_LABEL_MAP`.
2. **Domain-Specific Pattern & Gazetteer Engine**: High-precision regex engines and technical gazetteers extract `ISSUE`, `DECISION`, `MEETING`, `PROJECT`, `TEAM`, and `TECHNOLOGY`.
3. **Conflict Arbitration**: The `_resolve_conflicts` method in `EntityExtractor` prioritizes specific technical spans over generic OntoNotes spans, while preserving embedded entity nodes (e.g. keeping `MySQL` and `PostgreSQL` technologies intact even when part of a high-level `DECISION` clause).

---

## 5. Upgrade Path: Transformer-Based Fine-Tuning

To transition from the hybrid heuristic baseline to a state-of-the-art neural information extraction system:

### Recommended Architecture Options:
1. **GLiNER (Generalist and Lightweight Model for Information Extraction)**:
   - Uses bidirectional encoder representations with arbitrary label prompts.
   - Can extract MemHub's custom entity types (`PROJECT`, `ISSUE`, `DECISION`, `MEETING`, `TECHNOLOGY`) zero-shot and few-shot without fixed label heads.
2. **SpanMarker NER (fine-tuned on DeBERTa-v3-base)**:
   - State-of-the-art span-level classification that excels at overlapping and multi-token boundary detection.
3. **Joint Entity & Relation Extraction (e.g., REBEL or UniRel)**:
   - Employs autoregressive sequence-to-sequence or bipartite matching to extract triplets $(s, r, o)$ directly from input sentences.

### How to Activate the Transformer Extractor:
The module already includes `TransformerEntityExtractor` in `ai/nlp/entity_extractor.py`:

```python
from ai.nlp.entity_extractor import TransformerEntityExtractor, EntityExtractor
from ai.nlp.pipeline import NLPKnowledgePipeline

# Instantiate fine-tuned transformer model (Hugging Face / GLiNER)
transformer_backend = TransformerEntityExtractor(
    model_name_or_path="memhub/deberta-v3-enterprise-ner",
    labels=["PERSON", "TEAM", "PROJECT", "ISSUE", "DECISION", "TECHNOLOGY", "MEETING"]
)

# Inject into pipeline
pipeline = NLPKnowledgePipeline(
    entity_extractor=EntityExtractor(base_extractor=transformer_backend)
)
```

---

## 6. Graph-Ready Output Schema

Every extraction returns a `GraphReadyOutput` object conforming to:

```json
{
  "document_id": "doc_2026_q3_retro",
  "chunk_id": "chunk_004",
  "entities": [
    {
      "id": "entity_1",
      "text": "Priya",
      "type": "PERSON"
    },
    {
      "id": "entity_2",
      "text": "authentication issue",
      "type": "ISSUE"
    },
    {
      "id": "entity_3",
      "text": "Project Phoenix",
      "type": "PROJECT"
    }
  ],
  "relationships": [
    {
      "source": "entity_1",
      "relation": "RESOLVED",
      "target": "entity_2"
    },
    {
      "source": "entity_2",
      "relation": "BELONGS_TO",
      "target": "entity_3"
    }
  ]
}
```

### Knowledge Graph Integration (Cypher / Neo4j Example):
Backend teammates can ingest this JSON directly:

```cypher
// Ingest entities as graph nodes
UNWIND $entities AS ent
MERGE (n:Entity {id: ent.id})
SET n.name = ent.text, n.type = ent.type;

// Ingest relationships as directed graph edges
UNWIND $relationships AS rel
MATCH (s:Entity {id: rel.source})
MATCH (t:Entity {id: rel.target})
CALL apoc.create.relationship(s, rel.relation, {}, t) YIELD rel AS r
RETURN count(r);
```

---

## 7. Quickstart & Verification

### Running the Test Suite
The test suite validates all 6 required scenarios, anti-hallucination guarantees, and canonical normalization:

```bash
# Run using Python's built-in test runner
python3 ai/nlp/tests/test_pipeline.py

# Or run with pytest (if installed)
pytest ai/nlp/tests/ -v
```

### Python API Usage

```python
from ai.nlp.pipeline import NLPKnowledgePipeline

pipeline = NLPKnowledgePipeline()

text = "Priya resolved the authentication issue in Project Phoenix."
result = self.pipeline.process_chunk(text, document_id="doc_1", chunk_id="chunk_1")

# Export as dictionary or JSON
graph_payload = result.to_dict(minimal=True)
print(result.to_json())
```
