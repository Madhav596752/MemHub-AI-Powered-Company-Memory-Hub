"""Relationship extraction on realistic phrasing (offset-based trigger rules, sentence splitting).

Every expectation is a relationship the sentence really states; the negative tests make sure the
extractor does NOT invent one (negation, unrelated entities in the same sentence, unknown verbs).
"""
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from ai.nlp.pipeline import create_pipeline
from ai.nlp.relation_extractor import RelationExtractor
from contract import build_chunk_result


class RelationRuleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pipeline = create_pipeline()

    def facts(self, text):
        out = self.pipeline.process_chunk(text)
        names = {e.id: e.text for e in out.entities}
        return {(names[r.source], r.relation, names[r.target]) for r in out.relationships}

    def test_simple_and_adverb(self):
        self.assertIn(("Priya", "WORKED_ON", "Project Apollo"), self.facts("Priya works on Project Apollo."))
        self.assertIn(("Priya", "WORKED_ON", "Project Apollo"),
                      self.facts("Priya has been working closely on Project Apollo since March."))
        self.assertIn(("Alex", "RESOLVED", "authentication issue"),
                      self.facts("Alex has resolved the authentication issue."))

    def test_passive_voice(self):
        self.assertIn(("Priya", "CREATED", "Project Apollo"), self.facts("Project Apollo was created by Priya."))
        self.assertIn(("Alex", "RESOLVED", "authentication issue"),
                      self.facts("The authentication issue was resolved by Alex."))

    def test_coordination_keeps_every_subject_and_object(self):
        f = self.facts("Priya and Alex worked on Project Apollo.")
        self.assertIn(("Priya", "WORKED_ON", "Project Apollo"), f)
        self.assertIn(("Alex", "WORKED_ON", "Project Apollo"), f)
        f = self.facts("Project Apollo is built with Redis and Kafka.")
        self.assertIn(("Project Apollo", "USED", "Redis"), f)
        self.assertIn(("Project Apollo", "USED", "Kafka"), f)

    def test_membership_and_migration(self):
        self.assertIn(("Priya", "PART_OF", "the Core Platform team"), self.facts("Priya joined the Core Platform team."))
        self.assertIn(("MySQL", "MIGRATED_TO", "PostgreSQL"), self.facts("Project Titan migrated from MySQL to PostgreSQL."))

    def test_initial_is_not_a_sentence_end(self):
        out = self.pipeline.process_chunk("R. De joined the Core Platform team.")
        people = [e.text for e in out.entities if e.type == "PERSON"]
        self.assertEqual(people, ["R. De"])  # not the fragment "De"

    def test_no_invented_relationships(self):
        self.assertEqual(self.facts("Priya did not work on Project Apollo."), set())
        self.assertEqual(self.facts("Priya never resolved the login issue."), set())
        self.assertEqual(self.facts("Priya talked to Alex about Project Apollo."), set())
        # two sentences: the entities are in different sentences, so no relationship
        self.assertEqual(self.facts("Priya is on leave. Project Apollo is late."), set())

    def test_sentence_splitter_offsets_are_real(self):
        text = "Dr. Smith met Priya.  Alex fixed it. Version 2.5 shipped.\n\n- Priya works on Project Apollo."
        parts = RelationExtractor()._split_into_sentences(text)
        for sent, start, end in parts:
            self.assertEqual(text[start:end], sent)
        self.assertEqual(len(parts), 4)
        self.assertTrue(parts[0][0].startswith("Dr. Smith"))

    def test_contract_keeps_relationships_with_real_evidence(self):
        text = "Priya and Alex worked on Project Apollo. Alex resolved the login issue."
        out = self.pipeline.process_chunk(text)
        result = build_chunk_result(out, {"chunkId": "d:0", "chunkIndex": 0, "text": text}, "d")
        self.assertGreaterEqual(result["metadata"]["relationshipCount"], 3)
        self.assertEqual(result["metadata"]["droppedRelationships"], 0)
        for rel in result["relationships"]:
            self.assertIn(rel["evidence"], text)

    def test_empty_and_malformed_input(self):
        self.assertEqual(self.facts(""), set())
        self.assertEqual(self.facts("   \n\n  "), set())
        self.assertEqual(RelationExtractor().extract("text", []), [])


if __name__ == "__main__":
    unittest.main()
