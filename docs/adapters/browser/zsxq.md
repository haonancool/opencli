# 知识星球 (ZSXQ)

**Mode**: 🔐 Browser · **Domain**: `wx.zsxq.com`

Read groups, topics, search results, dynamics, single-topic details, and attached files from [知识星球](https://wx.zsxq.com) using your logged-in Chrome session.

## Commands

| Command | Description |
|---------|-------------|
| `opencli zsxq groups` | List the groups your account has joined |
| `opencli zsxq topics` | List topics in the active group |
| `opencli zsxq topic <id>` | Fetch a single topic with comments |
| `opencli zsxq download <file_id>` | Download an attached file by file ID |
| `opencli zsxq search <keyword>` | Search topics inside a group |
| `opencli zsxq dynamics` | List recent dynamics across groups |

## Usage Examples

```bash
# List your groups
opencli zsxq groups

# List topics from the active group in Chrome
opencli zsxq topics --count 20

# Filter topics by scope and time range (either time boundary may be omitted)
opencli zsxq topics --scope with_files --begin_time "2026-08-06T12:40:04.266+0800" --end_time "2026-08-06T21:40:04.266+0800"

# Download an attachment using the file_id and name returned by topics
opencli zsxq download 181288214421242 --name "report.pdf" --output ./zsxq-downloads

# Search inside the active group
opencli zsxq search "opencli"

# Search inside a specific group explicitly
opencli zsxq search "opencli" --group_id 123456789

# Export a single topic with comments
opencli zsxq topic 987654321 --comment_limit 20

# Read recent dynamics across all joined groups
opencli zsxq dynamics --limit 20
```

## Prerequisites

- Chrome running and **logged into** [wx.zsxq.com](https://wx.zsxq.com)
- [Browser Bridge extension](/guide/browser-bridge) installed

## Notes

- `zsxq topics` and `zsxq search` use the current active group context from Chrome by default
- `zsxq topics --scope` accepts `all`, `digests`, `by_owner`, `questions`, `with_files`, and `with_images`
- Topic JSON/YAML output includes a structured `files` list with each attachment's `file_id` and `name`; table output shows the same data in `file_preview`
- `--limit` remains available as a deprecated compatibility alias for `zsxq topics --count`
- If there is no active group context, pass `--group_id <id>` or open the target group in Chrome first
- `zsxq groups` returns `group_id`, which you can reuse with `--group_id`
- `zsxq topic` surfaces a missing topic as `NOT_FOUND` instead of a generic fetch error
