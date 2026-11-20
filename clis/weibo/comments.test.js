import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './comments.js';

function mockPage(payload, status = 200) {
  const fetch = vi.fn().mockResolvedValue({
    ok: status === 200,
    status,
    json: async () => payload,
  });
  return {
    fetch,
    goto: vi.fn(),
    wait: vi.fn(),
    evaluate: vi.fn((script) => new Function('fetch', 'return (' + script + ')')(fetch)),
  };
}

describe('weibo comments', () => {
  const run = (page) => getRegistry().get('weibo/comments').func(page, { id: '123', limit: 20 });

  it('preserves reply previews under their parents with reply targets and ID deduplication', async () => {
    const firstReply = { idstr: '9007199254741001', text: '<b>One</b>', user: { screen_name: 'Alice' } };
    const page = mockPage({
      ok: 1,
      max_id: 99,
      data: [
        {
          idstr: '9007199254741000', text: 'First', total_number: 8, like_count: 5,
          comments: [
            firstReply,
            { ...firstReply, text: 'duplicate' },
            { id: 12, text: 'Two', reply_comment: firstReply },
            { idstr: '9007199254741000', text: 'parent repeated' },
          ],
        },
        { id: 20, text: 'Second', comments: [{ id: 21, text: 'Another thread' }] },
        { id: 30, text: 'Third', total_number: 2 },
        { id: 40, text: 'Fourth', comments: [] },
      ],
    });

    const rows = await run(page);

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      rank: 1, id: '9007199254741000', author: '', text: 'First', likes: 5, replies: 8, time: '',
    });
    expect(rows[0].reply_items).toMatchObject([
      { id: '9007199254741001', text: 'One', author: 'Alice' },
      { id: '12', text: 'Two', reply_to: 'Alice: One', reply_to_id: '9007199254741001' },
    ]);
    expect(rows[1]).toMatchObject({ rank: 2, id: '20', reply_items: [{ id: '21', text: 'Another thread' }] });
    expect(rows[2]).toMatchObject({ replies: 2, reply_items: [] });
    expect(rows[3]).toMatchObject({ replies: 0, reply_items: [] });
    expect(page.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, 429, 'HTTP 429'],
    [{ ok: 0, msg: 'unavailable', data: [{ id: 1 }] }, 200, 'API error: unavailable'],
  ])('surfaces an unsuccessful request without returning previews or retrying', async (payload, status, message) => {
    const page = mockPage(payload, status);
    await expect(run(page)).rejects.toThrow(message);
    expect(page.fetch).toHaveBeenCalledTimes(1);
  });
});
