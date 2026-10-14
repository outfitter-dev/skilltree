# Command compatibility implementation

This work adds familiar skill-selection commands while retaining one shared library and explicit content approval. The implementation remains under review until the draft pull request is ready.

## Implementation sequence

1. Normalize command aliases, home defaults, compatibility flags and command help separately from domain operations. Preserve legacy stdout JSON during the deprecation window before 0.2.
2. Extend discovery and source selection with derived source IDs, qualified names, multi-selection, read-only listing and full-depth scans. Selection stages exact content hashes; activation still requires explicit authorization and a reason.
3. Expose plan/apply and snapshot workflows. Route activation through the existing ownership, drift, approval, complete-backup and journal checks. Automatically recover only transactions whose existing evidence proves a safe outcome.
4. Stage reversible skill removals with distinct content-bound hashes. Retain sources and selected state until guarded removal completes; force selects dependent removals without relaxing deployment gates.
5. Cover compatibility, ambiguity, staging-only flags, stale hashes, failed backups, interrupted writes and restoration. Update bundled operator guidance and validate both source and clean packaged execution.

Optional search/use proxies, experimental lock ingestion and Skillset integration remain outside this change. Publication and npm dist-tag changes require a separate release decision after implementation, review and exact-commit checks.
