"""Entity Normalizer for MemHub Knowledge Graph entities.

Normalizes extracted entity surfaces into canonical forms, deduplicates entities,
and provides stable entity identifiers for graph node generation.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

from ai.nlp.schemas import Entity, EntityType

# Common aliases and technology normalization map
TECH_CANONICAL_MAP: Dict[str, str] = {
    "postgres": "PostgreSQL",
    "postgresql": "PostgreSQL",
    "psql": "PostgreSQL",
    "mysql": "MySQL",
    "redis": "Redis",
    "kafka": "Apache Kafka",
    "apache kafka": "Apache Kafka",
    "docker": "Docker",
    "k8s": "Kubernetes",
    "kubernetes": "Kubernetes",
    "grpc": "gRPC",
    "graphql": "GraphQL",
    "rest": "REST API",
    "rest api": "REST API",
    "react": "React",
    "next.js": "Next.js",
    "nextjs": "Next.js",
    "vue": "Vue.js",
    "python": "Python",
    "typescript": "TypeScript",
    "javascript": "JavaScript",
    "node": "Node.js",
    "node.js": "Node.js",
    "golang": "Go",
    "go": "Go",
    "aws": "Amazon Web Services",
    "gcp": "Google Cloud Platform",
    "azure": "Microsoft Azure",
    "git": "Git",
    "github": "GitHub",
    "sqlite": "SQLite",
    "mongodb": "MongoDB",
    "mongo": "MongoDB",
    "prisma": "Prisma ORM",
}


class EntityNormalizer:
    """Normalizes raw surface mentions and manages entity IDs."""

    def __init__(self, alias_map: Optional[Dict[str, str]] = None):
        self.alias_map = TECH_CANONICAL_MAP.copy()
        if alias_map:
            self.alias_map.update({k.lower(): v for k, v in alias_map.items()})

    def normalize_surface_text(self, text: str, entity_type: str) -> Tuple[str, Optional[str]]:
        """Cleans and extracts a canonical representation of an entity mention.

        Returns:
            Tuple of (cleaned_text, normalized_canonical_name)
        """
        cleaned = text.strip()

        # Remove trailing punctuation often captured by regex
        cleaned = re.sub(r"[,\.;:\?!]+$", "", cleaned).strip()

        # Handle specific types
        canonical: Optional[str] = None

        if entity_type == EntityType.TECHNOLOGY.value:
            lookup_key = cleaned.lower()
            canonical = self.alias_map.get(lookup_key, cleaned)

        elif entity_type == EntityType.ISSUE.value:
            # Strip leading "the "
            if cleaned.lower().startswith("the "):
                canonical = cleaned[4:].strip()
            else:
                canonical = cleaned
            # Check for issue number like issue #402
            m = re.search(r"(?:issue|bug|ticket|pr)\s*#?\s*(\d+|[A-Z]+-\d+)", cleaned, re.IGNORECASE)
            if m:
                canonical = f"Issue #{m.group(1)}"

        elif entity_type == EntityType.PROJECT.value:
            # Normalize "Project Phoenix" -> "Project Phoenix"
            # Strip leading "the "
            if cleaned.lower().startswith("the "):
                canonical = cleaned[4:].strip()
            else:
                canonical = cleaned

        elif entity_type == EntityType.TEAM.value:
            # "the Core Platform team" -> "Core Platform Team"
            cleaned_team = re.sub(r"^the\s+", "", cleaned, flags=re.IGNORECASE)
            parts = [w.capitalize() for w in cleaned_team.split()]
            canonical = " ".join(parts)

        elif entity_type == EntityType.DECISION.value:
            # "decided to migrate to PostgreSQL" -> "Migrate to PostgreSQL"
            match = re.search(r"(?:decided\s+to|decision\s+to|agreed\s+to)\s+(.*)", cleaned, re.IGNORECASE)
            if match:
                action = match.group(1).strip()
                canonical = action[0].upper() + action[1:] if action else cleaned
            else:
                canonical = cleaned

        elif entity_type == EntityType.PERSON.value:
            canonical = cleaned.strip()

        elif entity_type == EntityType.MEETING.value:
            cleaned_meeting = re.sub(r"^the\s+", "", cleaned, flags=re.IGNORECASE)
            canonical = cleaned_meeting.strip()

        else:
            canonical = cleaned

        return cleaned, canonical

    def normalize_and_deduplicate(
        self,
        entities: List[Entity],
        assign_sequential_ids: bool = True,
        prefix: str = "entity",
    ) -> List[Entity]:
        """Normalizes entities and assigns consistent entity IDs.

        If assign_sequential_ids is True, assigns entity_1, entity_2, etc.,
        while updating references consistently.
        """
        normalized_entities: List[Entity] = []
        counter = 1

        for ent in entities:
            cleaned, canonical = self.normalize_surface_text(ent.text, ent.type)
            ent_id = f"{prefix}_{counter}" if assign_sequential_ids else ent.id

            updated_ent = Entity(
                id=ent_id,
                text=cleaned,
                type=ent.type,
                start_char=ent.start_char,
                end_char=ent.end_char,
                confidence=round(ent.confidence, 3),
                normalized=canonical,
                metadata={
                    **ent.metadata,
                    "original_text": ent.text,
                    "canonical_name": canonical,
                },
            )
            normalized_entities.append(updated_ent)
            counter += 1

        return normalized_entities
