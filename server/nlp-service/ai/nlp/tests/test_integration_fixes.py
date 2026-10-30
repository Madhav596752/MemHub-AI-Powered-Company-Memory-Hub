"""Regression tests for the three MemHub fixes to the teammate's entity extractor."""
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from ai.nlp.pipeline import NLPKnowledgePipeline  # noqa: E402

pipe = NLPKnowledgePipeline()


def ents(text):
    return [(e.text, e.type) for e in pipe.process_chunk(text, "d", "c").entities]


def test_team_name_does_not_swallow_preceding_words():
    teams = [t for t, k in ents("Yesterday the Platform team shipped it.") if k == "TEAM"]
    assert teams == ["the Platform team"]
    assert not [t for t, k in ents("Yesterday the platform team decided to adopt Redis.") if k == "TEAM" and "Yesterday" in t]


def test_ambiguous_english_words_are_not_technologies():
    assert [x for x in ents("We need to go ahead and rest the case. Please express your view on the node.") if x[1] == "TECHNOLOGY"] == []


def test_exact_spelling_still_detected_as_technology():
    techs = {t for t, k in ents("We use Go and REST with Node and Redis.") if k == "TECHNOLOGY"}
    assert {"Go", "REST", "Node", "Redis"} <= techs


def test_first_name_subject_found_even_when_spacy_model_misses_it():
    assert ("Priya", "PERSON") in ents("Priya resolved the authentication issue in Project Phoenix.")
