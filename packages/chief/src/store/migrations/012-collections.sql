-- "Input sets" are **collections**: a named set of input values, prepared for one workflow and used as the input of a
-- run (renamed 2026-11-24, asked for in the same breath as the page that shows them: *"don't use the word `case`, it
-- can be input data collection or something"*). The concept does not change; only the word does, in the schema, the
-- API and the screen, so nothing is left half-named.
--
-- `ALTER TABLE ... RENAME` in SQLite 3.25+ also rewrites the references to a renamed table inside other tables'
-- definitions; `run__runs` keeps the two columns, renamed, and no data moves.
ALTER TABLE input_set__sets RENAME TO collection__collections;
ALTER TABLE run__runs RENAME COLUMN input_set_id TO collection_id;
ALTER TABLE run__runs RENAME COLUMN input_set_name TO collection_name;

-- An index keeps its old name through a table rename, and the name is part of the schema rule: every index is
-- `<schema>__<name>`. Recreated, so the one index on the table is `collection__collections_workflow`.
DROP INDEX IF EXISTS input_set__sets_workflow;
CREATE INDEX collection__collections_workflow ON collection__collections(workflow_id);
