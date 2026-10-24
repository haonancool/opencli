/**
 * Weibo post — get a single post by ID.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { classifyPostType, requireObjectEvaluateResult, unwrapEvaluateResult } from './utils.js';
cli({
    site: 'weibo',
    name: 'post',
    access: 'read',
    description: 'Get a single Weibo post with image, video, and live replay URLs',
    domain: 'weibo.com',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'id', required: true, positional: true, help: 'Post ID (numeric idstr or mblogid from URL)' },
    ],
    columns: ['field', 'value'],
    func: async (page, kwargs) => {
        await page.goto('https://weibo.com');
        await page.wait(2);
        const id = String(kwargs.id);
        // PAGE_FETCH (internal API): keep the existing same-origin, logged-in
        // statuses/show request. Its media URLs are not exposed by post text DOM.
        // Verified against image, video and live replay posts from the same user.
        const data = requireObjectEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const id = ${JSON.stringify(id)};
        const postType = (${classifyPostType.toString()});
        const strip = (html) => (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
        const httpUrl = (value) => {
          if (typeof value !== 'string') return '';
          const url = value.startsWith('//') ? 'https:' + value : value;
          return /^https?:\\/\\//i.test(url) ? url : '';
        };
        const isHls = (url) => /\\.m3u8(?:[?#]|$)/i.test(url);
        const firstUrl = (values) => values.map(httpUrl).find(Boolean) || '';
        const formatLiveTime = (raw, multiplier) => {
          if (typeof raw !== 'number' && typeof raw !== 'string') return null;
          const timestamp = Number(raw);
          if (!Number.isInteger(timestamp) || timestamp <= 0) return null;
          const local = new Date(timestamp * multiplier + 8 * 60 * 60 * 1000);
          return Number.isFinite(local.getTime()) ? local.toISOString().replace('.000Z', 'Z').replace('Z', '+08:00') : null;
        };
        // The live page's same-origin room endpoint provides endTime in
        // milliseconds, which is absent from statuses/show. Share duplicate reads
        // when the outer post and its retweeted status refer to the same room.
        const liveRooms = new Map();
        async function readLiveRoom(liveId) {
          if (!liveRooms.has(liveId)) {
            liveRooms.set(liveId, (async () => {
              try {
                const response = await fetch('/l/!/2/wblive/room/show_pc_live.json?live_id=' + encodeURIComponent(liveId), {credentials: 'include'});
                if (!response.ok) return {error: 'Weibo live room request failed: HTTP ' + response.status};
                const room = await response.json();
                if (room.code !== 100000 || room.error_code) {
                  return {error: 'Weibo live room API error: ' + (room.msg || room.error_code || room.code)};
                }
                if (!room.data || room.data.liveId !== liveId) {
                  return {error: 'Weibo live room response did not match the requested live ID'};
                }
                return room;
              } catch (error) {
                return {error: 'Weibo live room request failed: ' + String(error.message || error)};
              }
            })());
          }
          return liveRooms.get(liveId);
        }

        async function mediaFields(status) {
          const infos = status.pic_infos || {};
          // pic_infos keys can be in a different order from the displayed photos.
          const ids = status.pic_ids?.length ? status.pic_ids : Object.keys(infos);
          const pictures = ids.map(id => {
            const pic = infos[id] || {};
            return firstUrl([pic.largest?.url, pic.original?.url, pic.large?.url,
              pic.bmiddle?.url, pic.thumbnail?.url]);
          }).filter(Boolean);

          const info = status.page_info || {};
          const media = info.media_info || {};
          const playback = (Array.isArray(media.playback_list) ? media.playback_list : [])
            .filter(item => {
              const play = item.play_info || {};
              const url = httpUrl(play.url);
              // playback_list also contains scrubber JPEGs and may contain audio.
              return url && !/^(image|audio)\\//i.test(play.mime || '')
                && (/^video\\/|mpegurl/i.test(play.mime || '') || /\\.(mp4|m3u8)(?:[?#]|$)/i.test(url));
            })
            .sort((a, b) => Number(b.meta?.quality_index || b.play_info?.height || 0)
              - Number(a.meta?.quality_index || a.play_info?.height || 0));
          const isLive = info.object_type === 'live' || Boolean(media.live_id);
          const video = isLive ? '' : firstUrl([
            ...playback.map(item => item.play_info.url),
            media.stream_url_hd, media.mp4_720p_mp4, media.mp4_hd_url,
            media.stream_url, media.mp4_sd_url,
          ]);
          const isVideo = !isLive && (info.object_type === 'video' || media.media_type === 'video' || Boolean(video));
          // The TV page's main heading matches page_title/media.name. content2,
          // kol_title and next_title describe the video and can differ from it.
          const videoTitle = isVideo
            ? strip(info.page_title || '') || strip(media.name || '') || strip(info.content1 || '')
            : '';
          // A live stream_url may point to room/play (JSON), not a playlist.
          const hls = firstUrl([
            media.replay_hd, media.replay_ld, media.live_hd, media.live_ld,
            ...playback.map(item => item.play_info.url),
            media.stream_url_hd, media.stream_url,
          ].map(httpUrl).filter(isHls));
          // page_title is the generic "<author>'s live broadcast" card label.
          // The actual room title is in page_desc (content2 on older cards).
          const liveTitle = isLive ? strip(info.page_desc || '') || strip(info.content2 || '') : '';
          // real_status can be 0 for a scheduled broadcast whose card status is 9.
          // Use nullish fallback so that 0 remains a valid state.
          const liveState = String(media.real_status ?? media.live_status ?? info.status ?? '');
          const liveStatus = isLive
            ? new Map([['0', '未开播'], ['9', '未开播'], ['1', '直播中'], ['3', '直播结束']]).get(liveState) ?? null
            : '';
          // Card start time uses seconds and may be scheduled for upcoming rooms.
          const liveStartTime = isLive ? formatLiveTime(media.live_start_time, 1000) : '';
          let liveEndTime = isLive ? null : '';
          const liveId = media.live_id || (isLive ? info.object_id : '');
          if (isLive && liveId) {
            const room = await readLiveRoom(String(liveId));
            if (room.error) return room;
            liveEndTime = formatLiveTime(room.data.endTime, 1);
          }
          return { pic_urls: [...new Set(pictures)], video_url: video, video_title: videoTitle, live_url: hls,
            live_title: liveTitle, live_status: liveStatus, live_start_time: liveStartTime,
            live_end_time: liveEndTime };
        }

        const resp = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(id), {credentials: 'include'});
        if (!resp.ok) return {error: 'HTTP ' + resp.status};
        const s = await resp.json();
        if (!s.ok && !s.idstr) return {error: 'Post not found'};

        // Fetch long text if needed
        let fullText = s.text_raw || strip(s.text || '');
        if (s.isLongText || s.is_long_text) {
          try {
            const ltResp = await fetch('/ajax/statuses/longtext?id=' + s.idstr, {credentials: 'include'});
            if (ltResp.ok) {
              const lt = await ltResp.json();
              if (lt.data?.longTextContent) fullText = strip(lt.data.longTextContent);
            }
          } catch {}
        }

        const u = s.user || {};
        const media = await mediaFields(s);
        if (media.error) return media;
        const result = {
          id: s.idstr || String(s.id),
          mblogid: s.mblogid,
          type: postType(s),
          author: u.screen_name || '',
          text: fullText,
          created_at: s.created_at,
          source: strip(s.source || ''),
          reposts: s.reposts_count || 0,
          comments: s.comments_count || 0,
          likes: s.attitudes_count || 0,
          pic_count: s.pic_num || 0,
          ...media,
          url: 'https://weibo.com/' + (u.id || '') + '/' + (s.mblogid || ''),
        };

        if (s.retweeted_status) {
          const rt = s.retweeted_status;
          result.retweeted_from = (rt.user?.screen_name || '[deleted]');
          result.retweeted_text = rt.text_raw || strip(rt.text || '');
          result.retweeted_type = postType(rt);
          const retweetedMedia = await mediaFields(rt);
          if (retweetedMedia.error) return retweetedMedia;
          for (const [key, value] of Object.entries(retweetedMedia)) {
            result['retweeted_' + key] = value;
          }
        }

        return result;
      })()
    `)), 'weibo post');
        if (data.error)
            throw new CommandExecutionError(String(data.error));
        return Object.entries(data).map(([field, value]) => ({
            field,
            value: value === null ? null : Array.isArray(value) ? JSON.stringify(value) : String(value),
        }));
    },
});
