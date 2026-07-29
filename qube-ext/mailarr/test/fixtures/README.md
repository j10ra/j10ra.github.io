# Source fixtures

Captured on 2026-07-29 from one live fetch per source:

- `remoteok.json`: `https://remoteok.com/api`
- `remotive.json`: `https://remotive.com/api/remote-jobs?limit=1`
- `weworkremotely.xml`: `https://weworkremotely.com/categories/remote-programming-jobs.rss`
- `arbeitnow.json`: `https://www.arbeitnow.com/api/job-board-api`
- `jobicy.json`: `https://jobicy.com/api/v2/remote-jobs?count=1&industry=dev`
- `hn.json`: `https://hn.algolia.com/api/v1/items/44434576`

Each fixture keeps one real representative record with its source-native field names and types. Long descriptions and feed metadata are shortened so parser tests stay focused and deterministic.
