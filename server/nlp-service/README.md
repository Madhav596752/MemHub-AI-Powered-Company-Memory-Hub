# MemHub NLP service (entity + relationship extraction)

Internal service used by the Express backend to build the knowledge graph. It wraps the teammate's
`ai/nlp` package (rule + gazetteer patterns on top of spaCy NER) behind a small HTTP API.

**What it is and is not.** There is no transformer, BiLSTM or trained model of our own here. Entities
come from spaCy NER (`en_core_web_sm`, if installed) plus regex/gazetteer rules; relationships come from
linguistic trigger patterns (e.g. "X resolved Y") and only exist when the sentence says so. Confidence
numbers are fixed per rule/pattern (e.g. 0.96), **not** calibrated probabilities.

## Run it

```bash
cd server/nlp-service
python -m venv .venv && . .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m spacy download en_core_web_sm                 # without it person detection is much weaker
NLP_SERVICE_TOKEN=<long random value> uvicorn app:app --host 127.0.0.1 --port 8002
```

Put the **same** `NLP_SERVICE_TOKEN` in `server/.env`. It must differ from `EMBEDDING_SERVICE_TOKEN`.
The service refuses to start without it. Keep it bound to `127.0.0.1`.

`GET /health` (no auth) reports `nerMode`: `spacy-ner` (model loaded) or `heuristic-fallback` (model missing).

## API

`POST /extract` with header `X-Internal-Token`:

```json
{ "documentId": "…", "chunks": [ { "chunkId": "<docId>:0", "chunkIndex": 0, "text": "…", "startChar": 0, "endChar": 812 } ] }
```

Limits (env): `NLP_MAX_CHUNKS` (100 per request), `NLP_MAX_CHUNK_CHARS` (5000). Invalid payloads get 422, a wrong token 401.
A chunk that crashes is reported in `failed` and does not fail the others. Chunk text is never logged.

Per chunk the answer is (entity ids like `entity_1` are **local to the chunk**):

```json
{ "documentId": "…", "chunkId": "…:0", "chunkIndex": 0,
  "entities": [ { "id": "entity_1", "text": "Priya", "type": "PERSON", "normalized": "Priya", "confidence": 0.88,
                  "startChar": 0, "endChar": 5, "documentStartChar": 0, "documentEndChar": 5 } ],
  "relationships": [ { "source": "entity_1", "target": "entity_2", "type": "RESOLVED", "confidence": 0.96,
                       "evidence": "Priya resolved the login issue", "trigger": "resolve/fix" } ],
  "metadata": { "pipeline": "memhub-nlp-v1-hybrid", "droppedEntities": 0, "droppedRelationships": 0 } }
```

`contract.py` drops anything unsupported: unknown types, relationships whose endpoints are missing or
identical, relationships whose evidence text is not really in the chunk, offsets outside the chunk.

## Changes to the teammate's code (`ai/nlp/entity_extractor.py`, marked `MEMHUB INTEGRATION`)

1. TEAM pattern ran case-insensitively and swallowed preceding words ("Yesterday the platform team"). Names must now be Capitalised.
   Consequence: lower-case team names ("the platform team") are no longer detected; "the team" still is.
2. Ambiguous gazetteer words (`go`, `rest`, `express`, `node`, `rails`, `envoy`, `react`, `rust`, `ruby`, `flask`) only match their exact spelling (`Go`, `REST`, …).
3. With a real spaCy model, first names like "Priya" are often missed; the subject/passive heuristics now also run next to the model (before, only without a model).
   With this change the teammate's own 8 tests pass with the real model (2 failed before).

## Relationship rules (how edges are found)

`relation_extractor.py` has two layers. The original per-pattern rules are kept. On top of them, offset-based
trigger rules look at the words **between** two entity spans in the same sentence and only emit a relationship
when those words are exactly a known trigger phrase (optionally with auxiliaries/adverbs such as "has been
working closely on"). They cover active and passive voice ("X was created by Y"), coordination ("Priya and Alex
worked on Project Apollo"), membership ("joined the Core Platform team"), usage/dependency, migration
("migrated from MySQL to PostgreSQL"), assignment, creation and "discussed in <meeting>". Negations ("did not
work on", "never resolved") and unrelated entities in one sentence produce **no** relationship. The evidence of
every relationship is the real slice of the chunk text. No model or LLM is involved; confidences are fixed per rule.

Sentence splitting no longer breaks after an initial ("R. De") or an abbreviation ("Dr.", "e.g.").

## Where the token comes from

`NLP_SERVICE_TOKEN` is taken from the terminal environment first; if it is not set there, the service reads
**only** that key (plus `NLP_MAX_CHUNKS`, `NLP_MAX_CHUNK_CHARS`) from `server/.env`. A 401 is logged with its reason
("header missing" or "does not match") and never prints either token.

## Tests

```bash
pip install pytest httpx
python -m pytest -q        # 20 tests: teammate's 8, 4 regression tests for the fixes, 8 service/contract tests
```
