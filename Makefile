# Local development. Needs pnpm, Docker and GNU Make.
#
#   make i            install dependencies
#   make start        start Postgres + Redis, migrate, build the editor if missing, run the server (Ctrl+C stops it)
#   make stop         stop Postgres + Redis
#   make db-migrate   start Postgres + Redis and apply database migrations
#
# The server runs on http://localhost:5678 against postgres://postgres:postgres@127.0.0.1:5432/workflow_dev.
# Recipes avoid shell-specific syntax so they work from cmd, PowerShell and Git Bash.

COMPOSE := docker compose -f docker/docker-compose.dev.yml
SERVER := pnpm -C packages/server
EDITOR_BUILD := $(if $(wildcard packages/editor/dist/index.html),,editor)

.DEFAULT_GOAL := help
.PHONY: help i start stop db-migrate services editor seed down

help:
	@echo make i           install dependencies
	@echo make start       start services, migrate, build the editor if missing, run the server
	@echo make stop        stop Postgres and Redis
	@echo make db-migrate  apply database migrations
	@echo make seed        create a demo login
	@echo make editor      rebuild the editor
	@echo make down        remove the services and their data

i:
	pnpm install

services:
	$(COMPOSE) up -d --wait

db-migrate: services
	$(SERVER) migrate

editor:
	pnpm -C packages/editor build

start: db-migrate $(EDITOR_BUILD)
	$(SERVER) dev

stop:
	$(COMPOSE) stop

seed: db-migrate
	$(SERVER) seed

down:
	$(COMPOSE) down -v
