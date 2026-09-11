import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { isRecord } from '@jackwener/opencli/utils';

const CHINA_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

/** Format a Unix ms timestamp as the matching `YYYY-MM-DD` in Asia/Shanghai (xueqiu's canonical user timezone for all markets). */
export function formatChinaDate(ts) {
    if (ts == null) return null;
    const parts = Object.fromEntries(
        CHINA_DATE_FORMATTER.formatToParts(new Date(ts))
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
}

export function stripHtml(html) {
    return (html || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
}

/**
 * Fetch a xueqiu JSON API from inside the browser context (credentials included).
 * Page must already be navigated to xueqiu.com before calling this function.
 * Throws CliError on HTTP errors; otherwise returns the parsed JSON.
 */
export async function fetchXueqiuJson(page, url) {
    const result = await page.evaluate(`(async () => {
    const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    if (!res.ok) return { __xqErr: res.status };
    try {
      return await res.json();
    } catch {
      return { __xqErr: 'parse' };
    }
  })()`);
    const r = result;
    if (r?.__xqErr !== undefined) {
        const code = r.__xqErr;
        if (code === 401 || code === 403) {
            throw new AuthRequiredError('xueqiu.com', '未登录或登录已过期');
        }
        if (code === 'parse') {
            throw new CommandExecutionError('响应不是有效 JSON', '可能触发了风控，请检查登录状态或稍后重试');
        }
        throw new CommandExecutionError(`HTTP ${code}`, '请检查网络连接或登录状态');
    }
    return result;
}

/**
 * Fetch a xueqiu JSON API from inside the browser and return a classified
 * envelope (status / contentType / json / textSnippet) instead of throwing.
 *
 * Use this when the caller needs to distinguish auth, anti-bot, empty, and
 * incompatible payloads. Page must already be navigated to xueqiu.com.
 *
 * @param page Active browser page.
 * @param url Absolute xueqiu API URL.
 * @returns Structured response for command-side classification.
 */
export async function fetchXueqiuEnvelope(page, url) {
    return page.evaluate(`
    (async () => {
      try {
        const response = await fetch(${JSON.stringify(url)}, {
          credentials: 'include',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'x-requested-with': 'XMLHttpRequest',
          },
          referrerPolicy: 'strict-origin-when-cross-origin',
        });
        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();
        let json = null;
        if (contentType.includes('application/json')) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
        return {
          status: response.status,
          contentType,
          json,
          textSnippet: text.slice(0, 2000),
        };
      } catch (error) {
        return {
          status: 0,
          contentType: 'text/plain',
          json: null,
          textSnippet: error instanceof Error ? error.message : String(error),
        };
      }
    })()
  `);
}

export function isAntiBotHtml(response, envelopeText = '') {
    const htmlText = `${envelopeText} ${response.textSnippet}`.toLowerCase();
    return response.contentType.includes('text/html')
        && (/captcha|challenge|aliyun_waf|risk/i.test(htmlText)
            || /_WAF_|_waf_|renderData|aliyun_waf/i.test(response.textSnippet));
}

export function envelopeTextFromJson(jsonRecord) {
    if (!isRecord(jsonRecord))
        return '';
    return [
        jsonRecord.error_description,
        jsonRecord.error,
        jsonRecord.errors,
        jsonRecord.code,
        jsonRecord.message,
        jsonRecord.msg,
    ].filter(Boolean).join(' ').toLowerCase();
}

export function classifyBrowserAuthFailure(response, envelopeText = '') {
    if (isAntiBotHtml(response, envelopeText))
        return { kind: 'anti-bot' };
    if (response.status === 401 || response.status === 403)
        return { kind: 'auth' };
    const responseText = `${envelopeText} ${response.textSnippet}`.toLowerCase();
    if (/login required|unauthorized|unauthorised|forbidden|not logged in|need login/.test(responseText))
        return { kind: 'auth' };
    return null;
}

/**
 * Extract the raw comment list from one status-comments payload.
 *
 * @param json Raw parsed JSON payload from browser fetch.
 * @returns Comment items when the response shape is usable, otherwise null.
 */
export function getStatusCommentItems(json) {
    if (!isRecord(json))
        return null;
    if (Array.isArray(json.comments))
        return json.comments;
    return null;
}

/**
 * Classify one status-comments response.
 *
 * @param response Structured browser response payload.
 * @returns Tagged result describing the response class.
 */
export function classifyStatusCommentsResponse(response) {
    const jsonRecord = isRecord(response.json) ? response.json : null;
    const commentItems = jsonRecord ? getStatusCommentItems(jsonRecord) : null;
    const envelopeText = envelopeTextFromJson(jsonRecord);
    const authFailure = classifyBrowserAuthFailure(response, envelopeText);
    if (authFailure)
        return authFailure;
    if (commentItems !== null)
        return { kind: 'ok' };
    if (response.contentType.includes('application/json') && jsonRecord)
        return { kind: 'incompatible' };
    return { kind: 'unknown' };
}

export function toFiniteCount(value) {
    const count = Number(value ?? 0);
    return Number.isFinite(count) ? count : 0;
}

export function normalizeIdentifier(value) {
    if (typeof value === 'string')
        return value.trim();
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return '';
}

export function toIsoTimestamp(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/**
 * Collapse HTML from xueqiu post/comment bodies into a single-line plain string.
 *
 * Unlike `stripHtml`, this inserts spaces around tags so adjacent block
 * elements do not glue together, then collapses leftover whitespace.
 */
export function stripTags(html) {
    return String(html ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

export function statusUrl(userId, statusId) {
    return userId && statusId ? `https://xueqiu.com/${userId}/${statusId}` : null;
}
