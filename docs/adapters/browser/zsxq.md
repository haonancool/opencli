# 知识星球 (ZSXQ)

**Mode**: 🔐 Browser · **Domain**: `wx.zsxq.com`

Read groups, topics, search results, dynamics, single-topic details, and attached files from [知识星球](https://wx.zsxq.com) using your logged-in Chrome session.

## Commands

| Command | Description |
|---------|-------------|
| `opencli zsxq groups` | List the groups your account has joined |
| `opencli zsxq topics` | List topics in the active group |
| `opencli zsxq topic <topic_uid>` | Fetch a single topic with comments |
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

# Download an attachment into the current directory; its name comes from the URL's attname
opencli zsxq download 181288214421242

# Optionally choose another directory or override the filename
opencli zsxq download 181288214421242 --name "report.pdf" --output ./zsxq-downloads

# Search inside the active group
opencli zsxq search "opencli"

# Search inside a specific group explicitly
opencli zsxq search "opencli" --group_id 123456789

# Export a single topic with comments (prefer topic_uid from `zsxq topics`)
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
- Topic JSON/YAML output includes a structured `files` list with each attachment's `file_id` and `name`
- Q&A topics expose separate `question` and `answer` fields instead of a `content` field
- `question`, `answer`, and `content` preserve the API's original newlines and other whitespace characters
- Topic output keeps `comments` as the comment count, uses `comment_preview` for readable text, and nests replies under each `comment_items[].replies` array
- `zsxq topics` embeds only the API's comment preview (about 8 per topic); run `zsxq topic <topic_uid>` for the complete comment tree
- `zsxq download` saves to the current directory by default and URL-decodes the download URL's `attname` as the filename
- API requests include the official web client's signed `X-Request-Id`, `X-Version`, `X-Signature`, `X-Timestamp`, and `X-Aduid` headers; API code `1059` means the signature check failed
- `--limit` remains available as a deprecated compatibility alias for `zsxq topics --count`
- `zsxq topics --count` is capped at 30 (the ZSXQ list API returns code `14001` above that); page with `--begin_time` / `--end_time` for more results
- `zsxq topic --comment_limit` is capped at 30 (the comments API returns code `17801` above that)
- If there is no active group context, pass `--group_id <id>` or open the target group in Chrome first
- `zsxq groups` returns `group_id`, which you can reuse with `--group_id`
- `zsxq topic` looks up topics via `/v2/topics/{id}/info` and does **not** need a group context; the `--group_id` flag is deprecated and ignored. The endpoint resolves by `topic_uid`. `zsxq topics` now prints `topic_uid`; if you pass the listed `topic_id` instead, the command retries the adjacent uid automatically
- `zsxq topic` surfaces a missing topic as `NOT_FOUND` instead of a generic fetch error
- All zsxq API calls carry the web app's fingerprint headers (`X-Request-Id/X-Version/X-Signature/X-Timestamp/X-Aduid`) to pass the anti-tool risk control that answers non-official requests with API code `1059` 不支持非官方工具访问; the signature is `sha1("<url> <unixSeconds> <requestId>")` and the `X-Version` constants track the web app release
