-- "Collections" are **input data sets**: the input values one run of a workflow is given, prepared ahead of it
-- (renamed again 2026-11-25, on the same judgement that changed "case" to "collection" the day before: asked for in the
-- words of the person using it, *"the word Collections is definitely confusing, just rename it to workflow input data set
-- or something close"*).
--
-- The concept has not changed once; only the word, and each time all the way down — schema, table, columns, API and
-- screen — because a screen that says one thing over a database that says another is a second thing to keep in step.
-- `ALTER TABLE ... RENAME` also rewrites the references to a renamed table inside other tables' definitions.
ALTER TABLE collection__collections RENAME TO input_set__sets;
ALTER TABLE run__runs RENAME COLUMN collection_id TO input_set_id;
ALTER TABLE run__runs RENAME COLUMN collection_name TO input_set_name;

-- An index keeps its old name through a table rename, and the name is part of the schema rule: every index is
-- `<schema>__<name>`. Recreated, so it is `input_set__sets_workflow`.
--
-- **Both names are dropped first, and that is not defensive padding.** A database was found in which an index already
-- called `input_set__sets_workflow` sat on the *old* table, so the CREATE failed with "index already exists" and every
-- start of `chief serve` after it died in the constructor — the person could not open the app at all (reported
-- 2026-11-25). `CREATE INDEX` has no `IF NOT EXISTS` in SQLite, so the only idempotent form is to drop the name it is
-- about to use.
DROP INDEX IF EXISTS collection__collections_workflow;
DROP INDEX IF EXISTS input_set__sets_workflow;
CREATE INDEX input_set__sets_workflow ON input_set__sets(workflow_id);
