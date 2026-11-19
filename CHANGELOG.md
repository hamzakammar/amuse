# Changelog

## Unreleased

- Optional MCP client support: stdio and streamable HTTP servers configured in `AMUSE_MCP_CONFIG`,
  with tools offered as `mcp__<server>__<tool>` behind approval cards. Off by default.

## 0.1.0 (unreleased)

First public release.

- Personal agent with onboarding (name, look, personality), a main chat, side chats and voice mode.
- Web research with OpenAI web search, and a live browser you can watch, take over or stop.
- Reminders, monitors, goals with plans, and a background heartbeat.
- Documents, PDFs, images, podcasts and spaces (small apps with saved data).
- Approval cards for sends, form submissions, payments and schedules; an encrypted credential vault
  with stand-in tokens; a public-network-only egress guard.
- Docker Compose setup with PostgreSQL, running as a non-root user.
