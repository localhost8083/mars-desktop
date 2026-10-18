---
name: mars-connect
description: Search and use the skills, MCP connections, and connected services available through the user's MarsAI organization.
---

# MarsAI Connect

Use the MarsAI MCP server when the user asks for an organizational skill,
shared MCP tool, connected service, or MarsAI Cloud operation.

## Workflow

1. Call `search_capabilities` with a short description of the outcome unless
   the exact capability name is already available in the current context.
2. Select an exact capability name from the search result.
3. Call `execute_capability` with that exact name and only the parameters
   required for the requested outcome.
4. If MarsAI returns a connection, authentication, permission, or admin
   setup state, relay that state and its next action accurately. Do not claim
   that an unavailable capability ran.

Search results reflect the signed-in member's organization, grants, teams, and
connection readiness. Do not infer access from a capability that was visible
in another organization or an earlier authorization context.

MarsAI Connect performs OAuth through the MCP client. Never request, embed,
or persist MarsAI access tokens in plugin files or chat content.
