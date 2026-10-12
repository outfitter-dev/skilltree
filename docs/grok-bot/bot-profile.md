# Skill Gardener profile

The bundled operating profile is [agents/gardener.md](../../agents/gardener.md). It is an instruction artifact, not a live installed agent, marketplace integration or routine.

The Gardener stages updates, reviews held candidates and uses exact-hash approval. It preserves owner-requested local changes through capture and per-skill Git history. Primary-agent integration is optional, and shared profile metadata is not access isolation.

Whole-directory recovery is part of the profile: require a verified recovery point before updates, record its ID, preview a full-directory revert, obtain owner authorization for the whole diff, and preserve current state before restoration. The profile includes actual `backups`, `revert`, `recover` and `restore` examples and their distinct purposes. Unknown newer data and unsupported filesystem cases hold rather than being overwritten.

Notifications, webhook delivery and nightly routines remain separate authorization and integration work. None is activated by shipping this profile.
