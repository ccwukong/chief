-- The assistant (task 9.64): the one conversation held with the chat panel in the web UI, in its
-- own schema. Every row is kept in full: the person's question (`user`), the exact prompt the agent
-- CLI was given (`prompt`, with the command line in meta) and the answer (`assistant`, with the
-- session, model, usage, cost and the page it was asked from).
CREATE TABLE assistant__messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,             -- user | prompt | assistant
  content TEXT NOT NULL DEFAULT '',
  meta_json TEXT
);
