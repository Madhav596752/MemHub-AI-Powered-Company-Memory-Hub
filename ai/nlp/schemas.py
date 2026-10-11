"""Schemas and data models for MemHub NLP extraction module.

Defines domain-specific entity types, relationship types, and graph-ready output models.
Compatible with standard Python 3.10+ dataclasses, with optional Pydantic v2 support.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class EntityType(str, Enum):
    """Supported entity categories within organizational memory."""

    PERSON = "PERSON"
    ORGANIZATION = "ORGANIZATION"
    TEAM = "TEAM"
    PROJECT = "PROJECT"
    ISSUE = "ISSUE"
    DECISION = "DECISION"
    MEETING = "MEETING"
    DOCUMENT = "DOCUMENT"
    TECHNOLOGY = "TECHNOLOGY"
    PRODUCT = "PRODUCT"
    SERVICE = "SERVICE"
    LOCATION = "LOCATION"
    DATE = "DATE"


class RelationType(str, Enum):
    """Semantic relationship types between organizational entities."""

    RESOLVED = "RESOLVED"
    WORKED_ON = "WORKED_ON"
    BELONGS_TO = "BELONGS_TO"
    CREATED = "CREATED"
    ASSIGNED_TO = "ASSIGNED_TO"
    DECIDED = "DECIDED"
    AFFECTED = "AFFECTED"
    PART_OF = "PART_OF"
    USED = "USED"
    DEPENDS_ON = "DEPENDS_ON"
    MIGRATED_TO = "MIGRATED_TO"
    MENTIONED_IN = "MENTIONED_IN"


@dataclass
class Entity:
    """Represents an extracted and normalized entity mention."""

    id: str
    text: str
    type: str  # EntityType value or string representation
    start_char: Optional[int] = None
    end_char: Optional[int] = None
    confidence: float = 1.0
    normalized: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self, minimal: bool = False) -> Dict[str, Any]:
        """Convert entity to a dictionary.

        Args:
            minimal: If True, returns only id, text, and type as per baseline specs.
        """
        if minimal:
            return {
                "id": self.id,
                "text": self.text,
                "type": self.type,
            }
        base = asdict(self)
        # Filter None values for clean payload
        return {k: v for k, v in base.items() if v is not None}


@dataclass
class Relation:
    """Represents a directed semantic relationship between two entities."""

    source: str  # ID of source entity
    relation: str  # RelationType value
    target: str  # ID of target entity
    confidence: float = 1.0
    evidence: Optional[str] = None
    trigger: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self, minimal: bool = False) -> Dict[str, Any]:
        """Convert relation to a dictionary.

        Args:
            minimal: If True, returns only source, relation, target.
        """
        if minimal:
            return {
                "source": self.source,
                "relation": self.relation,
                "target": self.target,
            }
        base = asdict(self)
        return {k: v for k, v in base.items() if v is not None}


@dataclass
class GraphReadyOutput:
    """Structured graph-ready payload for downstream Knowledge Graph ingestion."""

    document_id: str
    chunk_id: str
    entities: List[Entity] = field(default_factory=list)
    relationships: List[Relation] = field(default_factory=list)
    text: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self, minimal: bool = False) -> Dict[str, Any]:
        """Serialize into dictionary format ready for graph ingestion."""
        res: Dict[str, Any] = {
            "document_id": self.document_id,
            "chunk_id": self.chunk_id,
            "entities": [e.to_dict(minimal=minimal) for e in self.entities],
            "relationships": [r.to_dict(minimal=minimal) for r in self.relationships],
        }
        if not minimal:
            if self.text is not None:
                res["text"] = self.text
            if self.metadata:
                res["metadata"] = self.metadata
        return res

    def to_json(self, indent: int = 2, minimal: bool = False) -> str:
        """Serialize to formatted JSON string."""
        return json.dumps(self.to_dict(minimal=minimal), indent=indent, ensure_ascii=False)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> GraphReadyOutput:
        """Instantiate from dictionary."""
        entities = [
            Entity(
                id=e["id"],
                text=e["text"],
                type=e["type"],
                start_char=e.get("start_char"),
                end_char=e.get("end_char"),
                confidence=e.get("confidence", 1.0),
                normalized=e.get("normalized"),
                metadata=e.get("metadata", {}),
            )
            for e in data.get("entities", [])
        ]
        # Support both 'relationships' and 'relations' keys for flexibility
        raw_relations = data.get("relationships") or data.get("relations") or []
        relationships = [
            Relation(
                source=r["source"],
                relation=r["relation"],
                target=r["target"],
                confidence=r.get("confidence", 1.0),
                evidence=r.get("evidence"),
                trigger=r.get("trigger"),
                metadata=r.get("metadata", {}),
            )
            for r in raw_relations
        ]
        return cls(
            document_id=data.get("document_id", "doc_default"),
            chunk_id=data.get("chunk_id", "chunk_default"),
            entities=entities,
            relationships=relationships,
            text=data.get("text"),
            metadata=data.get("metadata", {}),
        )
