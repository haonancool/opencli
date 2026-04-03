# ZSXQ Handoff

Date: 2026-04-03

## Scope

This handoff covers the recent `opencli zsxq` changes focused on making `zsxq topics` the practical replacement for the degraded `zsxq topic` command.

## What Changed

- `zsxq topic` is now marked deprecated because the old single-topic endpoint is no longer reliable.
- `zsxq topics` default table output now includes `comment_preview`.
- Structured output from `zsxq topics` now preserves raw detail fields needed for topic-level reading:
  - `talk`
  - `show_comments`
  - `topic_uid`
  - `digested`
  - `sticky`
- The following fields were explicitly removed from `zsxq topics` structured output to keep it focused:
  - `latest_likes`
  - `likes_detail`
  - `user_specific`
- `content` now comes from the full body source such as `talk.text` instead of the truncated `title`.
- `title` remains the summary/title field.

## Key Files

- `src/clis/zsxq/topics.ts`
- `src/clis/zsxq/topic.ts`
- `src/clis/zsxq/utils.ts`
- `src/clis/zsxq/topics.test.ts`
- `src/clis/zsxq/topic.test.ts`
- `docs/adapters/browser/zsxq.md`

## Verified Commands

Adapter tests:

```bash
npm run test:adapter -- src/clis/zsxq/topics.test.ts src/clis/zsxq/topic.test.ts
```

Typecheck:

```bash
npm run typecheck
```

Live verification used during this session:

```bash
npm run dev -- zsxq topics --group_id 48888448251158 --limit 1
npm run dev -- zsxq topics --group_id 48888448251158 --limit 1 -f json
```

## Last Verified Live Shape

The live JSON output from `zsxq topics --group_id 48888448251158 --limit 1 -f json` contained:

- `topic_id`
- `topic_uid`
- `type`
- `group`
- `author`
- `title`
- `content`
- `comments`
- `likes`
- `readers`
- `time`
- `comment_preview`
- `talk`
- `show_comments`
- `digested`
- `sticky`
- `url`

Notably:

- `title` was truncated summary text
- `content` was full `talk.text`

## Current State

The current local commit for the ZSXQ work is:

```text
5554066 Refine zsxq topics detail output
```

This commit has already been pushed to:

```text
git@github.com:haonancool/opencli.git
branch: main
```

## Next Good Follow-Ups

- Decide whether `zsxq topic` should remain as deprecated compatibility or be changed to a guidance/error-only command.
- Consider whether `comments_raw` is still needed in `toTopicRow`; it is currently preserved only when present on input.
- If table-mode readability matters more, consider adding `content` as an optional/default column for `zsxq topics`.

