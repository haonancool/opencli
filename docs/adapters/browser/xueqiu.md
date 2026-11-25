# Xueqiu (雪球)

**Mode**: 🔐 Browser · **Domain**: `xueqiu.com` / `danjuanfunds.com`

## Commands

| Command | Description |
|---------|-------------|
| `opencli xueqiu feed` | 获取雪球首页时间线 |
| `opencli xueqiu earnings-date` | 获取股票预计财报发布日期 |
| `opencli xueqiu hot-stock` | 获取雪球热门股票榜 |
| `opencli xueqiu hot` | 获取雪球热门动态 |
| `opencli xueqiu search` | 搜索雪球股票（代码或名称） |
| `opencli xueqiu user` | 获取指定博主（用户）的帖子时间线 |
| `opencli xueqiu post` | 获取单条帖子正文、评论和楼中楼回复 |
| `opencli xueqiu stock` | 获取雪球股票实时行情 |
| `opencli xueqiu comments` | 获取单只股票的讨论动态（按时间排序） |
| `opencli xueqiu watchlist` | 获取雪球自选股列表 |
| `opencli xueqiu fund-holdings` | 获取蛋卷基金持仓明细（可用 `--account` 按子账户过滤） |
| `opencli xueqiu fund-snapshot` | 获取蛋卷基金快照（总资产、子账户、持仓，推荐 `-f json`） |

## Usage Examples

```bash
# Quick start
opencli xueqiu feed --limit 5

# Search stocks
opencli xueqiu search 茅台

# View one stock
opencli xueqiu stock SH600519

# View recent discussions for one stock
opencli xueqiu comments SH600519 --limit 5

# Read one blogger's timeline (screen name, numeric user_id, or profile URL)
# Each post includes a comment_preview by default (20 comments)
opencli xueqiu user 但斌 --limit 5
opencli xueqiu user 1102105103 --limit 5
opencli xueqiu user https://xueqiu.com/u/1102105103 --limit 5

# Skip comments, or cap how many comments to embed
opencli xueqiu user 但斌 --limit 5 --comment_limit 0
opencli xueqiu user 但斌 --limit 5 --comment_limit 3

# Start from a later timeline page (20 posts per page)
opencli xueqiu user 但斌 --page 2 --limit 20

# Read one post (--user is required for both status ids and full URLs)
opencli xueqiu post 99380989 --user 9089343523
opencli xueqiu post https://xueqiu.com/9089343523/99380989 --user 9089343523 --comment_limit 20
opencli xueqiu post 99380989 --user 9089343523 --comment_limit 0

# Upcoming earnings dates
opencli xueqiu earnings-date SH600519 --next

# Danjuan all holdings
opencli xueqiu fund-holdings

# Filter one Danjuan sub-account
opencli xueqiu fund-holdings --account 默认账户

# Full Danjuan snapshot as JSON
opencli xueqiu fund-snapshot -f json

# JSON output
opencli xueqiu feed -f json

# Verbose mode
opencli xueqiu feed -v
```

## Prerequisites

- Chrome running and **logged into** `xueqiu.com`
- For fund commands, Chrome must also be logged into `danjuanfunds.com` and able to open `https://danjuanfunds.com/my-money`
- [Browser Bridge extension](/guide/browser-bridge) installed

## Notes

- `fund-holdings` exposes both market value and share fields (`volume`, `usableRemainShare`)
- `fund-snapshot -f json` is the easiest way to persist a full account snapshot for later analysis or diffing
- `comments` returns stock-scoped discussion posts from the symbol page, not reply threads under one parent post
- `user` accepts a screen name (resolved via user search, exact match preferred), a numeric `user_id`, or a profile URL (`https://xueqiu.com/u/<user_id>`); the first row may be a pinned post, and reposts show the blogger's own comment
- `user --page N` starts from Xueqiu's 1-based timeline page (20 posts per page) and still collects up to `--limit` items from that page onward
- `user --comment_limit N` (max 20, default 20) fetches the first N comments per post and embeds them as a `comment_preview` column (`author -> repliee: text | ...`); pass `--comment_limit 0` to skip comments. It costs one extra request per post and stops with a warning if the site starts rejecting comment fetches
- `post` requires `--user <author_user_id>` for both numeric status IDs and full post URLs. It must be numeric and must match the author in a supplied URL. Missing or invalid values fail before navigation. The command always loads the normal detail page and reads its JSON `SNOWMAN_STATUS` assignment after checking the post identity and visible article; it never calls the legacy `statuses/show.json` detail API. Use it only for content the current account can normally view.
- A detail 403 stops the command before comments; it never retries or switches paths. HTTP 403 alone cannot distinguish a permission restriction, browser risk control, or expired login. Check the site's message in the existing logged-in browser before another attempt; reauthenticate or complete verification only if the site requests it.
- `post` returns the post first (`type=post`), followed by each top-level comment and its nested replies (`type=comment`). A nested reply's `parent_id` identifies its top-level comment. `reply_to` gives the reply target's name, falling back to the top-level comment's author. On comment rows, `replies` is the nested reply count.
- `post --comment_limit N` selects up to N top-level comments (default and max 800). Their nested replies load by default and are included in addition to those N rows. Set `--comment_limit 0` to fetch only the post. The site can filter what it exposes, so the returned rows may differ from the post's `replies` count.
- `user` and `post` wait six seconds before every API read, including timeline pages, post details, top-level comments, and nested reply pages. Run one command at a time when reading a batch to maintain this spacing across commands. The default command timeout is 900 seconds. Use `--timeout` for larger reads. If a nested reply request stops, `post` reports the parent comment and response type in stderr.
- If `user` or `post` encounters a login requirement, browser verification, HTTP 403, or HTTP 429 after fetching posts, it stops fetching and returns the data it already has. Check stderr for the stop reason before treating the output as complete. For browser verification, open Xueqiu in Chrome and complete the site's prompt. For HTTP 429, wait for the rate limit to clear before running the command again.
- If the commands return empty data, first confirm the logged-in browser can directly see the Danjuan asset page
