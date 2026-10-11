"""Relation Extractor for MemHub Knowledge Graph entities.

Extracts meaningful, high-precision relationships based strictly on linguistic evidence.
Prevents hallucination by requiring syntactic cues, trigger predicates, and domain-valid
entity type pairings.
"""

from __future__ import annotations

import logging
import re
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Tuple

from ai.nlp.schemas import Entity, EntityType, Relation, RelationType

logger = logging.getLogger(__name__)


class BaseRelationExtractor(ABC):
    """Abstract base class for relation extractors."""

    @abstractmethod
    def extract(self, text: str, entities: List[Entity]) -> List[Relation]:
        """Extract relations between the provided entities from the text."""
        pass


class RelationExtractor(BaseRelationExtractor):
    """Linguistic and pattern-grounded relation extraction engine."""

    def __init__(self, confidence_threshold: float = 0.65):
        self.confidence_threshold = confidence_threshold

    def _split_into_sentences(self, text: str) -> List[Tuple[str, int, int]]:
        """Splits text into sentences while tracking character offsets."""
        sentence_regex = re.compile(r"[^.!?]+[.!?]*", re.MULTILINE)
        sentences: List[Tuple[str, int, int]] = []
        for m in sentence_regex.finditer(text):
            s_text = m.group(0).strip()
            if s_text:
                sentences.append((s_text, m.start(), m.end()))
        if not sentences and text.strip():
            sentences.append((text.strip(), 0, len(text)))
        return sentences

    def _get_sentence_entities(
        self, entities: List[Entity], sent_start: int, sent_end: int
    ) -> List[Entity]:
        """Finds all entities located within a given sentence."""
        in_sent: List[Entity] = []
        for e in entities:
            if e.start_char is not None and e.end_char is not None:
                if e.start_char >= sent_start and e.end_char <= sent_end:
                    in_sent.append(e)
            else:
                in_sent.append(e)
        return in_sent

    def extract(self, text: str, entities: List[Entity]) -> List[Relation]:
        """Extract relations strictly supported by linguistic evidence in the text."""
        if len(entities) < 2:
            return []

        relations: List[Relation] = []
        sentences = self._split_into_sentences(text)

        for sent_text, sent_start, sent_end in sentences:
            sent_entities = self._get_sentence_entities(entities, sent_start, sent_end)
            if len(sent_entities) < 2:
                continue

            # Check relation candidates within this sentence
            found = self._extract_sentence_relations(sent_text, sent_entities)
            relations.extend(found)

        # Filter by confidence threshold
        filtered = [r for r in relations if r.confidence >= self.confidence_threshold]

        # Deduplicate relations by (source, relation, target)
        seen = set()
        deduped: List[Relation] = []
        for r in filtered:
            key = (r.source, r.relation, r.target)
            if key not in seen:
                seen.add(key)
                deduped.append(r)

        return deduped

    def _extract_sentence_relations(
        self, sentence: str, entities: List[Entity]
    ) -> List[Relation]:
        """Analyzes pairs of entities within a single sentence for linguistic predicates."""
        relations: List[Relation] = []

        # Map entities by type for quick lookup
        type_to_ents: Dict[str, List[Entity]] = {}
        for e in entities:
            type_to_ents.setdefault(e.type, []).append(e)

        # 1. RESOLVED (PERSON / TEAM -> RESOLVED -> ISSUE)
        # e.g., "Priya resolved the authentication issue"
        for resolver in type_to_ents.get(EntityType.PERSON.value, []) + type_to_ents.get(EntityType.TEAM.value, []):
            for issue in type_to_ents.get(EntityType.ISSUE.value, []):
                # Pattern: [Resolver] (resolved|fixed|closed|patched|solved) ... [Issue]
                resolved_pattern = re.compile(
                    re.escape(resolver.text)
                    + r"\s+(?:has\s+|had\s+)?(?:resolved|fixed|closed|patched|addressed|solved)\s+(?:the\s+|a\s+)?"
                    + re.escape(issue.text),
                    re.IGNORECASE,
                )
                m = resolved_pattern.search(sentence)
                if m:
                    relations.append(
                        Relation(
                            source=resolver.id,
                            relation=RelationType.RESOLVED.value,
                            target=issue.id,
                            confidence=0.96,
                            evidence=m.group(0),
                            trigger="resolve/fix",
                        )
                    )
                else:
                    # Passive: [Issue] was resolved by [Resolver]
                    passive_pattern = re.compile(
                        re.escape(issue.text)
                        + r"\s+was\s+(?:resolved|fixed|closed|patched)\s+by\s+"
                        + re.escape(resolver.text),
                        re.IGNORECASE,
                    )
                    pm = passive_pattern.search(sentence)
                    if pm:
                        relations.append(
                            Relation(
                                source=resolver.id,
                                relation=RelationType.RESOLVED.value,
                                target=issue.id,
                                confidence=0.95,
                                evidence=pm.group(0),
                                trigger="passive_resolve",
                            )
                        )

        # 2. BELONGS_TO: ISSUE in PROJECT
        # e.g., "the authentication issue in Project Phoenix"
        for issue in type_to_ents.get(EntityType.ISSUE.value, []):
            for project in type_to_ents.get(EntityType.PROJECT.value, []):
                in_project_pattern = re.compile(
                    re.escape(issue.text)
                    + r"\s+(?:in|for|of|belonging to|part of)\s+"
                    + re.escape(project.text),
                    re.IGNORECASE,
                )
                m = in_project_pattern.search(sentence)
                if m:
                    relations.append(
                        Relation(
                            source=issue.id,
                            relation=RelationType.BELONGS_TO.value,
                            target=project.id,
                            confidence=0.94,
                            evidence=m.group(0),
                            trigger="in/for_preposition",
                        )
                    )

        # 3. WORKED_ON: PERSON / TEAM -> WORKED_ON -> PROJECT / ISSUE
        # e.g., "Alex joined Project Apollo", "Sarah works on Project Titan"
        for worker in type_to_ents.get(EntityType.PERSON.value, []) + type_to_ents.get(EntityType.TEAM.value, []):
            for target in type_to_ents.get(EntityType.PROJECT.value, []) + type_to_ents.get(EntityType.ISSUE.value, []):
                worked_pattern = re.compile(
                    re.escape(worker.text)
                    + r"\s+(?:joined|works\s+on|working\s+on|worked\s+on|contributes\s+to|contributed\s+to|leads|leading)\s+"
                    + re.escape(target.text),
                    re.IGNORECASE,
                )
                m = worked_pattern.search(sentence)
                if m:
                    relations.append(
                        Relation(
                            source=worker.id,
                            relation=RelationType.WORKED_ON.value,
                            target=target.id,
                            confidence=0.92,
                            evidence=m.group(0),
                            trigger="work/join",
                        )
                    )

        # 4. ASSIGNED_TO:
        # e.g., "Marcus was assigned to issue #402" -> Marcus ASSIGNED_TO issue #402 (or vice versa)
        for person in type_to_ents.get(EntityType.PERSON.value, []):
            for item in type_to_ents.get(EntityType.ISSUE.value, []) + type_to_ents.get(EntityType.PROJECT.value, []):
                assign_pattern_1 = re.compile(
                    re.escape(person.text)
                    + r"\s+was\s+assigned\s+to\s+"
                    + re.escape(item.text),
                    re.IGNORECASE,
                )
                m1 = assign_pattern_1.search(sentence)
                if m1:
                    relations.append(
                        Relation(
                            source=person.id,
                            relation=RelationType.ASSIGNED_TO.value,
                            target=item.id,
                            confidence=0.95,
                            evidence=m1.group(0),
                            trigger="was_assigned_to",
                        )
                    )

                assign_pattern_2 = re.compile(
                    re.escape(item.text)
                    + r"\s+was\s+assigned\s+to\s+"
                    + re.escape(person.text),
                    re.IGNORECASE,
                )
                m2 = assign_pattern_2.search(sentence)
                if m2:
                    relations.append(
                        Relation(
                            source=person.id,
                            relation=RelationType.ASSIGNED_TO.value,
                            target=item.id,
                            confidence=0.95,
                            evidence=m2.group(0),
                            trigger="item_assigned_to_person",
                        )
                    )

        # 5. DECIDED: TEAM / PERSON / MEETING -> DECIDED -> DECISION
        # e.g., "The Core Platform team decided to migrate from MySQL to PostgreSQL"
        # e.g., "In the Architecture Review meeting, the team decided to adopt gRPC"
        for decision in type_to_ents.get(EntityType.DECISION.value, []):
            # Check TEAM or PERSON
            for decider in type_to_ents.get(EntityType.TEAM.value, []) + type_to_ents.get(EntityType.PERSON.value, []):
                decide_pattern = re.compile(
                    re.escape(decider.text)
                    + r"\s+(?:decided|agreed|opted|resolved|approved)\s+"
                    + re.escape(decision.text),
                    re.IGNORECASE,
                )
                # Also allow "team decided to..." when team entity text is "the Core Platform team"
                if decide_pattern.search(sentence) or (
                    decider.text in sentence and decision.text in sentence
                    and any(w in sentence for w in ["decided", "agreed", "opted", "approved"])
                ):
                    relations.append(
                        Relation(
                            source=decider.id,
                            relation=RelationType.DECIDED.value,
                            target=decision.id,
                            confidence=0.93,
                            evidence=sentence.strip(),
                            trigger="decide_predicate",
                        )
                    )

            # Check MEETING -> MENTIONED_IN or DECIDED
            for meeting in type_to_ents.get(EntityType.MEETING.value, []):
                if meeting.text in sentence and decision.text in sentence:
                    relations.append(
                        Relation(
                            source=decision.id,
                            relation=RelationType.MENTIONED_IN.value,
                            target=meeting.id,
                            confidence=0.88,
                            evidence=sentence.strip(),
                            trigger="meeting_context",
                        )
                    )

        # 6. USED: PROJECT / SERVICE -> USED -> TECHNOLOGY
        # e.g., "Project Titan uses Redis for caching"
        for subject in type_to_ents.get(EntityType.PROJECT.value, []) + type_to_ents.get(EntityType.SERVICE.value, []):
            for tech in type_to_ents.get(EntityType.TECHNOLOGY.value, []):
                used_pattern = re.compile(
                    re.escape(subject.text)
                    + r"(?:(?!\band\s+(?:depends|relies|connects|migrated)\b)[^.!?])*?\b(?:uses|used|using|utilizes|employs|adopted|built with)\s+(?:(?:for|as|the|a)\s+)?(?:[a-zA-Z0-9_\-]+\s+){0,3}?"
                    + re.escape(tech.text),
                    re.IGNORECASE,
                )
                m = used_pattern.search(sentence)
                if m:
                    relations.append(
                        Relation(
                            source=subject.id,
                            relation=RelationType.USED.value,
                            target=tech.id,
                            confidence=0.95,
                            evidence=m.group(0),
                            trigger="use_predicate",
                        )
                    )

        # 7. DEPENDS_ON: PROJECT / SERVICE -> DEPENDS_ON -> TECHNOLOGY / SERVICE
        # e.g., "Project Titan ... depends on Kafka"
        for subject in type_to_ents.get(EntityType.PROJECT.value, []) + type_to_ents.get(EntityType.SERVICE.value, []):
            for dep in type_to_ents.get(EntityType.TECHNOLOGY.value, []) + type_to_ents.get(EntityType.SERVICE.value, []):
                # Don't create self-dependencies
                if dep.id == subject.id:
                    continue
                dep_pattern = re.compile(
                    re.escape(subject.text)
                    + r"[^.!?]*?\b(?:depends on|relies on|connects to|requires)\s+(?:(?:on|to|for)\s+)?(?:[a-zA-Z0-9_\-]+\s+){0,3}?"
                    + re.escape(dep.text),
                    re.IGNORECASE,
                )
                m = dep_pattern.search(sentence)
                if m:
                    relations.append(
                        Relation(
                            source=subject.id,
                            relation=RelationType.DEPENDS_ON.value,
                            target=dep.id,
                            confidence=0.94,
                            evidence=m.group(0),
                            trigger="depends_on_predicate",
                        )
                    )

        # 8. MIGRATED_TO:
        # e.g., "migrate from MySQL to PostgreSQL" -> MySQL MIGRATED_TO PostgreSQL, or PROJECT/TEAM MIGRATED_TO TECH
        techs = type_to_ents.get(EntityType.TECHNOLOGY.value, [])
        if len(techs) >= 2:
            for i, source_tech in enumerate(techs):
                for target_tech in techs[i + 1 :]:
                    migrate_pattern = re.compile(
                        r"(?:migrate|migrating|transition|switch|upgrade)\s+from\s+"
                        + re.escape(source_tech.text)
                        + r"\s+to\s+"
                        + re.escape(target_tech.text),
                        re.IGNORECASE,
                    )
                    m = migrate_pattern.search(sentence)
                    if m:
                        relations.append(
                            Relation(
                                source=source_tech.id,
                                relation=RelationType.MIGRATED_TO.value,
                                target=target_tech.id,
                                confidence=0.96,
                                evidence=m.group(0),
                                trigger="migrate_from_to",
                            )
                        )

        # 9. AFFECTED: DECISION / ISSUE -> AFFECTED -> PROJECT / SERVICE
        for cause in type_to_ents.get(EntityType.DECISION.value, []) + type_to_ents.get(EntityType.ISSUE.value, []):
            for effect in type_to_ents.get(EntityType.PROJECT.value, []) + type_to_ents.get(EntityType.SERVICE.value, []):
                affect_pattern = re.compile(
                    re.escape(cause.text)
                    + r"[^.!?]*?\b(?:affected|impacted|disrupted|broke|delayed)\s+[^.!?]*?"
                    + re.escape(effect.text),
                    re.IGNORECASE,
                )
                m = affect_pattern.search(sentence)
                if m:
                    relations.append(
                        Relation(
                            source=cause.id,
                            relation=RelationType.AFFECTED.value,
                            target=effect.id,
                            confidence=0.91,
                            evidence=m.group(0),
                            trigger="affect_predicate",
                        )
                    )

        # 10. CREATED: PERSON -> CREATED -> DOCUMENT / ISSUE
        for creator in type_to_ents.get(EntityType.PERSON.value, []):
            for artifact in type_to_ents.get(EntityType.DOCUMENT.value, []) + type_to_ents.get(EntityType.ISSUE.value, []):
                create_pattern = re.compile(
                    re.escape(creator.text)
                    + r"\s+(?:created|authored|wrote|filed|opened|submitted|drafted)\s+"
                    + re.escape(artifact.text),
                    re.IGNORECASE,
                )
                m = create_pattern.search(sentence)
                if m:
                    relations.append(
                        Relation(
                            source=creator.id,
                            relation=RelationType.CREATED.value,
                            target=artifact.id,
                            confidence=0.95,
                            evidence=m.group(0),
                            trigger="create_predicate",
                        )
                    )

        return relations
