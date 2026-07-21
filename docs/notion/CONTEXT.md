# Notion Control

This context describes the Notion resources and access boundary Jarvis uses when reading and changing a user's workspace.

## Language

**Notion Connection**:
The user-authorized relationship that lets Jarvis access a Notion workspace through the official hosted Notion MCP service.
_Avoid_: API key, integration token, MCP server

**Database**:
A Notion container that owns one or more Data Sources and their views.
_Avoid_: Table, data source

**Data Source**:
The queryable schema and rows contained by a Database.
_Avoid_: Database, table

**Page Content**:
The ordered, nested content blocks belonging to a Page.
_Avoid_: Page properties, database row

**Page Properties**:
The typed values of a Page when it belongs to a Data Source.
_Avoid_: Page content, database schema

**Notion Tool Contract**:
The stable set of Notion capabilities Jarvis intentionally makes available to every model provider.
_Avoid_: MCP catalog, Notion API

## Relationships

- A **Notion Connection** belongs to one authorized user and workspace
- One Jarvis installation has at most one active **Notion Connection**
- A **Database** contains one or more **Data Sources**
- A **Data Source** contains zero or more Pages as rows
- A Page may have both **Page Content** and **Page Properties**
- **Page Content** may contain nested child blocks
- **Page Properties** conform to exactly one **Data Source** schema when the Page is a row
- The **Notion Tool Contract** exposes only approved capabilities from the active **Notion Connection**
- The **Notion Tool Contract** is unavailable when no **Notion Connection** is active
- Page creation through the **Notion Tool Contract** always targets an explicit parent Page or Data Source

## Example dialogue

> **Dev:** "Should I query this database ID to create the new task?"
> **Domain expert:** "Fetch the **Database**, select its **Data Source**, and use that **Data Source** ID to query rows or create the task Page."

## Flagged ambiguities

- "Database" previously referred to both the Notion container and its queryable **Data Source**; these are distinct resources in the current Notion API and MCP representations.
- "Read a page" means retrieving **Page Content**, not merely finding its title or returning **Page Properties**.
- A **Notion Connection** is global to the Jarvis installation, not scoped to a conversation or model provider.
- The hosted MCP catalog may contain more operations than the **Notion Tool Contract**; discovery does not grant model access.
- "Notion unavailable" means no active **Notion Connection**, not that callable tools are expected to fail at runtime.
