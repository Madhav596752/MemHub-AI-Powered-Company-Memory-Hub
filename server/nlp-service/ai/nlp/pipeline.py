"""MemHub NLP Knowledge Pipeline.

Orchestrates entity extraction, normalization, relation extraction,
and produces structured graph-ready output for the Knowledge Graph.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from ai.nlp.entity_extractor import BaseEntityExtractor, EntityExtractor
from ai.nlp.normalizer import EntityNormalizer
from ai.nlp.relation_extractor import BaseRelationExtractor, RelationExtractor
from ai.nlp.schemas import GraphReadyOutput

logger = logging.getLogger(__name__)


class NLPKnowledgePipeline:
    """End-to-end NLP pipeline for organizational entity and relation extraction."""

    def __init__(
        self,
        entity_extractor: Optional[BaseEntityExtractor] = None,
        normalizer: Optional[EntityNormalizer] = None,
        relation_extractor: Optional[BaseRelationExtractor] = None,
        confidence_threshold: float = 0.65,
    ):
        self.entity_extractor = entity_extractor or EntityExtractor()
        self.normalizer = normalizer or EntityNormalizer()
        self.relation_extractor = relation_extractor or RelationExtractor(
            confidence_threshold=confidence_threshold
        )

    def process_chunk(
        self,
        text: str,
        document_id: str = "doc_1",
        chunk_id: str = "chunk_1",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> GraphReadyOutput:
        """Processes a single text chunk and produces graph-ready entities and relationships.

        Args:
            text: Input text content (e.g. documentation, pull request description, ticket, slack message).
            document_id: Identifier of the parent document.
            chunk_id: Identifier of this specific chunk.
            metadata: Optional additional contextual attributes.

        Returns:
            GraphReadyOutput containing entities and relationships.
        """
        if not text or not text.strip():
            return GraphReadyOutput(
                document_id=document_id,
                chunk_id=chunk_id,
                entities=[],
                relationships=[],
                text=text,
                metadata=metadata or {},
            )

        # 1. Entity Extraction
        raw_entities = self.entity_extractor.extract(text)

        # 2. Entity Normalization & Stable ID Assignment
        normalized_entities = self.normalizer.normalize_and_deduplicate(
            raw_entities, assign_sequential_ids=True, prefix="entity"
        )

        # 3. Relation Extraction based strictly on linguistic evidence
        relationships = self.relation_extractor.extract(text, normalized_entities)

        # 4. Construct GraphReadyOutput
        output_metadata = {
            **(metadata or {}),
            "num_entities": len(normalized_entities),
            "num_relationships": len(relationships),
            "model_pipeline": "memhub-nlp-v1-hybrid",
        }

        return GraphReadyOutput(
            document_id=document_id,
            chunk_id=chunk_id,
            entities=normalized_entities,
            relationships=relationships,
            text=text,
            metadata=output_metadata,
        )

    def process_document(
        self,
        text: str,
        document_id: str = "doc_1",
        chunk_size: int = 1000,
    ) -> List[GraphReadyOutput]:
        """Splits a longer document into paragraphs or chunks and extracts knowledge graphs."""
        paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
        if not paragraphs:
            paragraphs = [text.strip()]

        outputs: List[GraphReadyOutput] = []
        for idx, para in enumerate(paragraphs, start=1):
            chunk_id = f"chunk_{idx}"
            chunk_output = self.process_chunk(
                text=para,
                document_id=document_id,
                chunk_id=chunk_id,
                metadata={"paragraph_index": idx},
            )
            outputs.append(chunk_output)

        return outputs


def create_pipeline(confidence_threshold: float = 0.65) -> NLPKnowledgePipeline:
    """Factory function to instantiate the default production pipeline."""
    return NLPKnowledgePipeline(confidence_threshold=confidence_threshold)
