-- Runs once, when the docker-compose.dev.yml Postgres volume is first created.
CREATE DATABASE workflow_dev;
CREATE DATABASE workflow_test;
CREATE DATABASE nodes_test;
CREATE DATABASE ai_test;

\c workflow_test
CREATE EXTENSION IF NOT EXISTS vector;

\c ai_test
CREATE EXTENSION IF NOT EXISTS vector;
