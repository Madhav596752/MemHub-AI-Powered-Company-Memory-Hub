
from pathlib import Path

from ai.document_processor import process_document
from ai.embeddings import embed_chunks
from ai.nlp.pipeline import create_pipeline


def test_document_to_embeddings_and_nlp():
    sample = Path("integration_sample.txt")
    sample.write_text(
        "Rahul works on Project Phoenix. "
        "The engineering team uses Python for this project.",
        encoding="utf-8",
    )

    try:
        # Process the document and retrieve its chunks.
        result = process_document(str(sample))
        assert result["chunks"], "No document chunks were produced"
        chunks = result["chunks"]

        # Generate embeddings for the same chunks.
        embeddings = embed_chunks(chunks)
        assert embeddings.count == len(chunks)

        # Extract entities and relationships from each chunk.
        nlp = create_pipeline()
        outputs = [
            nlp.process_chunk(
                text=chunk["text"],
                document_id=chunk.get("document_id", "integration_doc"),
                chunk_id=chunk.get("chunk_id", f"chunk_{i}"),
                metadata=chunk.get("metadata", {}),
            )
            for i, chunk in enumerate(chunks)
        ]

        assert outputs
        assert all(output.text for output in outputs)

    finally:
        sample.unlink(missing_ok=True)
