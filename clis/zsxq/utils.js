import { ArgumentError, AuthRequiredError, CliError } from '@jackwener/opencli/errors';
const SITE_DOMAIN = 'wx.zsxq.com';
const SITE_URL = 'https://wx.zsxq.com';
// Keep these aligned with the official wx.zsxq.com web client. ZSXQ validates
// the signed request headers and returns API code 1059 when they are missing or
// invalid. Signature = sha1(`<absolute url> <unixSeconds> <requestId>`) — verified
// against the official bundle (chunk-DVTWFCE4.js) on 2026-09-09.
const ZSXQ_V2_X_VERSION = '2.96.0';
const ZSXQ_V3_X_VERSION = '3.22.0';
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function pickArray(...values) {
    for (const value of values) {
        if (Array.isArray(value)) {
            return value;
        }
    }
    return [];
}
export async function ensureZsxqPage(page) {
    await page.goto(SITE_URL);
}
export async function ensureZsxqAuth(page) {
    // zsxq uses httpOnly cookies that may be on different subdomains.
    // Verify auth by attempting a lightweight API call instead of checking cookies.
    try {
        const result = await browserJsonRequest(page, 'https://api.zsxq.com/v2/groups');
        const authenticated = result?.ok && result.data !== null;
        if (!authenticated) {
            throw new AuthRequiredError('zsxq.com');
        }
        return true;
    }
    catch (err) {
        if (err instanceof AuthRequiredError)
            throw err;
        throw new AuthRequiredError('zsxq.com');
    }
}
export async function getCookieValue(page, name) {
    const cookies = await page.getCookies({ domain: SITE_DOMAIN });
    return cookies.find(cookie => cookie.name === name)?.value;
}
export async function getActiveGroupId(page) {
    const groupId = await page.evaluate(`
    (() => {
      const target = localStorage.getItem('target_group');
      if (target) {
        try {
          const parsed = JSON.parse(target);
          if (parsed.group_id) return String(parsed.group_id);
        } catch {}
      }
      return null;
    })()
  `);
    if (groupId)
        return groupId;
    throw new ArgumentError('Cannot determine active group_id', 'Pass --group_id <id> or open the target 知识星球 page in Chrome first');
}
export async function browserJsonRequest(page, path) {
    return await page.evaluate(`
    (async () => {
      const path = ${JSON.stringify(path)};
      const v2Version = ${JSON.stringify(ZSXQ_V2_X_VERSION)};
      const v3Version = ${JSON.stringify(ZSXQ_V3_X_VERSION)};

      try {
        const requestId = (() => {
          let value = '';
          for (let index = 0; index < 32; index++) {
            value += Math.floor(Math.random() * 16).toString(16);
            if (index === 8 || index === 12 || index === 16 || index === 20) value += '-';
          }
          return value;
        })();
        const timestamp = Math.floor(Date.now() / 1000).toString();
        let aduid = localStorage.getItem('XAduid');
        if (!aduid) {
          aduid = requestId;
          localStorage.setItem('XAduid', aduid);
        }
        const parts = path.split('?');
        const canonicalPath = parts.length > 1
          ? parts[0] + '?' + parts.slice(1).join('?').replace(/'/g, '%27')
          : path;
        const signatureInput = canonicalPath + ' ' + timestamp + ' ' + requestId;
        const signatureBytes = await crypto.subtle.digest(
          'SHA-1',
          new TextEncoder().encode(signatureInput),
        );
        const signature = Array.from(new Uint8Array(signatureBytes))
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('');
        const version = path.includes('/v3/') ? v3Version : v2Version;

        return await new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', path, true);
          xhr.withCredentials = true;
          xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
          xhr.setRequestHeader('X-Request-Id', requestId);
          xhr.setRequestHeader('X-Version', version);
          xhr.setRequestHeader('X-Signature', signature);
          xhr.setRequestHeader('X-Timestamp', timestamp);
          xhr.setRequestHeader('X-Aduid', aduid);
          xhr.onload = () => {
            let parsed = null;
            if (xhr.responseText) {
              try { parsed = JSON.parse(xhr.responseText); }
              catch {}
            }

            resolve({
              ok: xhr.status >= 200 && xhr.status < 300,
              url: path,
              status: xhr.status,
              data: parsed,
              error: xhr.status >= 200 && xhr.status < 300 ? undefined : 'HTTP ' + xhr.status,
            });
          };
          xhr.onerror = () => resolve({
            ok: false,
            url: path,
            error: 'Network error',
          });
          xhr.send();
        });
      } catch (error) {
        return {
          ok: false,
          url: path,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()
  `);
}
export async function fetchFirstJson(page, paths) {
    let lastFailure = null;
    for (const path of paths) {
        const result = await browserJsonRequest(page, path);
        if (result.ok) {
            return result;
        }
        lastFailure = result;
    }
    if (!lastFailure) {
        throw new CliError('FETCH_ERROR', 'No candidate endpoint returned JSON', `Checked endpoints: ${paths.join(', ')}`);
    }
    throw new CliError('FETCH_ERROR', lastFailure.error || 'Failed to fetch ZSXQ API', `Checked endpoints: ${paths.join(', ')}`);
}
export function unwrapRespData(payload) {
    const record = asRecord(payload);
    if (!record) {
        throw new CliError('PARSE_ERROR', 'Invalid ZSXQ API response');
    }
    if (record.succeeded === false) {
        const code = typeof record.code === 'number' ? String(record.code) : 'API_ERROR';
        const message = typeof record.info === 'string'
            ? record.info
            : typeof record.error === 'string'
                ? record.error
                : 'ZSXQ API returned an error';
        throw new CliError(code, message);
    }
    return (record.resp_data ?? record.data ?? payload);
}
export function getTopicsFromResponse(payload) {
    const data = unwrapRespData(payload);
    if (Array.isArray(data))
        return data;
    return pickArray(data.topics, data.list, data.records, data.items, data.search_result);
}
export function getCommentsFromResponse(payload) {
    const data = unwrapRespData(payload);
    if (Array.isArray(data))
        return data;
    return pickArray(data.comments, data.list, data.items);
}
export function getGroupsFromResponse(payload) {
    const data = unwrapRespData(payload);
    if (Array.isArray(data))
        return data;
    return pickArray(data.groups, data.list, data.items);
}
export function getTopicFromResponse(payload) {
    const data = unwrapRespData(payload);
    if (Array.isArray(data))
        return data[0] ?? null;
    if (typeof data.topic_id === 'number' || typeof data.topic_id === 'string')
        return data;
    const record = asRecord(data);
    if (!record)
        return null;
    const topic = record.topic;
    return topic && typeof topic === 'object' ? topic : null;
}
export function getTopicAuthor(topic) {
    return (topic.owner?.name ||
        topic.talk?.owner?.name ||
        topic.question?.owner?.name ||
        topic.answer?.owner?.name ||
        topic.task?.owner?.name ||
        topic.solution?.owner?.name ||
        '');
}
export function getTopicText(topic) {
    const title = (topic.title || '').replace(/\s+/g, ' ').trim();
    return title || getTopicContent(topic).replace(/\s+/g, ' ').trim();
}
export function getTopicContent(topic) {
    const primary = [
        topic.talk?.text,
        topic.question?.text,
        topic.answer?.text,
        topic.task?.text,
        topic.solution?.text,
    ].find(value => typeof value === 'string' && value.trim());
    return primary || '';
}
function normalizeTopicText(value) {
    return typeof value === 'string' ? value : '';
}
export function getTopicFiles(topic) {
    const files = pickArray(topic.talk?.files);
    return files
        .map((entry) => {
        const file = asRecord(entry?.file) || asRecord(entry);
        if (!file)
            return null;
        const fileId = file.file_id;
        if (typeof fileId !== 'string' && typeof fileId !== 'number')
            return null;
        return {
            file_id: fileId,
            name: typeof file.name === 'string' ? file.name : '',
        };
    })
        .filter(Boolean);
}
export function getFileDownloadInfo(payload) {
    const data = unwrapRespData(payload);
    const record = asRecord(data);
    if (!record)
        throw new CliError('PARSE_ERROR', 'Invalid ZSXQ file download response');
    const file = asRecord(record.file);
    const downloadUrl = record.download_url ?? file?.download_url;
    if (typeof downloadUrl !== 'string' || !downloadUrl.trim()) {
        throw new CliError('PARSE_ERROR', 'Download URL not found in ZSXQ file response');
    }
    let parsed;
    try {
        parsed = new URL(downloadUrl);
    }
    catch {
        throw new CliError('PARSE_ERROR', 'Invalid download URL in ZSXQ file response');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new CliError('PARSE_ERROR', 'Unsupported download URL protocol in ZSXQ file response');
    }
    const name = record.name ?? file?.name;
    return {
        download_url: parsed.toString(),
        name: typeof name === 'string' ? name : '',
    };
}
export function getTopicUrl(topicId) {
    return topicId ? `${SITE_URL}/topic/${topicId}` : SITE_URL;
}
export function getTopicLookupIds(id) {
    const raw = String(id ?? '').trim();
    if (!raw)
        return [];
    const ids = [raw];
    if (/^\d+$/.test(raw)) {
        try {
            const n = BigInt(raw);
            ids.push(String(n + 1n), String(n - 1n));
        }
        catch {
            // keep the original id only
        }
    }
    return [...new Set(ids)];
}
export function summarizeComments(comments, limit = 3) {
    return comments
        .slice(0, limit)
        .map((comment) => {
        const author = comment.owner?.name || '匿名';
        const target = comment.repliee?.name ? ` -> ${comment.repliee.name}` : '';
        const text = (comment.text || '').replace(/\s+/g, ' ').trim();
        return `${author}${target}: ${text}`;
    })
        .join(' | ');
}
export function getTopicCommentItems(topic) {
    // the list endpoint returns a flat array (replies carry parent_comment_id),
    // while /v2/topics/{uid}/comments nests replies inside replied_comments
    const rawComments = pickArray(topic.comments, topic.show_comments);
    const comments = rawComments.flatMap((comment) => [
        comment,
        ...pickArray(comment.replied_comments),
    ]);
    const entries = comments.map((comment) => {
        const item = {
            comment_id: comment.comment_id ?? '',
            author: comment.owner?.name || '匿名',
            content: normalizeTopicText(comment.text),
            replies: [],
        };
        if (comment.repliee?.name)
            item.reply_to = comment.repliee.name;
        return {
            item,
            parentCommentId: comment.parent_comment_id ?? '',
        };
    });
    const byId = new Map(entries
        .filter(entry => entry.item.comment_id !== '')
        .map(entry => [String(entry.item.comment_id), entry.item]));
    const roots = [];
    for (const entry of entries) {
        const parent = entry.parentCommentId !== ''
            ? byId.get(String(entry.parentCommentId))
            : null;
        if (parent && parent !== entry.item)
            parent.replies.push(entry.item);
        else
            roots.push(entry.item);
    }
    return roots;
}
export function toTopicRow(topic) {
    const topicId = topic.topic_id ?? '';
    const comments = pickArray(topic.comments, topic.show_comments);
    const commentItems = getTopicCommentItems(topic);
    const files = getTopicFiles(topic);
    const isQuestionAnswer = topic.type === 'q&a';
    const topicUid = topic.topic_uid ?? '';
    return {
        topic_id: topicId,
        topic_uid: topicUid,
        type: topic.type || '',
        group: topic.group?.name || '',
        author: getTopicAuthor(topic),
        title: getTopicText(topic),
        ...(isQuestionAnswer
            ? {
                question: normalizeTopicText(topic.question?.text),
                answer: normalizeTopicText(topic.answer?.text),
                // for q&a the chain in getTopicAuthor stops at the asker, so surface both explicitly
                question_author: topic.question?.owner?.name || '',
                answer_author: topic.answer?.owner?.name || '',
            }
            : { content: getTopicContent(topic) }),
        comments: topic.comments_count ?? comments.length ?? 0,
        comment_items: commentItems,
        likes: topic.likes_count ?? 0,
        readers: topic.readers_count ?? topic.reading_count ?? 0,
        time: topic.create_time || '',
        files,
        comment_preview: summarizeComments(comments),
        url: getTopicUrl(topicUid || topicId),
    };
}
