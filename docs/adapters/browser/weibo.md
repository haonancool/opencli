# Weibo (微博)

**Mode**: 🔐 Browser · **Domain**: `weibo.com`

## Commands

| Command | Description |
|---------|-------------|
| `opencli weibo hot` | 微博热搜 |
| `opencli weibo search` | Search Weibo posts by keyword |
| `opencli weibo feed` | 首页时间线（`for-you` / `following`） |
| `opencli weibo user` | 用户信息 |
| `opencli weibo user-posts` | 按用户列出微博，可选日期范围 |
| `opencli weibo me` | 我的信息 |
| `opencli weibo post` | 读取单条微博 |
| `opencli weibo favorites` | 我的微博收藏列表 |
| `opencli weibo publish` | 通过网页 UI 直接发布微博，支持最多 9 张图片 |
| `opencli weibo delete` | 删除登录账号自己的单条微博 |
| `opencli weibo comments` | 微博评论 |

## Usage Examples

```bash
# Quick start
opencli weibo hot --limit 5

# JSON output
opencli weibo hot -f json

# Search
opencli weibo search "OpenAI" --limit 5

# Home timeline (default: for-you / 推荐流)
opencli weibo feed --limit 10

# Following-only timeline (strict chronological following feed)
opencli weibo feed --type following --limit 10

# Read a post, including image/video/live replay URLs
opencli weibo post <id>
opencli weibo post <id> -f json

# List a user's posts by uid or screen name
opencli weibo user-posts 1670458304 --start 2025-06-01 --end 2025-06-02 --limit 20

# Filter by the same type labels returned in the listing
opencli weibo user-posts 5628009214 --type 图文 --limit 10
opencli weibo user-posts 5628009214 --type 视频 --limit 5
opencli weibo user-posts 5628009214 --type 直播 --start 2026-10-01 --end 2026-10-24 --limit 10

# Verbose mode
opencli weibo hot -v

# Favorites
opencli weibo favorites --limit 20

# Publish text (executes immediately)
opencli weibo publish "Hello from OpenCLI"

# Publish text with images (executes immediately)
opencli weibo publish "Hello with images" --images /path/a.jpg,/path/b.png

# Delete one of your own posts (executes immediately)
opencli weibo delete <id>
```

## Listing Columns

`feed`, `search`, and `user-posts` expose `id` for post rows. Pass that value
directly to `opencli weibo post <id>`. `hot` rows are search topics, not post
rows.

`user-posts` also includes a `type` column: `文字` for ordinary text posts,
`图文` for posts with images, `视频`, `直播` (including scheduled broadcasts and
replays), or `文章` for headline articles. Video/live/article cards take
precedence over their cover images. When a retweet has no media of its own,
its type follows the original post. Classification uses listing metadata and
does not request each post's details.

Use `--type 文字|图文|视频|直播|文章` to filter by these labels; the default
`--type 全部` leaves the listing unfiltered. Type filtering combines with the
date range and `--include-retweets`, and `--limit` counts matching posts. The
command continues across nonmatching pages until the requested count or the
end of the listing. Filtered searches scan up to 100 API pages; hitting that
cap produces an error instead of a partial result. Narrow the date range or
lower `--limit` in that case. A completed search with no matches reports an
empty result.

## Post Media

`post` keeps its `field` / `value` output and adds these fields:

| Field | Value |
|-------|-------|
| `type` | `文字`, `图文`, `视频`, `直播`, or `文章`, using the same classification rules as `user-posts` |
| `pic_urls` | JSON-encoded array of image URLs in display order, preferring the largest available size; `[]` for no images |
| `video_url` | Highest-quality available video playback URL, falling back to legacy stream fields; empty when unavailable |
| `video_title` | Video page's main heading, from the card's `page_title`, falling back to `media_info.name` / `content1`; empty when unavailable or not a video post |
| `live_url` | Direct HLS playlist URL, preferring HD live replay over lower-quality replay/live streams; empty when unavailable |
| `live_title` | Live room title from the card description, falling back to its secondary text; empty when unavailable or not a live post |
| `live_status` | `未开播`, `直播中`, or `直播结束`; `null` for missing/unrecognized live states, empty for non-live posts |
| `live_start_time` | Platform-reported start time in ISO 8601 with UTC+08:00 offset, e.g. `2026-10-18T20:00:34+08:00`; scheduled time for upcoming broadcasts, `null` when unavailable, empty for non-live posts |
| `live_end_time` | Platform-reported room end time in ISO 8601 with UTC+08:00 offset, e.g. `2026-10-18T20:50:50+08:00`; `null` when not ended or unavailable, empty for non-live posts |

For retweets, the original post's media appears separately as
`retweeted_type`, `retweeted_pic_urls`, `retweeted_video_url`, `retweeted_video_title`, `retweeted_live_url`, `retweeted_live_title`, `retweeted_live_status`, `retweeted_live_start_time`, and `retweeted_live_end_time`.
Live posts also query the room metadata endpoint for its end timestamp; failed
room requests produce a command error instead of silently returning a missing time.
`live_url` replaces the previous `m3u8_url` field (including the `retweeted_` variant).
Video covers and scrubber thumbnails are excluded from image/video links.
Upcoming broadcasts may have no playlist yet. Media links can expire; rerun
`post` to obtain fresh URLs.

## Prerequisites

- Chrome running and **logged into** weibo.com
- [Browser Bridge extension](/guide/browser-bridge) installed
