# Supabase SQL Tests

All migration includes in this folder must resolve to the canonical migration source:

- `/Users/zola/Documents/My Projects/Link/Link/link-be/supabase/migrations`

Use `\ir ../migrations/<timestamp>_<name>.sql` from test files so includes remain stable regardless of the shell working directory.
