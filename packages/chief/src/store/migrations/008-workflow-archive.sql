-- Archiving a workflow, so one that has runs can be taken out of service (task 15.2).
--
-- Deleting was the only way to get rid of a workflow, and it is refused once the workflow has runs: `run__runs` references
-- the workflow by id, and every run is kept in full because replay reads that record. That refusal is right, but it left
-- a workflow with history permanently in every picker. Archiving is the answer that loses nothing: the row stays (so its
-- runs, their names and their replay still resolve), and `archived_at` takes it out of the lists and stops its schedules
-- from firing.
--
-- `archived_at` is a timestamp rather than a 0/1 flag: "when" is the same amount of storage as "yes" and answers the
-- question a person actually asks about an archive.
ALTER TABLE workflow__definitions ADD COLUMN archived_at TEXT;
-- The lists are "the live ones, by name", which is what this covers.
CREATE INDEX workflow__definitions_archived ON workflow__definitions (archived_at, name);
