"""Comprehensive Test Suite for MemHub NLP Module 3.

Tests:
1. Person + Issue
2. Person + Project
3. Team + Decision
4. Project + Technology
5. Developer + GitHub issue
6. Meeting + Decision
7. Anti-hallucination verification
8. Graph-ready JSON formatting & normalization
"""

import json
import os
import sys
import unittest

# Ensure the root workspace is on python sys.path
WORKSPACE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
if WORKSPACE_ROOT not in sys.path:
    sys.path.insert(0, WORKSPACE_ROOT)

from ai.nlp.normalizer import EntityNormalizer
from ai.nlp.pipeline import NLPKnowledgePipeline
from ai.nlp.schemas import EntityType, RelationType


class TestMemHubNLPModule(unittest.TestCase):
    """Test cases for Named Entity Recognition, Relation Extraction, and Graph Output."""

    def setUp(self):
        self.pipeline = NLPKnowledgePipeline()

    def _find_entity_by_type(self, entities, entity_type):
        return [e for e in entities if e.type == entity_type]

    def _find_entity_by_text(self, entities, text_substr):
        return [e for e in entities if text_substr.lower() in e.text.lower()]

    def _find_relation(self, relationships, source_id, relation_type, target_id):
        return [
            r
            for r in relationships
            if r.source == source_id
            and r.relation == relation_type
            and r.target == target_id
        ]

    def test_scenario_1_person_and_issue(self):
        """Scenario 1: Person + Issue (+ Project).

        Input: 'Priya resolved the authentication issue in Project Phoenix.'
        Entities: Priya (PERSON), authentication issue (ISSUE), Project Phoenix (PROJECT)
        Relations: Priya -> RESOLVED -> authentication issue
                   authentication issue -> BELONGS_TO -> Project Phoenix
        """
        text = "Priya resolved the authentication issue in Project Phoenix."
        output = self.pipeline.process_chunk(text, document_id="doc_auth", chunk_id="chunk_1")

        print("\n" + "=" * 60)
        print("SCENARIO 1: Person + Issue")
        print("Input:", text)
        print("Extracted Entities:", json.dumps([e.to_dict(minimal=True) for e in output.entities], indent=2))
        print("Extracted Relations:", json.dumps([r.to_dict(minimal=True) for r in output.relationships], indent=2))

        # Check Entities
        person_ents = self._find_entity_by_type(output.entities, EntityType.PERSON.value)
        issue_ents = self._find_entity_by_type(output.entities, EntityType.ISSUE.value)
        project_ents = self._find_entity_by_type(output.entities, EntityType.PROJECT.value)

        self.assertTrue(any("Priya" in e.text for e in person_ents), "Expected PERSON 'Priya'")
        self.assertTrue(any("authentication issue" in e.text for e in issue_ents), "Expected ISSUE 'authentication issue'")
        self.assertTrue(any("Project Phoenix" in e.text for e in project_ents), "Expected PROJECT 'Project Phoenix'")

        priya = next(e for e in person_ents if "Priya" in e.text)
        auth_issue = next(e for e in issue_ents if "authentication issue" in e.text)
        project = next(e for e in project_ents if "Project Phoenix" in e.text)

        # Check Relations
        resolved_rel = self._find_relation(output.relationships, priya.id, RelationType.RESOLVED.value, auth_issue.id)
        self.assertTrue(len(resolved_rel) > 0, "Expected Priya RESOLVED authentication issue")
        self.assertGreaterEqual(resolved_rel[0].confidence, 0.90)

        belongs_rel = self._find_relation(output.relationships, auth_issue.id, RelationType.BELONGS_TO.value, project.id)
        self.assertTrue(len(belongs_rel) > 0, "Expected authentication issue BELONGS_TO Project Phoenix")

    def test_scenario_2_person_and_project(self):
        """Scenario 2: Person + Project.

        Input: 'Alex joined Project Apollo and works on the onboarding flow.'
        Entities: Alex (PERSON), Project Apollo (PROJECT)
        Relations: Alex -> WORKED_ON -> Project Apollo
        """
        text = "Alex joined Project Apollo and works on the onboarding flow."
        output = self.pipeline.process_chunk(text, document_id="doc_apollo", chunk_id="chunk_1")

        print("\n" + "=" * 60)
        print("SCENARIO 2: Person + Project")
        print("Input:", text)
        print("Extracted Entities:", json.dumps([e.to_dict(minimal=True) for e in output.entities], indent=2))
        print("Extracted Relations:", json.dumps([r.to_dict(minimal=True) for r in output.relationships], indent=2))

        person_ents = self._find_entity_by_type(output.entities, EntityType.PERSON.value)
        project_ents = self._find_entity_by_type(output.entities, EntityType.PROJECT.value)

        self.assertTrue(any("Alex" in e.text for e in person_ents), "Expected PERSON 'Alex'")
        self.assertTrue(any("Project Apollo" in e.text for e in project_ents), "Expected PROJECT 'Project Apollo'")

        alex = next(e for e in person_ents if "Alex" in e.text)
        apollo = next(e for e in project_ents if "Project Apollo" in e.text)

        worked_rel = self._find_relation(output.relationships, alex.id, RelationType.WORKED_ON.value, apollo.id)
        self.assertTrue(len(worked_rel) > 0, "Expected Alex WORKED_ON Project Apollo")

    def test_scenario_3_team_and_decision(self):
        """Scenario 3: Team + Decision (+ Technology Migration).

        Input: 'The Core Platform team decided to migrate from MySQL to PostgreSQL.'
        Entities: Core Platform team (TEAM), decided to migrate from MySQL to PostgreSQL (DECISION), MySQL (TECH), PostgreSQL (TECH)
        Relations: Core Platform team -> DECIDED -> decision
                   MySQL -> MIGRATED_TO -> PostgreSQL
        """
        text = "The Core Platform team decided to migrate from MySQL to PostgreSQL."
        output = self.pipeline.process_chunk(text, document_id="doc_decision", chunk_id="chunk_1")

        print("\n" + "=" * 60)
        print("SCENARIO 3: Team + Decision")
        print("Input:", text)
        print("Extracted Entities:", json.dumps([e.to_dict(minimal=True) for e in output.entities], indent=2))
        print("Extracted Relations:", json.dumps([r.to_dict(minimal=True) for r in output.relationships], indent=2))

        team_ents = self._find_entity_by_type(output.entities, EntityType.TEAM.value)
        decision_ents = self._find_entity_by_type(output.entities, EntityType.DECISION.value)
        tech_ents = self._find_entity_by_type(output.entities, EntityType.TECHNOLOGY.value)

        self.assertTrue(any("Core Platform team" in e.text for e in team_ents), "Expected TEAM 'Core Platform team'")
        self.assertTrue(len(decision_ents) > 0, "Expected DECISION entity")
        self.assertTrue(any("mysql" in e.text.lower() for e in tech_ents), "Expected MySQL tech")
        self.assertTrue(any("postgresql" in e.text.lower() for e in tech_ents), "Expected PostgreSQL tech")

        team = team_ents[0]
        decision = decision_ents[0]

        decided_rel = self._find_relation(output.relationships, team.id, RelationType.DECIDED.value, decision.id)
        self.assertTrue(len(decided_rel) > 0, "Expected Core Platform team DECIDED decision")

    def test_scenario_4_project_and_technology(self):
        """Scenario 4: Project + Technology.

        Input: 'Project Titan uses Redis for caching and depends on Kafka.'
        Entities: Project Titan (PROJECT), Redis (TECHNOLOGY), Kafka (TECHNOLOGY)
        Relations: Project Titan -> USED -> Redis
                   Project Titan -> DEPENDS_ON -> Kafka
        """
        text = "Project Titan uses Redis for caching and depends on Kafka."
        output = self.pipeline.process_chunk(text, document_id="doc_titan", chunk_id="chunk_1")

        print("\n" + "=" * 60)
        print("SCENARIO 4: Project + Technology")
        print("Input:", text)
        print("Extracted Entities:", json.dumps([e.to_dict(minimal=True) for e in output.entities], indent=2))
        print("Extracted Relations:", json.dumps([r.to_dict(minimal=True) for r in output.relationships], indent=2))

        project_ents = self._find_entity_by_type(output.entities, EntityType.PROJECT.value)
        tech_ents = self._find_entity_by_type(output.entities, EntityType.TECHNOLOGY.value)

        self.assertTrue(any("Project Titan" in e.text for e in project_ents), "Expected PROJECT 'Project Titan'")
        self.assertTrue(any("Redis" in e.text for e in tech_ents), "Expected TECH 'Redis'")
        self.assertTrue(any("Kafka" in e.text for e in tech_ents), "Expected TECH 'Kafka'")

        titan = next(e for e in project_ents if "Project Titan" in e.text)
        redis_ent = next(e for e in tech_ents if "Redis" in e.text)
        kafka_ent = next(e for e in tech_ents if "Kafka" in e.text)

        used_rel = self._find_relation(output.relationships, titan.id, RelationType.USED.value, redis_ent.id)
        self.assertTrue(len(used_rel) > 0, "Expected Project Titan USED Redis")

        depends_rel = self._find_relation(output.relationships, titan.id, RelationType.DEPENDS_ON.value, kafka_ent.id)
        self.assertTrue(len(depends_rel) > 0, "Expected Project Titan DEPENDS_ON Kafka")

    def test_scenario_5_developer_and_github_issue(self):
        """Scenario 5: Developer + GitHub issue.

        Input: 'Marcus was assigned to issue #402 regarding memory leaks.'
        Entities: Marcus (PERSON), issue #402 (ISSUE)
        Relations: Marcus -> ASSIGNED_TO -> issue #402
        """
        text = "Marcus was assigned to issue #402 regarding memory leaks."
        output = self.pipeline.process_chunk(text, document_id="doc_marcus", chunk_id="chunk_1")

        print("\n" + "=" * 60)
        print("SCENARIO 5: Developer + GitHub issue")
        print("Input:", text)
        print("Extracted Entities:", json.dumps([e.to_dict(minimal=True) for e in output.entities], indent=2))
        print("Extracted Relations:", json.dumps([r.to_dict(minimal=True) for r in output.relationships], indent=2))

        person_ents = self._find_entity_by_type(output.entities, EntityType.PERSON.value)
        issue_ents = self._find_entity_by_type(output.entities, EntityType.ISSUE.value)

        self.assertTrue(any("Marcus" in e.text for e in person_ents), "Expected PERSON 'Marcus'")
        self.assertTrue(any("402" in e.text for e in issue_ents), "Expected ISSUE '#402'")

        marcus = next(e for e in person_ents if "Marcus" in e.text)
        issue = next(e for e in issue_ents if "402" in e.text)

        assigned_rel = self._find_relation(output.relationships, marcus.id, RelationType.ASSIGNED_TO.value, issue.id)
        self.assertTrue(len(assigned_rel) > 0, "Expected Marcus ASSIGNED_TO issue #402")

    def test_scenario_6_meeting_and_decision(self):
        """Scenario 6: Meeting + Decision.

        Input: 'In the Architecture Review meeting, the team decided to adopt gRPC.'
        Entities: Architecture Review meeting (MEETING), team (TEAM), decided to adopt gRPC (DECISION), gRPC (TECHNOLOGY)
        Relations: team -> DECIDED -> decision
                   decision -> MENTIONED_IN -> Architecture Review meeting
        """
        text = "In the Architecture Review meeting, the team decided to adopt gRPC."
        output = self.pipeline.process_chunk(text, document_id="doc_meeting", chunk_id="chunk_1")

        print("\n" + "=" * 60)
        print("SCENARIO 6: Meeting + Decision")
        print("Input:", text)
        print("Extracted Entities:", json.dumps([e.to_dict(minimal=True) for e in output.entities], indent=2))
        print("Extracted Relations:", json.dumps([r.to_dict(minimal=True) for r in output.relationships], indent=2))

        meeting_ents = self._find_entity_by_type(output.entities, EntityType.MEETING.value)
        decision_ents = self._find_entity_by_type(output.entities, EntityType.DECISION.value)

        self.assertTrue(len(meeting_ents) > 0, "Expected MEETING entity")
        self.assertTrue(len(decision_ents) > 0, "Expected DECISION entity")

        meeting = meeting_ents[0]
        decision = decision_ents[0]

        mentioned_rel = self._find_relation(output.relationships, decision.id, RelationType.MENTIONED_IN.value, meeting.id)
        self.assertTrue(len(mentioned_rel) > 0, "Expected decision MENTIONED_IN meeting")

    def test_anti_hallucination(self):
        """Verify that unrelated co-occurring entities do NOT produce hallucinated relations."""
        text = "Priya drank some coffee while Project Phoenix was mentioned in the newspaper."
        output = self.pipeline.process_chunk(text)

        # There should be NO 'RESOLVED' or 'ASSIGNED_TO' relationship between Priya and Project Phoenix
        bad_relations = [
            r for r in output.relationships
            if r.relation in [RelationType.RESOLVED.value, RelationType.ASSIGNED_TO.value]
        ]
        self.assertEqual(len(bad_relations), 0, "Must not hallucinate relationships without linguistic evidence")

    def test_normalization_and_serialization(self):
        """Verify normalizer canonical forms and graph-ready JSON serialization."""
        text = "Priya resolved the authentication issue in Project Phoenix."
        output = self.pipeline.process_chunk(text, document_id="doc_101", chunk_id="chunk_1")

        output_dict = output.to_dict(minimal=True)
        self.assertEqual(output_dict["document_id"], "doc_101")
        self.assertEqual(output_dict["chunk_id"], "chunk_1")
        self.assertIn("entities", output_dict)
        self.assertIn("relationships", output_dict)

        # Check normalizer on technologies
        normalizer = EntityNormalizer()
        _, canon_pg = normalizer.normalize_surface_text("postgres", EntityType.TECHNOLOGY.value)
        self.assertEqual(canon_pg, "PostgreSQL")

        _, canon_k8s = normalizer.normalize_surface_text("k8s", EntityType.TECHNOLOGY.value)
        self.assertEqual(canon_k8s, "Kubernetes")

        # Roundtrip JSON test
        json_str = output.to_json()
        loaded = json.loads(json_str)
        self.assertEqual(loaded["document_id"], "doc_101")


if __name__ == "__main__":
    unittest.main()
