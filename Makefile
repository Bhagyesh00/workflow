# Local development. Needs pnpm, Docker and GNU Make.
#
#   make i            install dependencies
#   make start        start Postgres + Redis, migrate, run the server and the editor in dev mode (Ctrl+C stops both)
#   make stop         stop Postgres + Redis
#   make db-migrate   start Postgres + Redis and apply database migrations
#
# Open the editor at http://localhost:8080. It reloads on every save and forwards API, push and
# webhook calls to the server on http://localhost:5678, which restarts when its source changes.
# The server's BASE_URL is the editor's address, so the links it builds (webhook URLs, invites,
# OAuth callbacks) go through the editor too.
# Other ports: make start EDITOR_PORT=3001 SERVER_PORT=5679
# The server uses postgres://postgres:postgres@127.0.0.1:5432/workflow_dev.
# Recipes avoid shell-specific syntax so they work from cmd, PowerShell and Git Bash.

COMPOSE := docker compose -f docker/docker-compose.dev.yml
SERVER := pnpm -C packages/server
EDITOR_PORT ?= 8080
SERVER_PORT ?= 5678

.DEFAULT_GOAL := help
.PHONY: help i start stop db-migrate services seed down

help:
	@echo make i           install dependencies
	@echo make start       start services, migrate, run the server and the editor in dev mode
	@echo make stop        stop Postgres and Redis
	@echo make db-migrate  apply database migrations
	@echo make seed        create a demo login
	@echo make down        remove the services and their data

i:
	pnpm install

services:
	$(COMPOSE) up -d --wait

db-migrate: services
	$(SERVER) migrate

start: export PORT := $(SERVER_PORT)
start: export EDITOR_PORT := $(EDITOR_PORT)
start: export WORKFLOW_SERVER_URL := http://localhost:$(SERVER_PORT)
start: export BASE_URL := http://localhost:$(EDITOR_PORT)
start: export MCP_BASE_URL := http://localhost:$(SERVER_PORT)
start: export AI_ENABLED := true
start: db-migrate
	pnpm --filter @workflow/chat-widget build
	pnpm --parallel --filter @workflow/server --filter @workflow/editor dev

stop:
	$(COMPOSE) stop

seed: db-migrate
	$(SERVER) seed

down:
	$(COMPOSE) down -v
