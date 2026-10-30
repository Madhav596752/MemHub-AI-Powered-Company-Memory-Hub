"""Adapts the teammate's GraphReadyOutput into MemHub's entity/relation contract.

The raw NLP output is NOT trusted as-is. Everything leaving this module has been checked:
  - entity types and relationship types are from the real enums (nothing invented),
  - every relationship points at two different entities that exist in the same chunk,
  - every relationship carries evidence text that really occurs in the chunk text,
  - offsets are kept only if they fit inside the chunk.

Entity ids ("entity_1") are LOCAL to one chunk. Node derives the global graph identity from
company + type + normalized name; this module never claims an id is globally unique.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from ai.nlp.schemas import EntityType, GraphReadyOutput, RelationType

ENTITY_TYPES = {e.value for e in EntityType}
RELATION_TYPES = {r.value for r in RelationType}
PIPELINE_NAME = "memhub-nlp-v1-hybrid"

MAX_TEXT_FIELD = 300  # entity text / normalized name
MAX_EVIDENCE = 500


def _squash(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().lower()


def _clip(value: Optional[str], limit: int) -> Optional[str]:
    if value is None:
        return None
    value = str(value).strip()
    return value[:limit] if value else None


def _valid_offsets(start: Any, end: Any, length: int) -> Optional[tuple]:
    if isinstance(start, bool) or isinstance(end, bool):
        return None
    if isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= length:
        return start, end
    return None


def _confidence(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value < 0 or value > 1:  # NaN or out of range
        return None
    return round(float(value), 3)


def build_chunk_result(output: GraphReadyOutput, chunk: Dict[str, Any], document_id: str) -> Dict[str, Any]:
    """chunk: {chunkId, chunkIndex, text, startChar?, endChar?} -> contract dict for one chunk."""
    text = chunk["text"]
    chunk_start = chunk.get("startChar")

    entities: List[Dict[str, Any]] = []
    kept_ids = set()
    dropped_entities = 0
    for ent in output.entities:
        etype = str(ent.type or "").upper()
        etext = _clip(ent.text, MAX_TEXT_FIELD)
        # A name needs at least two letters/digits: "R." or "-" are fragments, not entities.
        if etype not in ENTITY_TYPES or not etext or not ent.id or ent.id in kept_ids or sum(c.isalnum() for c in etext) < 2:
            dropped_entities += 1
            continue
        item: Dict[str, Any] = {
            "id": ent.id,
            "text": etext,
            "type": etype,
            "normalized": _clip(ent.normalized, MAX_TEXT_FIELD) or etext,
        }
        conf = _confidence(ent.confidence)
        if conf is not None:
            item["confidence"] = conf
        offsets = _valid_offsets(ent.start_char, ent.end_char, len(text))
        if offsets:
            item["startChar"], item["endChar"] = offsets  # relative to the chunk text
            if isinstance(chunk_start, int) and chunk_start >= 0:
                item["documentStartChar"] = chunk_start + offsets[0]  # relative to the document
                item["documentEndChar"] = chunk_start + offsets[1]
        kept_ids.add(ent.id)
        entities.append(item)

    haystack = _squash(text)
    relationships: List[Dict[str, Any]] = []
    dropped_relationships = 0
    seen = set()
    for rel in output.relationships:
        rtype = str(rel.relation or "").upper()
        evidence = _clip(rel.evidence, MAX_EVIDENCE)
        conf = _confidence(rel.confidence)
        key = (rel.source, rtype, rel.target)
        if (
            rtype not in RELATION_TYPES
            or rel.source not in kept_ids
            or rel.target not in kept_ids
            or rel.source == rel.target
            or not evidence
            or _squash(evidence) not in haystack  # evidence must really be in the chunk
            or conf is None
            or key in seen
        ):
            dropped_relationships += 1
            continue
        seen.add(key)
        relationships.append(
            {
                "source": rel.source,
                "target": rel.target,
                "type": rtype,
                "confidence": conf,
                "evidence": evidence,
                "trigger": _clip(rel.trigger, 60),
            }
        )

    return {
        "documentId": document_id,
        "chunkId": chunk["chunkId"],
        "chunkIndex": chunk["chunkIndex"],
        "entities": entities,
        "relationships": relationships,
        "metadata": {
            "pipeline": PIPELINE_NAME,
            "entityCount": len(entities),
            "relationshipCount": len(relationships),
            "droppedEntities": dropped_entities,
            "droppedRelationships": dropped_relationships,
        },
    }
