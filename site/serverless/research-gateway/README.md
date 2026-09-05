# SomniQ Research Gateway

Tencent Cloud Serverless source for the built-in SomniQ research tools.
Deploy `index.mjs` as an ES module entry named `main_handler` and set the
following function environment variables outside source control:

- `BOCHA_API_KEY` (required for `/bocha`)
- `ZHIHU_ACCESS_SECRET` (required for `/zhihu`)
- `OPENALEX_API_KEY` (optional; OpenAlex supports anonymous access)

The desktop client calls these routes without user-supplied provider keys:

| Route | Method | Upstream |
| --- | --- | --- |
| `/openalex/*` | `GET` | OpenAlex Works API |
| `/bocha` | `POST` | Bocha AI web search |
| `/zhihu` | `POST` | Zhihu content search |

The gateway is intentionally a narrow allow-list, not a general HTTP proxy.
Configure platform-level rate limiting and request logging that excludes bodies
and authorization headers before exposing it publicly.
