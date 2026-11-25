-- A case: one named set of inputs for one workflow, kept between runs (asked 2026-11-24: *"is it possible to
-- separate managing workflow input sets from the workflow runs? so users can work on the input data prep for
-- different cases without starting a workflow run"* — a year-end review for eight people, where the GitHub and
-- Jira facts are ready in November and the peer feedback arrives in December).
--
-- It is a schema of its own because a case is not a draft, which is discarded when it is sent, and not a run, which
-- is a record of what happened. It outlives both: it is prepared, left alone for days, started once, and kept to be
-- started again next year.
--
-- The values are one JSON object of the same shape a run is given, so the whole inputs machinery (the declaration,
-- the form, the refusal for a required field) applies to a case without a second copy of any of it.
CREATE TABLE input_set__sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL REFERENCES workflow__definitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  values_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workflow_id, name)
);
CREATE INDEX input_set__sets_workflow ON input_set__sets(workflow_id);

-- Which case a run came from. Stored on the run, because the case can be renamed, emptied or deleted afterwards and
-- the run must still say what it ran: the values themselves are copied into `run__runs.inputs_json` as always, and
-- the **name** is kept beside the id for the same reason — a deleted case leaves no row to join to.
ALTER TABLE run__runs ADD COLUMN input_set_id INTEGER;
ALTER TABLE run__runs ADD COLUMN input_set_name TEXT;
