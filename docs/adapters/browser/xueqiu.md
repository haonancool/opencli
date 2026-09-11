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
| `opencli xueqiu post` | 获取单条帖子正文和评论 |
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

# Read one post with its comments (status id or URL)
opencli xueqiu post 99380989
opencli xueqiu post https://xueqiu.com/9089343523/99380989 --comment_limit 20
opencli xueqiu post 99380989 --comment_limit 0

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
- `post` returns the post as the first row (`type=post`) and each comment as a following row (`type=comment`); `--comment_limit` defaults to 800 and `0` skips comments. Xueqiu's public comment stream is a filtered subset of `replies` (commonly capped around 150), so the command returns every comment the API exposes, not necessarily the raw `replies` count
- If the commands return empty data, first confirm the logged-in browser can directly see the Danjuan asset page
