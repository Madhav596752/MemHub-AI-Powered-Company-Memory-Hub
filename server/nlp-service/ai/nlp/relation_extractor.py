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

# ---------------------------------------------------------------------------------------------
# MEMHUB INTEGRATION: sentence boundaries + offset-based trigger rules
# ---------------------------------------------------------------------------------------------
_BOUNDARY_RE = re.compile(
    r"(?P<punct>[.!?]+)[\"')\]]*\s+"
    r"|(?P<para>\n[ \t]*\n\s*|\n[ \t]*(?:[-*\u2022]|\d{1,2}[.)])[ \t]+)"
)
_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "eg", "ie",
    "inc", "ltd", "co", "corp", "no", "fig", "approx", "dept", "est", "al",
}

# words that may sit between the entities and the trigger verb without changing the meaning
_AUX = r"(?:(?:has|have|had|was|were|is|are|been|being|also|then|later|recently|previously|originally|actively|primarily|mainly|closely|currently|now|successfully|quickly|finally|already|officially)\s+)*"
_DET = r"(?:(?:the|a|an|our|its|their|this|that|new|latest|internal|custom|managed|legacy|main|primary|existing|same)\s+){0,2}"
_ADV = r"(?:(?:closely|actively|primarily|mainly|directly|mostly)\s+)?"
_PASSIVE_AUX = r"(?:(?:was|were|is|are|been|being|has been|have been|had been|also|later|originally|recently)\s+)+"

_PEOPLE = {"PERSON", "TEAM"}
_ACTORS = {"PERSON", "TEAM", "ORGANIZATION"}
_THINGS = {"PROJECT", "SERVICE", "PRODUCT"}

# (relation, trigger label, subject types, object types, regex for the text BETWEEN subject and object,
#  reverse?  True = the sentence is passive: the text order is object ... trigger ... subject,
#  confidence)
# Each rule only fires when the gap between the two entity spans is made of nothing but these words.
_RULES: List[Tuple[str, str, set, set, "re.Pattern[str]", bool, float]] = []


def _rule(relation, trigger, subj, obj, gap, reverse=False, confidence=0.9):
    _RULES.append((relation, trigger, set(subj), set(obj), re.compile(r"^\s*" + gap + r"\s*$", re.IGNORECASE), reverse, confidence))


_RESOLVE_V = r"(?:resolved|resolves|resolving|fixed|fixes|fixing|closed|closes|patched|patches|addressed|addresses|solved|solves)"
_RESOLVE_PP = r"(?:resolved|fixed|closed|patched|addressed|solved)"
_rule("RESOLVED", "resolve/fix", _PEOPLE, {"ISSUE"}, _AUX + _ADV + _RESOLVE_V + r"\s+" + _DET)
_rule("RESOLVED", "passive_resolve", _PEOPLE, {"ISSUE"}, _PASSIVE_AUX + _RESOLVE_PP + r"\s+by", True, 0.88)

_WORK_V = (
    r"(?:(?:works?|worked|working)\s+" + _ADV + r"on|contribut(?:es|ed|ing|e)\s+to|joined|joins|"
    r"leads?|led|leading|owns?|owned|manages?|managed|managing|maintains?|maintained|maintaining|drives?|drove|driving)"
)
_rule("WORKED_ON", "work/join", _PEOPLE, {"PROJECT", "ISSUE", "SERVICE", "PRODUCT"}, _AUX + _ADV + _WORK_V + r"\s+" + _DET)
_rule("ASSIGNED_TO", "was_assigned_to", {"PERSON"}, {"ISSUE", "PROJECT"}, _PASSIVE_AUX + r"assigned\s+to\s+" + _DET, False, 0.93)
_rule("ASSIGNED_TO", "item_assigned_to_person", {"PERSON"}, {"ISSUE", "PROJECT"}, _PASSIVE_AUX + r"assigned\s+to", True, 0.93)

_rule("PART_OF", "member_of", {"PERSON"}, {"TEAM", "ORGANIZATION"},
      _AUX + r"(?:joined|joins|(?:is|are|was|were)\s+(?:a\s+|an\s+)?(?:member|part)\s+of|belongs?\s+to|belonged\s+to|works?\s+(?:for|at|in)|worked\s+(?:for|at|in)|"
      r"(?:is|was)\s+on|(?:is|was)\s+(?:in|with))\s+" + _DET)
_rule("PART_OF", "part_of", {"TEAM", "PROJECT", "SERVICE", "PRODUCT"}, {"TEAM", "ORGANIZATION", "PROJECT", "PRODUCT"},
      _AUX + r"(?:part\s+of|a\s+part\s+of|a\s+component\s+of|a\s+module\s+of|belongs?\s+to|belonged\s+to)\s+" + _DET)
_rule("BELONGS_TO", "belongs_to", {"ISSUE"}, {"PROJECT", "SERVICE", "PRODUCT"},
      _AUX + r"(?:belongs?\s+to|belonged\s+to|part\s+of|a\s+part\s+of|tracked\s+(?:in|under)|filed\s+(?:against|in|under)|raised\s+(?:in|against))\s+" + _DET)

_CREATE_V = r"(?:created|creates|creating|authored|authors|wrote|writes|written|filed|files|opened|opens|submitted|submits|drafted|drafts|built|builds|developed|develops|designed|designs|launched|launches|introduced|reported|reports|raised|logged)"
_CREATE_PP = r"(?:created|authored|written|filed|opened|submitted|drafted|built|developed|designed|launched|introduced|reported|raised|logged)"
_rule("CREATED", "create_predicate", _ACTORS, {"DOCUMENT", "ISSUE", "PROJECT", "PRODUCT", "SERVICE"}, _AUX + _ADV + _CREATE_V + r"\s+" + _DET)
_rule("CREATED", "passive_create", _ACTORS, {"DOCUMENT", "ISSUE", "PROJECT", "PRODUCT", "SERVICE"}, _PASSIVE_AUX + _CREATE_PP + r"\s+by", True, 0.88)

# "The Core Platform team decided to adopt gRPC": the DECISION span starts at the verb, so the gap is empty.
_rule("DECIDED", "decide_predicate", _ACTORS, {"DECISION"}, _AUX, False, 0.92)

_USE_V = r"(?:uses?|used|using|utili[sz]es?|utili[sz]ed|employs?|employed|adopted|adopts?|runs?\s+on|ran\s+on|(?:is|are|was|were)\s+(?:built|powered)\s+(?:with|on|by)|built\s+(?:with|on)|powered\s+by)"
_rule("USED", "use_predicate", _THINGS | {"TEAM"}, {"TECHNOLOGY"}, _AUX + _USE_V + r"\s+(?:for\s+|as\s+)?" + _DET)
_rule("USED", "passive_use", _THINGS | {"TEAM"}, {"TECHNOLOGY"}, _PASSIVE_AUX + r"(?:used|adopted|employed)\s+(?:by|in|across)", True, 0.88)

_rule("DEPENDS_ON", "depends_on_predicate", _THINGS, {"TECHNOLOGY", "SERVICE", "PROJECT"},
      _AUX + r"(?:depends?\s+on|depended\s+on|relies\s+on|relied\s+on|rely\s+on|requires?|required|connects?\s+to|connected\s+to)\s+" + _DET)

_AFFECT_V = r"(?:affects?|affected|impacts?|impacted|disrupts?|disrupted|delays?|delayed|blocks?|blocked|broke|breaks|degrades?|degraded)"
_AFFECT_PP = r"(?:affected|impacted|disrupted|delayed|blocked|broken|degraded)"
_rule("AFFECTED", "affect_predicate", {"ISSUE", "DECISION"}, _THINGS, _AUX + _AFFECT_V + r"\s+" + _DET, False, 0.9)
_rule("AFFECTED", "passive_affect", {"ISSUE", "DECISION"}, _THINGS, _PASSIVE_AUX + _AFFECT_PP + r"\s+by", True, 0.88)

_rule("MIGRATED_TO", "migrate_to", _THINGS | {"TEAM"}, {"TECHNOLOGY"},
      _AUX + r"(?:migrat(?:es|ed|ing|e)|moved|moves|moving|switch(?:es|ed|ing)?|transition(?:s|ed|ing)?)\s+(?:over\s+)?to\s+" + _DET, False, 0.9)
_rule("MENTIONED_IN", "discussed_in", {"DECISION", "ISSUE", "PROJECT"}, {"MEETING", "DOCUMENT"},
      _PASSIVE_AUX + r"(?:discussed|mentioned|raised|reviewed|noted|covered|decided|agreed|approved)\s+(?:in|at|during)\s+(?:the\s+)?", False, 0.88)

_COORD_GAP = re.compile(r"^\s*(?:,|&|and|,\s*and|as\s+well\s+as|and\s+also|,\s*&)\s*$", re.IGNORECASE)
_MAX_GAP_CHARS = 90
_MAX_EVIDENCE_CHARS = 300
_MIGRATE_BEFORE = re.compile(r"(?:migrat\w*|transition\w*|switch\w*|mov\w*|upgrad\w*|replac\w*)\s+(?:over\s+)?(?:from\s+)?$", re.IGNORECASE)
_MIGRATE_GAP = re.compile(r"^\s+(?:to|with|over\s+to)\s+$", re.IGNORECASE)
_MEETING_CONTEXT = re.compile(r"(?:in|during|at)\s+(?:the\s+)?$", re.IGNORECASE)
_MEETING_GAP = re.compile(r"^,?\s*(?:(?:we|they|the\s+team|everyone|attendees|participants)\s+)?(?:discussed|reviewed|covered|raised|mentioned|noted)\s+(?:the\s+)?$", re.IGNORECASE)



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
        """Splits text into sentences. Returns (stripped_text, start, end) with REAL offsets
        into `text` (start/end bound exactly the stripped sentence).

        A full stop is NOT a boundary after an initial ("R. De"), a known abbreviation
        ("Dr.", "e.g.", "Inc."), inside a number, or when the next word is lower case.
        Blank lines and bullet lines always start a new sentence.
        """
        boundaries: List[int] = []  # offsets where a new sentence may start
        for m in _BOUNDARY_RE.finditer(text):
            if m.group("para"):
                boundaries.append(m.end())
                continue
            punct_end = m.start("punct") + len(m.group("punct"))
            if m.group("punct") == ".":
                before = text[: m.start("punct")]
                word_match = re.search(r"([A-Za-z][A-Za-z.]*)$", before)
                word = word_match.group(1) if word_match else ""
                if len(word) == 1 and word.isupper():  # initial: "R. De"
                    continue
                if word.lower().rstrip(".") in _ABBREVIATIONS:
                    continue
                nxt = text[m.end():m.end() + 1]
                if nxt and (nxt.islower() or nxt.isdigit()):
                    continue
            boundaries.append(m.end())

        sentences: List[Tuple[str, int, int]] = []
        cursor = 0
        for cut in boundaries + [len(text)]:
            chunk = text[cursor:cut]
            stripped = chunk.strip()
            if stripped:
                lead = len(chunk) - len(chunk.lstrip())
                s_start = cursor + lead
                sentences.append((stripped, s_start, s_start + len(stripped)))
            cursor = cut
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

        # Trigger rules that work from the real entity offsets (passives, coordination, adverbs ...)
        relations.extend(self._extract_offset_relations(text, entities, sentences))

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

    # ------------------------------------------------------------------ offset-based trigger rules
    def _extract_offset_relations(self, text: str, entities: List[Entity], sentences) -> List[Relation]:
        """Relations from the TEXT BETWEEN two entity spans (uses real character offsets).

        Unlike a regex that re-searches the entity's text, this tolerates "has been working
        closely on", passives ("was created by"), and coordination ("Priya and Alex worked on X").
        A relation is only emitted when the words between the two entities are exactly one of the
        known trigger phrases; the evidence is the real slice of the chunk text.
        """
        located = sorted(
            (e for e in entities if e.start_char is not None and e.end_char is not None and e.end_char > e.start_char),
            key=lambda e: (e.start_char, e.end_char),
        )
        out: List[Relation] = []
        for _sent, s_start, s_end in sentences:
            ents = [e for e in located if e.start_char >= s_start and e.end_char <= s_end]
            if len(ents) < 2:
                continue
            for i, a in enumerate(ents):
                for b in ents[i + 1:]:
                    if b.start_char < a.end_char:
                        continue  # overlapping spans
                    gap = text[a.end_char:b.start_char]
                    if len(gap) > _MAX_GAP_CHARS:
                        break  # later entities are only further away
                    if re.search(r"[.!?;\n]", gap):
                        break
                    out.extend(self._match_rules(text, ents, a, b, gap))
                    out.extend(self._match_migration(text, a, b, gap))
                    out.extend(self._match_meeting_first(text, a, b, gap))
        return out

    def _chain(self, text: str, ents: List[Entity], anchor: Entity, allowed: set, direction: int) -> List[Entity]:
        """Entities joined to `anchor` by ", " / "and" (coordination), nearest first."""
        chain: List[Entity] = []
        cur = anchor
        while True:
            nxt = None
            for e in ents:
                if direction < 0 and e.end_char <= cur.start_char:
                    gap = text[e.end_char:cur.start_char]
                    if _COORD_GAP.match(gap) and (nxt is None or e.end_char > nxt.end_char):
                        nxt = e
                elif direction > 0 and e.start_char >= cur.end_char:
                    gap = text[cur.end_char:e.start_char]
                    if _COORD_GAP.match(gap) and (nxt is None or e.start_char < nxt.start_char):
                        nxt = e
            if nxt is None or nxt.type not in allowed or nxt in chain:
                return chain
            chain.append(nxt)
            cur = nxt

    def _match_rules(self, text: str, ents: List[Entity], a: Entity, b: Entity, gap: str) -> List[Relation]:
        found: List[Relation] = []
        norm_gap = re.sub(r"\s+", " ", gap)
        for relation, trigger, subj_types, obj_types, gap_re, reverse, conf in _RULES:
            subject, obj = (b, a) if reverse else (a, b)
            if subject.type not in subj_types or obj.type not in obj_types:
                continue
            if not gap_re.match(norm_gap):
                continue
            # subjects / objects that are coordinated with the matched ones share the predicate
            if reverse:
                subjects = [subject] + self._chain(text, ents, subject, subj_types, +1)
                objects = [obj] + self._chain(text, ents, obj, obj_types, -1)
            else:
                subjects = [subject] + self._chain(text, ents, subject, subj_types, -1)
                objects = [obj] + self._chain(text, ents, obj, obj_types, +1)
            for sub in subjects:
                for ob in objects:
                    if sub.id == ob.id:
                        continue
                    lo = min(sub.start_char, ob.start_char)
                    hi = max(sub.end_char, ob.end_char)
                    if hi - lo > _MAX_EVIDENCE_CHARS:
                        continue
                    coordinated = sub is not subject or ob is not obj
                    found.append(
                        Relation(
                            source=sub.id, relation=relation, target=ob.id,
                            confidence=round(conf - (0.02 if coordinated else 0.0), 3),
                            evidence=text[lo:hi], trigger=trigger,
                        )
                    )
        return found

    def _match_migration(self, text: str, a: Entity, b: Entity, gap: str) -> List[Relation]:
        """"migrated from MySQL to PostgreSQL" / "replaced MySQL with PostgreSQL": MySQL -> PostgreSQL."""
        if a.type != "TECHNOLOGY" or b.type != "TECHNOLOGY" or a.id == b.id:
            return []
        if not _MIGRATE_GAP.match(gap):
            return []
        before = text[max(0, a.start_char - 40):a.start_char]
        if not _MIGRATE_BEFORE.search(before):
            return []
        return [Relation(source=a.id, relation=RelationType.MIGRATED_TO.value, target=b.id, confidence=0.92,
                         evidence=text[a.start_char:b.end_char], trigger="migrate_from_to")]

    def _match_meeting_first(self, text: str, a: Entity, b: Entity, gap: str) -> List[Relation]:
        """"In the Architecture Review meeting, we discussed Project Apollo": Apollo MENTIONED_IN meeting."""
        if a.type not in {"MEETING", "DOCUMENT"} or b.type not in {"DECISION", "ISSUE", "PROJECT"}:
            return []
        if not _MEETING_GAP.match(gap) or not _MEETING_CONTEXT.search(text[max(0, a.start_char - 12):a.start_char]):
            return []
        return [Relation(source=b.id, relation=RelationType.MENTIONED_IN.value, target=a.id, confidence=0.86,
                         evidence=text[a.start_char:b.end_char], trigger="meeting_context")]


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
