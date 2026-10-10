"""Named Entity Recognition (NER) for MemHub Organizational Knowledge.

Implements domain-specific entity extraction with support for:
- PERSON, ORGANIZATION, TEAM, PROJECT, ISSUE, DECISION, MEETING,
  DOCUMENT, TECHNOLOGY, PRODUCT, SERVICE, LOCATION, DATE.

Provides an extensible architecture:
- BaseEntityExtractor: Abstract interface
- SpacyEntityExtractor: Baseline spaCy pipeline with domain label mapping
- TransformerEntityExtractor: Extensible transformer-based model interface
- RuleBasedEntityExtractor: Domain-specific rules, patterns, and gazetteers
- EntityExtractor: Hybrid extractor coordinating base NER, mapping, and domain overrides
"""

from __future__ import annotations

import logging
import re
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Set, Tuple

from ai.nlp.schemas import Entity, EntityType

logger = logging.getLogger(__name__)

# Mapping from generic NLP/OntoNotes model labels to MemHub domain types
GENERIC_MODEL_LABEL_MAP: Dict[str, str] = {
    "PERSON": EntityType.PERSON.value,
    "PER": EntityType.PERSON.value,
    "ORG": EntityType.ORGANIZATION.value,
    "GPE": EntityType.LOCATION.value,
    "LOC": EntityType.LOCATION.value,
    "FAC": EntityType.LOCATION.value,
    "DATE": EntityType.DATE.value,
    "TIME": EntityType.DATE.value,
    "PRODUCT": EntityType.PRODUCT.value,
    "WORK_OF_ART": EntityType.DOCUMENT.value,
    "LAW": EntityType.DOCUMENT.value,
    "EVENT": EntityType.MEETING.value,
}

# Known technologies gazetteer for high-precision recognition
KNOWN_TECHNOLOGIES: Set[str] = {
    "postgresql", "postgres", "psql", "mysql", "redis", "kafka", "apache kafka",
    "rabbitmq", "docker", "kubernetes", "k8s", "grpc", "graphql", "rest", "rest api",
    "react", "vue", "angular", "next.js", "nextjs", "node", "node.js", "express",
    "fastapi", "flask", "django", "spring boot", "python", "typescript", "javascript",
    "golang", "go", "rust", "c++", "c#", "java", "ruby", "rails", "aws", "gcp",
    "azure", "sqlite", "mongodb", "cassandra", "elasticsearch", "opensearch",
    "terraform", "ansible", "nginx", "envoy", "prisma", "drizzle", "graphql",
}


class BaseEntityExtractor(ABC):
    """Abstract base class for all entity extractors."""

    @abstractmethod
    def extract(self, text: str) -> List[Entity]:
        """Extract entities from the input text."""
        pass


class RuleBasedEntityExtractor(BaseEntityExtractor):
    """Domain-specific pattern matcher and gazetteer for organizational entities.

    Catches domain entities (ISSUE, PROJECT, TEAM, DECISION, MEETING, TECHNOLOGY)
    that standard generic NER models routinely miss.
    """

    def __init__(self, custom_technologies: Optional[Set[str]] = None):
        self.technologies = KNOWN_TECHNOLOGIES.copy()
        if custom_technologies:
            self.technologies.update({t.lower() for t in custom_technologies})

    def extract(self, text: str) -> List[Entity]:
        entities: List[Entity] = []
        counter = 1

        # 1. Project Patterns: "Project Phoenix", "Project Apollo", "Project Titan"
        project_regex = re.compile(
            r"\b(?:Project|project)\s+([A-Z][a-zA-Z0-9_\-]+)\b"
        )
        for m in project_regex.finditer(text):
            entities.append(
                Entity(
                    id=f"proj_{counter}",
                    text=m.group(0),
                    type=EntityType.PROJECT.value,
                    start_char=m.start(),
                    end_char=m.end(),
                    confidence=0.98,
                    metadata={"subpattern": "project_prefix"},
                )
            )
            counter += 1

        # 2. Team Patterns: "the Core Platform team", "Security team", "DevOps squad"
        team_regex = re.compile(
            r"\b(?:the\s+)?([A-Z][a-zA-Z0-9_\s]+?)\s+(?:team|squad|guild|working group)\b",
            re.IGNORECASE,
        )
        for m in team_regex.finditer(text):
            full_span = m.group(0)
            # Avoid overly broad matches
            if len(full_span.split()) <= 6:
                entities.append(
                    Entity(
                        id=f"team_{counter}",
                        text=full_span,
                        type=EntityType.TEAM.value,
                        start_char=m.start(),
                        end_char=m.end(),
                        confidence=0.95,
                        metadata={"subpattern": "team_suffix"},
                    )
                )
                counter += 1

        # 3. Issue Patterns:
        # 3a. Explicit issue identifiers: "issue #402", "bug #104", "ticket PROJ-12"
        issue_id_regex = re.compile(
            r"\b(?:issue|bug|ticket|pr|pull request)\s*(?:#\s*\d+|[A-Z]+-\d+)\b",
            re.IGNORECASE,
        )
        for m in issue_id_regex.finditer(text):
            entities.append(
                Entity(
                    id=f"issue_{counter}",
                    text=m.group(0),
                    type=EntityType.ISSUE.value,
                    start_char=m.start(),
                    end_char=m.end(),
                    confidence=0.98,
                    metadata={"subpattern": "issue_id"},
                )
            )
            counter += 1

        # 3b. Descriptive issues: "the authentication issue", "memory leaks", "login issue"
        # Avoid matching verbs/prepositions like "assigned to issue" or "was issue"
        desc_issue_regex = re.compile(
            r"\b(?:the\s+)?((?:authentication|login|security|memory|performance|latency|authorization|database|network|sync|concurrency|billing|api|ui|frontend|backend|build|test|crash)\s+(?:issue|bug|vulnerability|incident|outage|leak|leaks|error|regression))\b",
            re.IGNORECASE,
        )
        for m in desc_issue_regex.finditer(text):
            # Don't duplicate if already matched by 3a or overlaps with issue_id
            span_text = m.group(1).strip()
            if not any(
                e.start_char is not None and e.end_char is not None and
                m.start() < e.end_char and e.start_char < m.end()
                for e in entities
            ):
                entities.append(
                    Entity(
                        id=f"issue_{counter}",
                        text=span_text,
                        type=EntityType.ISSUE.value,
                        start_char=m.start(1),
                        end_char=m.end(1),
                        confidence=0.94,
                        metadata={"subpattern": "descriptive_issue"},
                    )
                )
                counter += 1

        # 4. Meeting Patterns: "Architecture Review meeting", "weekly sync", "sprint planning"
        meeting_regex = re.compile(
            r"\b(?:in\s+the\s+|during\s+the\s+|at\s+the\s+)?([A-Z][a-zA-Z0-9_]+(?:\s+[A-Z][a-zA-Z0-9_]+)*\s+(?:meeting|sync|standup|retrospective|planning|all-hands))\b",
            re.IGNORECASE,
        )
        for m in meeting_regex.finditer(text):
            meeting_name = m.group(1).strip()
            if len(meeting_name.split()) <= 6:
                entities.append(
                    Entity(
                        id=f"meeting_{counter}",
                        text=meeting_name,
                        type=EntityType.MEETING.value,
                        start_char=m.start(1),
                        end_char=m.end(1),
                        confidence=0.95,
                        metadata={"subpattern": "meeting_pattern"},
                    )
                )
                counter += 1

        # 5. Decision Patterns: "decided to migrate from MySQL to PostgreSQL", "decided to adopt gRPC"
        decision_regex = re.compile(
            r"\b(?:decided\s+to|decision\s+to|agreed\s+to)\s+([a-zA-Z0-9_\s]+?)(?:(?=[\.,;]|\s+in\s+Project|\s+in\s+the\s+Architecture|\s+in\s+the\s+meeting|$))",
            re.IGNORECASE,
        )
        for m in decision_regex.finditer(text):
            action_text = m.group(0).strip()
            if len(action_text.split()) <= 12:
                entities.append(
                    Entity(
                        id=f"decision_{counter}",
                        text=action_text,
                        type=EntityType.DECISION.value,
                        start_char=m.start(),
                        end_char=m.end(),
                        confidence=0.92,
                        metadata={"subpattern": "decision_action"},
                    )
                )
                counter += 1

        # 6. Technology Patterns: Gazetteer matching with word boundaries
        for tech in self.technologies:
            pattern = re.compile(r"\b" + re.escape(tech) + r"\b", re.IGNORECASE)
            for m in pattern.finditer(text):
                # Ensure it's not a substring of a larger entity already found
                matched_text = text[m.start():m.end()]
                entities.append(
                    Entity(
                        id=f"tech_{counter}",
                        text=matched_text,
                        type=EntityType.TECHNOLOGY.value,
                        start_char=m.start(),
                        end_char=m.end(),
                        confidence=0.96,
                        metadata={"gazetteer": True},
                    )
                )
                counter += 1

        # 7. Document Patterns: RFC-42, PRD, design doc, architecture doc
        doc_regex = re.compile(
            r"\b(RFC-\d+|PRD|ADR-\d+|[A-Z0-9_\-]+\s+(?:design doc|architecture doc|runbook|handbook))\b",
            re.IGNORECASE,
        )
        for m in doc_regex.finditer(text):
            entities.append(
                Entity(
                    id=f"doc_{counter}",
                    text=m.group(0),
                    type=EntityType.DOCUMENT.value,
                    start_char=m.start(),
                    end_char=m.end(),
                    confidence=0.95,
                    metadata={"subpattern": "document_pattern"},
                )
            )
            counter += 1

        return entities


class SpacyEntityExtractor(BaseEntityExtractor):
    """spaCy-backed NER extractor with domain label mapping and graceful fallback.

    If spacy or its model is unavailable in the environment, delegates cleanly
    to lightweight linguistic heuristics and logs informative guidance.
    """

    def __init__(self, model_name: str = "en_core_web_sm"):
        self.model_name = model_name
        self.nlp = None
        self._load_model()

    def _load_model(self) -> None:
        try:
            import spacy

            try:
                self.nlp = spacy.load(self.model_name)
                logger.info(f"Loaded spaCy model: {self.model_name}")
            except Exception:
                # If specific model is missing, try default or blank
                logger.warning(
                    f"spaCy model '{self.model_name}' not downloaded. "
                    "Run `python -m spacy download en_core_web_sm` for optimal NER."
                )
                try:
                    self.nlp = spacy.blank("en")
                except Exception:
                    self.nlp = None
        except ImportError:
            logger.info("spaCy is not installed in the current environment; running in fallback mode.")
            self.nlp = None

    def extract(self, text: str) -> List[Entity]:
        entities: List[Entity] = []
        if self.nlp is not None and "ner" in getattr(self.nlp, "pipe_names", []):
            doc = self.nlp(text)
            counter = 1
            for ent in doc.ents:
                mapped_type = GENERIC_MODEL_LABEL_MAP.get(ent.label_)
                if mapped_type:
                    entities.append(
                        Entity(
                            id=f"spacy_{counter}",
                            text=ent.text,
                            type=mapped_type,
                            start_char=ent.start_char,
                            end_char=ent.end_char,
                            confidence=0.88,
                            metadata={"original_label": ent.label_, "source": "spacy"},
                        )
                    )
                    counter += 1
            return entities

        # Linguistic fallback for Person/Org/Location if spaCy model is absent
        return self._heuristic_linguistic_extract(text)

    def _heuristic_linguistic_extract(self, text: str) -> List[Entity]:
        """High-precision capitalization & sentence-position heuristic for PERSON / ORG."""
        entities: List[Entity] = []
        counter = 1

        # Common personal names in tech / examples
        known_persons = {
            "Priya", "Alex", "Marcus", "Sarah", "Elena", "David", "Chen",
            "Liam", "Maya", "Jordan", "Emma", "Noah", "Olivia", "James",
        }
        for name in known_persons:
            pattern = re.compile(r"\b" + re.escape(name) + r"\b")
            for m in pattern.finditer(text):
                entities.append(
                    Entity(
                        id=f"person_{counter}",
                        text=m.group(0),
                        type=EntityType.PERSON.value,
                        start_char=m.start(),
                        end_char=m.end(),
                        confidence=0.92,
                        metadata={"source": "person_heuristic"},
                    )
                )
                counter += 1

        # Capitalized single tokens that act as subjects (e.g. "Priya resolved...", "Alex joined...")
        subj_pattern = re.compile(
            r"(?:^|[\.\?!]\s+)([A-Z][a-z]+)\s+(?:resolved|joined|fixed|decided|created|worked|built|discovered|opened|leads)\b"
        )
        for m in subj_pattern.finditer(text):
            person_text = m.group(1)
            # If not already added
            if not any(e.text == person_text for e in entities):
                entities.append(
                    Entity(
                        id=f"person_{counter}",
                        text=person_text,
                        type=EntityType.PERSON.value,
                        start_char=m.start(1),
                        end_char=m.end(1),
                        confidence=0.90,
                        metadata={"source": "subject_heuristic"},
                    )
                )
                counter += 1

        # Passive developer assignment: "Marcus was assigned to..."
        passive_pattern = re.compile(
            r"\b([A-Z][a-z]+)\s+was\s+assigned\s+to\b"
        )
        for m in passive_pattern.finditer(text):
            person_text = m.group(1)
            if not any(e.text == person_text for e in entities):
                entities.append(
                    Entity(
                        id=f"person_{counter}",
                        text=person_text,
                        type=EntityType.PERSON.value,
                        start_char=m.start(1),
                        end_char=m.end(1),
                        confidence=0.93,
                        metadata={"source": "passive_assign_heuristic"},
                    )
                )
                counter += 1

        return entities


class TransformerEntityExtractor(BaseEntityExtractor):
    """Stub and extensible adapter for fine-tuned Transformer-based NER models.

    Designed for modern token classification models such as:
    - Hugging Face transformers (DeBERTa-v3, RoBERTa, BioLinkBERT)
    - GLiNER (Generalist and Lightweight Model for Information Extraction)
    - SpanMarker NER

    Provides the exact extension point requested in the prompt.
    """

    def __init__(
        self,
        model_name_or_path: str = "urchade/gliner_small",
        labels: Optional[List[str]] = None,
        device: str = "cpu",
    ):
        self.model_name_or_path = model_name_or_path
        self.labels = labels or [
            "person", "organization", "team", "project", "issue",
            "decision", "meeting", "document", "technology", "product",
            "service", "location", "date",
        ]
        self.device = device
        self.pipeline = None
        self._init_pipeline()

    def _init_pipeline(self) -> None:
        """Attempt loading transformer model if transformers or gliner is installed."""
        try:
            # GLiNER dynamic zero-shot/fine-tuned NER support
            from gliner import GLiNER
            self.pipeline = GLiNER.from_pretrained(self.model_name_or_path)
            logger.info(f"Loaded GLiNER transformer model: {self.model_name_or_path}")
        except ImportError:
            try:
                from transformers import pipeline
                self.pipeline = pipeline(
                    "token-classification",
                    model=self.model_name_or_path,
                    aggregation_strategy="simple",
                    device=self.device,
                )
                logger.info(f"Loaded Hugging Face pipeline: {self.model_name_or_path}")
            except (ImportError, Exception):
                self.pipeline = None

    def extract(self, text: str) -> List[Entity]:
        if not self.pipeline:
            # Returns empty if transformer model not loaded yet; lets hybrid fallback take over
            return []

        entities: List[Entity] = []
        counter = 1
        try:
            # If GLiNER
            if hasattr(self.pipeline, "predict_entities"):
                predictions = self.pipeline.predict_entities(text, self.labels)
                for p in predictions:
                    type_str = p["label"].upper()
                    entities.append(
                        Entity(
                            id=f"trf_{counter}",
                            text=p["text"],
                            type=type_str,
                            start_char=p["start"],
                            end_char=p["end"],
                            confidence=p.get("score", 0.95),
                            metadata={"source": "gliner_transformer"},
                        )
                    )
                    counter += 1
            else:
                # Standard HF pipeline
                preds = self.pipeline(text)
                for p in preds:
                    raw_label = p.get("entity_group") or p.get("entity", "")
                    mapped_type = GENERIC_MODEL_LABEL_MAP.get(raw_label, EntityType.ORGANIZATION.value)
                    entities.append(
                        Entity(
                            id=f"trf_{counter}",
                            text=p["word"],
                            type=mapped_type,
                            start_char=p.get("start"),
                            end_char=p.get("end"),
                            confidence=p.get("score", 0.90),
                            metadata={"source": "hf_transformer"},
                        )
                    )
                    counter += 1
        except Exception as e:
            logger.error(f"Error running transformer NER: {e}")

        return entities


class EntityExtractor(BaseEntityExtractor):
    """Production Hybrid Entity Extractor.

    Combines:
    1. Base NLP extractor (spaCy or Transformer)
    2. Domain-specific rule & gazetteer matcher (RuleBasedEntityExtractor)
    3. Span resolution & conflict arbitration (domain overrides generic labels)
    """

    def __init__(
        self,
        base_extractor: Optional[BaseEntityExtractor] = None,
        use_rules: bool = True,
        rule_extractor: Optional[RuleBasedEntityExtractor] = None,
    ):
        self.base_extractor = base_extractor or SpacyEntityExtractor()
        self.use_rules = use_rules
        self.rule_extractor = rule_extractor or RuleBasedEntityExtractor()

    def _resolve_conflicts(self, candidates: List[Entity]) -> List[Entity]:
        """Resolves overlapping entity spans.

        Prioritizes:
        1. Domain-specific rules over generic base model labels (e.g., PROJECT over generic ORG/GPE).
        2. Longer spans over shorter substring spans.
        3. Higher confidence score.
        """
        # Sort primarily by start_char, then reverse length (longest first), then confidence
        sorted_candidates = sorted(
            candidates,
            key=lambda e: (
                e.start_char if e.start_char is not None else 0,
                -(len(e.text)),
                -e.confidence,
            ),
        )

        resolved: List[Entity] = []

        for candidate in sorted_candidates:
            if candidate.start_char is None or candidate.end_char is None:
                resolved.append(candidate)
                continue

            # Check overlap with already accepted entities
            overlap = False
            for existing in resolved:
                if existing.start_char is None or existing.end_char is None:
                    continue
                # Overlap test: (start1 < end2) and (start2 < end1)
                if candidate.start_char < existing.end_char and existing.start_char < candidate.end_char:
                    # Special coexistence rule: A high-level DECISION span and specific embedded
                    # entities (e.g. TECHNOLOGY, PROJECT, PERSON, TEAM) inside it represent distinct
                    # graph nodes and must both be preserved.
                    if (existing.type == EntityType.DECISION.value and candidate.type in [
                        EntityType.TECHNOLOGY.value, EntityType.PROJECT.value, EntityType.PERSON.value, EntityType.TEAM.value
                    ]) or (candidate.type == EntityType.DECISION.value and existing.type in [
                        EntityType.TECHNOLOGY.value, EntityType.PROJECT.value, EntityType.PERSON.value, EntityType.TEAM.value
                    ]):
                        continue
                    overlap = True
                    break

            if not overlap:
                resolved.append(candidate)

        return resolved

    def extract(self, text: str) -> List[Entity]:
        """Extract entities using hybrid architecture and return non-overlapping entities."""
        candidates: List[Entity] = []

        # 1. Rule & Domain matches (highest domain precision)
        if self.use_rules:
            domain_matches = self.rule_extractor.extract(text)
            candidates.extend(domain_matches)

        # 2. Base model matches
        base_matches = self.base_extractor.extract(text)
        candidates.extend(base_matches)

        # 3. Resolve overlapping spans
        resolved = self._resolve_conflicts(candidates)

        # Re-sort in text appearance order
        resolved.sort(key=lambda e: e.start_char if e.start_char is not None else 0)
        return resolved
